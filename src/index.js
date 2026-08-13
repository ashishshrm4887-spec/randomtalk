import { DurableObject } from "cloudflare:workers";

const MAX_TEXT = 2000;
const MAX_REPORT = 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store"
    }
  });
}

function cleanText(value, max = MAX_TEXT) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizePrefs(raw) {
  const p = raw && typeof raw === "object" ? raw : {};

  return {
    gender: ["any", "male", "female", "other"].includes(p.gender)
      ? p.gender
      : "any",

    country: cleanText(p.country, 60) || "any",

    mode: p.mode === "video" ? "video" : "text"
  };
}

function compatible(a, b) {
  const genderOK =
    a.gender === "any" ||
    b.gender === "any" ||
    a.gender === b.gender;

  const countryOK =
    a.country.toLowerCase() === "any" ||
    b.country.toLowerCase() === "any" ||
    a.country.toLowerCase() === b.country.toLowerCase();

  const modeOK = a.mode === b.mode;

  return genderOK && countryOK && modeOK;
}

function send(ws, data) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
      return true;
    }
  } catch {}

  return false;
}


/* =========================================================
   WORKER
========================================================= */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /*
     * Health check
     */
    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "RandomTalk",
        time: Date.now()
      });
    }

    /*
     * WebSocket endpoint
     */
    if (url.pathname === "/ws") {
      if (
        request.headers.get("Upgrade")?.toLowerCase() !==
        "websocket"
      ) {
        return new Response(
          "WebSocket upgrade required",
          { status: 426 }
        );
      }

      const room = env.CHAT_ROOM.getByName("global");

      return room.fetch(request);
    }

    /*
     * Website
     */
    if (request.method === "GET") {
      return new Response(APP_HTML, {
        headers: {
          "content-type": "text/html; charset=UTF-8",
          "cache-control": "no-store"
        }
      });
    }

    return new Response("Not found", { status: 404 });
  }
};


/* =========================================================
   DURABLE OBJECT
========================================================= */

export class ChatRoom extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.env = env;
    this.sessions = new Map();

    /*
     * Restore WebSocket sessions after hibernation.
     */
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const data = ws.deserializeAttachment();

        if (data?.id) {
          this.sessions.set(data.id, {
            ws,
            id: data.id,
            prefs: normalizePrefs(data.prefs),
            partnerId: data.partnerId || null,
            waiting: !!data.waiting,
            createdAt: data.createdAt || Date.now()
          });
        }
      } catch {}
    }

    /*
     * Ping/pong handled by Cloudflare without waking
     * the Durable Object.
     */
    try {
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(
          "ping",
          "pong"
        )
      );
    } catch {}
  }


  async fetch(request) {

    if (
      request.headers.get("Upgrade")?.toLowerCase() !==
      "websocket"
    ) {
      return new Response(
        "Expected WebSocket",
        { status: 426 }
      );
    }

    const pair = new WebSocketPair();

    const [client, server] =
      Object.values(pair);

    const id = crypto.randomUUID();

    const session = {
      ws: server,
      id,
      prefs: normalizePrefs({}),
      partnerId: null,
      waiting: false,
      createdAt: Date.now()
    };

    /*
     * Hibernation WebSocket API.
     */
    this.ctx.acceptWebSocket(server);

    server.serializeAttachment({
      id,
      prefs: session.prefs,
      partnerId: null,
      waiting: false,
      createdAt: session.createdAt
    });

    this.sessions.set(id, session);

    send(server, {
      type: "hello",
      id,
      message: "Connected to RandomTalk"
    });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }


  findSession(ws) {

    for (const session of this.sessions.values()) {
      if (session.ws === ws) {
        return session;
      }
    }

    return null;
  }


  saveSession(session) {

    try {
      session.ws.serializeAttachment({
        id: session.id,
        prefs: session.prefs,
        partnerId: session.partnerId,
        waiting: session.waiting,
        createdAt: session.createdAt
      });
    } catch {}
  }


  async webSocketMessage(ws, message) {

    const session = this.findSession(ws);

    if (!session) {
      return;
    }

    let data;

    try {
      data = JSON.parse(
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message)
      );
    } catch {
      send(ws, {
        type: "error",
        message: "Invalid message."
      });

      return;
    }

    const type = String(data?.type || "");


    /* =========================
       PREFERENCES
    ========================= */

    if (type === "prefs") {

      session.prefs =
        normalizePrefs(data.prefs);

      this.saveSession(session);

      send(ws, {
        type: "prefs_ok",
        prefs: session.prefs
      });

      return;
    }


    /* =========================
       FIND
    ========================= */

    if (type === "find") {

      session.prefs =
        normalizePrefs(
          data.prefs || session.prefs
        );

      this.saveSession(session);

      await this.findPartner(session);

      return;
    }


    /* =========================
       NEXT
    ========================= */

    if (type === "next") {

      await this.endPair(
        session,
        "next"
      );

      await this.findPartner(session);

      return;
    }


    /* =========================
       END
    ========================= */

    if (type === "end") {

      await this.endPair(
        session,
        "ended"
      );

      return;
    }


    /* =========================
       REPORT
    ========================= */

    if (type === "report") {

      const reason =
        cleanText(
          data.reason,
          MAX_REPORT
        ) || "unspecified";

      await this.report(
        session,
        reason
      );

      return;
    }


    /* =========================
       WEBRTC SIGNALING
    ========================= */

    if (
      type === "offer" ||
      type === "answer" ||
      type === "candidate"
    ) {

      const partner =
        session.partnerId
          ? this.sessions.get(
              session.partnerId
            )
          : null;

      if (!partner) {

        send(ws, {
          type: "signal_error",
          message:
            "Partner is no longer connected."
        });

        return;
      }

      send(partner.ws, {
        type,
        from: session.id,
        data: data.data ?? null
      });

      return;
    }


    /* =========================
       TEXT CHAT
    ========================= */

    if (type === "chat") {

      const text =
        cleanText(data.text);

      if (!text) {
        return;
      }

      const partner =
        session.partnerId
          ? this.sessions.get(
              session.partnerId
            )
          : null;

      if (!partner) {
        return;
      }

      send(partner.ws, {
        type: "chat",
        text,
        from: "partner",
        at: Date.now()
      });

      return;
    }


    /* =========================
       TYPING
    ========================= */

    if (type === "typing") {

      const partner =
        session.partnerId
          ? this.sessions.get(
              session.partnerId
            )
          : null;

      if (partner) {
        send(partner.ws, {
          type: "typing",
          value: !!data.value
        });
      }

      return;
    }
  }


  async webSocketClose(ws) {

    const session =
      this.findSession(ws);

    if (!session) {
      return;
    }

    const partner =
      session.partnerId
        ? this.sessions.get(
            session.partnerId
          )
        : null;

    if (partner) {

      partner.partnerId = null;
      partner.waiting = false;

      this.saveSession(partner);

      send(partner.ws, {
        type: "partner_left",
        message:
          "Your partner disconnected."
      });
    }

    this.sessions.delete(
      session.id
    );
  }


  async findPartner(session) {

    if (session.partnerId) {
      return;
    }

    /*
     * Remove dead connections.
     */
    for (const [id, candidate]
      of this.sessions) {

      if (
        candidate.ws.readyState !==
        WebSocket.OPEN
      ) {
        this.sessions.delete(id);
      }
    }


    let best = null;
    let bestScore = -1;


    for (
      const candidate
      of this.sessions.values()
    ) {

      if (
        candidate.id === session.id
      ) {
        continue;
      }

      if (candidate.partnerId) {
        continue;
      }

      if (!candidate.waiting) {
        continue;
      }

      if (
        !compatible(
          session.prefs,
          candidate.prefs
        )
      ) {
        continue;
      }


      let score = 0;


      if (
        session.prefs.gender !== "any" &&
        session.prefs.gender ===
          candidate.prefs.gender
      ) {
        score += 2;
      }


      if (
        session.prefs.country !== "any" &&
        session.prefs.country.toLowerCase() ===
          candidate.prefs.country.toLowerCase()
      ) {
        score += 2;
      }


      if (
        session.prefs.mode ===
        candidate.prefs.mode
      ) {
        score += 1;
      }


      if (score > bestScore) {

        bestScore = score;
        best = candidate;
      }
    }


    /*
     * Nobody available.
     */
    if (!best) {

      session.waiting = true;

      this.saveSession(session);

      send(session.ws, {
        type: "searching",
        message:
          "Looking for someone..."
      });

      return;
    }


    /*
     * MATCH FOUND
     */

    session.waiting = false;
    best.waiting = false;

    session.partnerId = best.id;
    best.partnerId = session.id;

    this.saveSession(session);
    this.saveSession(best);

    const matchId =
      crypto.randomUUID();


    /*
     * Caller
     */
    send(session.ws, {
      type: "matched",
      role: "caller",
      matchId,
      mode: session.prefs.mode
    });


    /*
     * Callee
     */
    send(best.ws, {
      type: "matched",
      role: "callee",
      matchId,
      mode: best.prefs.mode
    });
  }


  async endPair(
    session,
    reason
  ) {

    const partner =
      session.partnerId
        ? this.sessions.get(
            session.partnerId
          )
        : null;


    session.partnerId = null;
    session.waiting = false;

    this.saveSession(session);


    if (partner) {

      partner.partnerId = null;
      partner.waiting = false;

      this.saveSession(partner);

      send(partner.ws, {
        type: "partner_left",
        reason,
        message:
          reason === "next"
            ? "Your partner moved to the next person."
            : "Chat ended."
      });
    }


    send(session.ws, {
      type: "ended",
      reason
    });
  }


  async report(
    session,
    reason
  ) {

    const record = {
      id: crypto.randomUUID(),
      reporter: session.id,
      partner: session.partnerId,
      reason,
      createdAt:
        new Date().toISOString()
    };


    /*
     * Store report privately.
     */
    await this.ctx.storage.put(
      "report:" + record.id,
      record
    );


    send(session.ws, {
      type: "reported",
      message:
        "Report submitted. Thank you."
    });


    /*
     * End reported chat.
     */
    if (session.partnerId) {

      const partner =
        this.sessions.get(
          session.partnerId
        );

      if (partner) {

        send(partner.ws, {
          type: "partner_left",
          reason: "report"
        });

        partner.partnerId = null;
        partner.waiting = false;

        this.saveSession(partner);
      }


      session.partnerId = null;
      session.waiting = false;

      this.saveSession(session);
    }
  }
}


/* =========================================================
   FRONT END
========================================================= */

const APP_HTML = `<!doctype html>

<html lang="en">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1,viewport-fit=cover"
>

<meta
  name="theme-color"
  content="#09071f"
>

<title>RandomTalk</title>

<style>

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  min-height: 100%;
}

body {
  background:
    radial-gradient(
      circle at 20% 0%,
      #24134d 0%,
      #09071f 48%
    );

  color: #ffffff;

  font-family:
    Inter,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

button,
input,
select {
  font: inherit;
}

button {
  cursor: pointer;
}

header {
  height: 70px;

  display: flex;
  align-items: center;
  justify-content: space-between;

  padding: 0 20px;

  border-bottom:
    1px solid #2d2a54;

  background:
    rgba(9,7,31,.94);

  position: sticky;
  top: 0;

  z-index: 20;
}

.logo {
  font-size: 25px;
  font-weight: 900;
}

.logo span {
  color: #b34af2;
}

main {
  max-width: 950px;

  margin: auto;

  padding:
    28px 16px 60px;
}

.hero {
  padding:
    25px 0 10px;
}

.hero h1 {
  margin: 0;

  font-size:
    clamp(45px, 9vw, 78px);

  line-height: .94;

  letter-spacing: -4px;
}

.hero h1 span {
  background:
    linear-gradient(
      90deg,
      #d946ef,
      #6366f1
    );

  -webkit-background-clip: text;

  color: transparent;
}

.hero p {
  color: #aaa8c6;

  max-width: 680px;

  font-size: 18px;

  line-height: 1.6;
}

.card {
  margin-top: 20px;

  padding: 18px;

  background:
    rgba(13,13,38,.94);

  border:
    1px solid #2d2a54;

  border-radius: 22px;

  box-shadow:
    0 20px 60px rgba(0,0,0,.25);
}

.tabs {
  display: grid;

  grid-template-columns:
    1fr 1fr;

  gap: 10px;
}

.tab {
  padding: 15px;

  border:
    1px solid #302d58;

  border-radius: 15px;

  background: transparent;

  color: #aaa8c6;

  font-weight: 800;
}

.tab.active {
  color: white;

  border-color: transparent;

  background:
    linear-gradient(
      90deg,
      #c83de9,
      #6366f1
    );
}

.grid {
  display: grid;

  grid-template-columns:
    1fr 1fr;

  gap: 12px;

  margin-top: 16px;
}

label {
  display: block;

  color: #aaa8c6;

  font-size: 13px;

  margin-bottom: 7px;
}

input,
select {
  width: 100%;

  padding: 13px;

  border:
    1px solid #302d58;

  border-radius: 13px;

  background: #08081a;

  color: white;

  outline: none;
}

.actions {
  display: flex;

  flex-wrap: wrap;

  gap: 9px;

  margin-top: 16px;
}

.btn {
  border: 0;

  border-radius: 13px;

  padding:
    13px 18px;

  font-weight: 850;

  color: white;

  background:
    linear-gradient(
      90deg,
      #c83de9,
      #6366f1
    );
}

.btn.secondary {
  background: #181735;

  border:
    1px solid #302d58;
}

.btn.danger {
  background: #3a1118;

  border:
    1px solid #70202a;

  color: #ffb5bc;
}

.btn:disabled {
  opacity: .45;

  cursor: not-allowed;
}

.status {
  min-height: 25px;

  margin-top: 14px;

  color: #aaa8c6;
}

.dot {
  width: 9px;

  height: 9px;

  display: inline-block;

  border-radius: 50%;

  background: #888;

  margin-right: 8px;
}

.dot.ok {
  background: #22c55e;
}

.dot.wait {
  background: #f59e0b;
}

.videos {
  display: grid;

  grid-template-columns:
    1fr 1fr;

  gap: 12px;
}

.videoBox {
  position: relative;

  overflow: hidden;

  background: #020208;

  border:
    1px solid #302d58;

  border-radius: 18px;

  aspect-ratio: 16 / 10;
}

.videoBox video {
  width: 100%;

  height: 100%;

  object-fit: cover;

  background: #020208;
}

.videoLabel {
  position: absolute;

  top: 10px;
  left: 10px;

  padding:
    6px 9px;

  border-radius: 8px;

  background:
    rgba(0,0,0,.65);

  font-size: 12px;
}

.chat {
  height: 320px;

  display: flex;

  flex-direction: column;
}

.messages {
  flex: 1;

  overflow-y: auto;

  padding: 5px;
}

.message {
  max-width: 80%;

  padding:
    10px 12px;

  margin:
    7px 0;

  border-radius: 14px;

  background: #19183b;
}

.message.me {
  margin-left: auto;

  background:
    linear-gradient(
      90deg,
      #7136bd,
      #4d52b8
    );
}

.message small {
  display: block;

  color: #c8c4df;

  margin-top: 3px;
}

.compose {
  display: flex;

  gap: 8px;

  margin-top: 10px;
}

.compose input {
  flex: 1;
}

.notice {
  color: #aaa8c6;

  line-height: 1.5;

  font-size: 13px;
}

.hidden {
  display: none !important;
}

footer {
  text-align: center;

  color: #77758f;

  font-size: 12px;

  margin-top: 25px;
}

@media (max-width: 700px) {

  .grid,
  .videos {
    grid-template-columns: 1fr;
  }

  .hero h1 {
    letter-spacing: -2px;
  }

  .videoBox {
    aspect-ratio: 4 / 3;
  }
}

</style>

</head>


<body>


<header>

<div class="logo">
Random<span>Talk</span>
</div>

<div>
Text & Video Chat
</div>

</header>


<main>


<section class="hero">

<h1>
Talk to<br>
someone <span>new.</span>
</h1>

<p>
Meet random people through text or video chat.
Choose your preferences and move to the next
person whenever you want.
</p>

</section>


<section class="card">


<div class="tabs">

<button
  id="textTab"
  class="tab active"
>
Text Chat
</button>

<button
  id="videoTab"
  class="tab"
>
Video Chat
</button>

</div>


<div class="grid">


<div>

<label>
Gender preference
</label>

<select id="gender">

<option value="any">
Anyone
</option>

<option value="male">
Male
</option>

<option value="female">
Female
</option>

<option value="other">
Other
</option>

</select>

</div>


<div>

<label>
Country preference
</label>

<input
  id="country"
  maxlength="60"
  placeholder="any"
>

</div>


</div>


<div class="actions">

<button
  id="findBtn"
  class="btn"
>
Start Chatting
</button>

<button
  id="nextBtn"
  class="btn secondary"
  disabled
>
Next
</button>

<button
  id="endBtn"
  class="btn danger"
  disabled
>
End
</button>

<button
  id="reportBtn"
  class="btn secondary"
  disabled
>
Report
</button>

</div>


<div
  id="status"
  class="status"
>
<span class="dot"></span>
Ready
</div>


</section>


<section
  id="videoCard"
  class="card hidden"
>


<div class="videos">


<div class="videoBox">

<video
  id="localVideo"
  autoplay
  muted
  playsinline
></video>

<div class="videoLabel">
You
</div>

</div>


<div class="videoBox">

<video
  id="remoteVideo"
  autoplay
  playsinline
></video>

<div class="videoLabel">
Stranger
</div>

</div>


</div>


<div class="actions">


<button
  id="camBtn"
  class="btn secondary"
>
Camera
</button>


<button
  id="micBtn"
  class="btn secondary"
>
Microphone
</button>


<button
  id="restartBtn"
  class="btn secondary"
>
Reconnect Video
</button>


</div>


</section>


<section
  id="chatCard"
  class="card hidden"
>


<div class="chat">


<div
  id="messages"
  class="messages"
>
</div>


<div class="compose">

<input
  id="chatInput"
  maxlength="2000"
  placeholder="Type a message..."
>

<button
  id="sendBtn"
  class="btn"
>
Send
</button>

</div>


</div>


</section>


<section class="card">

<div class="notice">

<strong>
Safety:
</strong>

Be respectful. Never share passwords,
bank information, exact addresses, or
other sensitive personal information.

</div>

</section>


<footer>
RandomTalk
</footer>


</main>


<script>

(() => {

"use strict";


/* =====================================================
   STATE
===================================================== */

let ws = null;

let mode = "text";

let myId = null;

let partnerConnected = false;

let role = null;

let peer = null;

let localStream = null;

let iceQueue = [];

let reconnectTimer = null;

let manualClose = false;


/* =====================================================
   HELPERS
===================================================== */

function $(id) {
  return document.getElementById(id);
}


function escapeHTML(value) {

  return String(value).replace(
    /[&<>"']/g,
    function(c) {

      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[c];

    }
  );
}


function setStatus(
  text,
  type = ""
) {

  $("status").innerHTML =
    '<span class="dot ' +
    type +
    '"></span>' +
    escapeHTML(text);
}


function getPrefs() {

  return {

    gender:
      $("gender").value,

    country:
      $("country").value.trim() ||
      "any",

    mode
  };
}


function websocketURL() {

  const protocol =
    location.protocol === "https:"
      ? "wss:"
      : "ws:";

  return (
    protocol +
    "//" +
    location.host +
    "/ws"
  );
}


/* =====================================================
   WEBSOCKET
===================================================== */

function connect() {

  manualClose = false;

  if (
    ws &&
    (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    )
  ) {
    return;
  }


  setStatus(
    "Connecting...",
    "wait"
  );


  ws = new WebSocket(
    websocketURL()
  );


  ws.onopen = () => {

    setStatus(
      "Connected.",
      "ok"
    );

    ws.send(
      JSON.stringify({
        type: "prefs",
        prefs: getPrefs()
      })
    );
  };


  ws.onmessage = async event => {

    let data;

    try {

      data =
        JSON.parse(event.data);

    } catch {

      return;
    }

    await handleServer(data);
  };


  ws.onerror = () => {

    setStatus(
      "Connection error. Retrying...",
      "wait"
    );
  };


  ws.onclose = () => {

    partnerConnected = false;

    if (!manualClose) {

      setStatus(
        "Disconnected. Reconnecting...",
        "wait"
      );

      clearTimeout(
        reconnectTimer
      );

      reconnectTimer =
        setTimeout(
          connect,
          1200
        );
    }
  };
}


/* =====================================================
   SERVER EVENTS
===================================================== */

async function handleServer(data) {

  switch (data.type) {


    case "hello":

      myId = data.id;

      break;


    case "searching":

      setStatus(
        "Looking for someone...",
        "wait"
      );

      setButtons(true);

      break;


    case "matched":

      partnerConnected = true;

      role = data.role;

      setStatus(
        "Connected to a stranger.",
        "ok"
      );

      setButtons(false);


      if (mode === "text") {

        $("chatCard")
          .classList
          .remove("hidden");

      }


      if (mode === "video") {

        $("videoCard")
          .classList
          .remove("hidden");

        await startVideo(
          role === "caller"
        );
      }

      break;


    case "chat":

      addMessage(
        data.text,
        false
      );

      break;


    case "offer":

      await handleOffer(
        data.data
      );

      break;


    case "answer":

      await handleAnswer(
        data.data
      );

      break;


    case "candidate":

      await handleCandidate(
        data.data
      );

      break;


    case "partner_left":

      await cleanupVideo();

      partnerConnected = false;

      $("chatCard")
        .classList
        .add("hidden");

      $("videoCard")
        .classList
        .add("hidden");

      setButtons(false);

      setStatus(
        "Partner left. Tap Next to find another person.",
        "wait"
      );

      break;


    case "ended":

      await cleanupVideo();

      partnerConnected = false;

      $("chatCard")
        .classList
        .add("hidden");

      $("videoCard")
        .classList
        .add("hidden");

      setButtons(false);

      setStatus(
        "Chat ended."
      );

      break;


    case "reported":

      setStatus(
        "Report submitted.",
        "ok"
      );

      break;


    case "signal_error":

      setStatus(
        data.message ||
        "Video signaling error.",
        "wait"
      );

      break;
  }
}


/* =====================================================
   BUTTON STATE
===================================================== */

function setButtons(searching) {

  $("findBtn").disabled =
    searching ||
    partnerConnected;

  $("nextBtn").disabled =
    !searching &&
    !partnerConnected;

  $("endBtn").disabled =
    !searching &&
    !partnerConnected;

  $("reportBtn").disabled =
    !partnerConnected;
}


/* =====================================================
   FIND
===================================================== */

function findPerson() {

  if (
    !ws ||
    ws.readyState !== WebSocket.OPEN
  ) {

    connect();

    setTimeout(
      findPerson,
      800
    );

    return;
  }


  cleanupVideo();


  partnerConnected = false;


  $("messages").innerHTML = "";


  $("chatCard")
    .classList
    .add("hidden");

  $("videoCard")
    .classList
    .add("hidden");


  ws.send(
    JSON.stringify({
      type: "find",
      prefs: getPrefs()
    })
  );


  setStatus(
    "Looking for someone...",
    "wait"
  );


  setButtons(true);
}


/* =====================================================
   NEXT
===================================================== */

function nextPerson() {

  if (
    !ws ||
    ws.readyState !== WebSocket.OPEN
  ) {
    return;
  }


  cleanupVideo();


  partnerConnected = false;


  $("messages").innerHTML = "";


  $("chatCard")
    .classList
    .add("hidden");

  $("videoCard")
    .classList
    .add("hidden");


  ws.send(
    JSON.stringify({
      type: "next"
    })
  );


  setStatus(
    "Looking for the next person...",
    "wait"
  );


  setButtons(true);
}


/* =====================================================
   END
===================================================== */

function endChat() {

  if (
    ws &&
    ws.readyState === WebSocket.OPEN
  ) {

    ws.send(
      JSON.stringify({
        type: "end"
      })
    );
  }


  cleanupVideo();


  partnerConnected = false;


  $("chatCard")
    .classList
    .add("hidden");

  $("videoCard")
    .classList
    .add("hidden");


  setButtons(false);


  setStatus(
    "Chat ended."
  );
}


/* =====================================================
   TEXT CHAT
===================================================== */

function addMessage(
  text,
  mine
) {

  const div =
    document.createElement(
      "div"
    );

  div.className =
    "message" +
    (mine ? " me" : "");


  div.innerHTML =
    escapeHTML(text) +
    "<small>" +
    (mine
      ? "You"
      : "Stranger") +
    "</small>";


  $("messages")
    .appendChild(div);


  $("messages").scrollTop =
    $("messages").scrollHeight;
}


function sendMessage() {

  const input =
    $("chatInput");

  const text =
    input.value.trim();


  if (
    !text ||
    !partnerConnected ||
    !ws ||
    ws.readyState !== WebSocket.OPEN
  ) {
    return;
  }


  ws.send(
    JSON.stringify({
      type: "chat",
      text
    })
  );


  addMessage(
    text,
    true
  );


  input.value = "";
}


/* =====================================================
   WEBRTC
===================================================== */

const rtcConfig = {

  iceServers: [

    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302"
      ]
    }

  ],

  iceCandidatePoolSize: 10
};


async function createPeer() {

  if (peer) {
    return peer;
  }


  peer =
    new RTCPeerConnection(
      rtcConfig
    );


  peer.onicecandidate =
    event => {

      if (
        event.candidate
      ) {

        sendSignal(
          "candidate",
          event.candidate
        );
      }
    };


  peer.ontrack =
    event => {

      const stream =
        event.streams &&
        event.streams[0];


      if (stream) {

        $("remoteVideo")
          .srcObject = stream;


        $("remoteVideo")
          .play()
          .catch(() => {});
      }
    };


  peer.onconnectionstatechange =
    () => {

      if (!peer) {
        return;
      }


      const state =
        peer.connectionState;


      if (state === "connected") {

        setStatus(
          "Video connected.",
          "ok"
        );
      }


      if (state === "connecting") {

        setStatus(
          "Connecting video...",
          "wait"
        );
      }


      if (
        state === "disconnected"
      ) {

        setStatus(
          "Video unstable. Reconnecting...",
          "wait"
        );

        setTimeout(
          restartICE,
          700
        );
      }


      if (state === "failed") {

        setStatus(
          "Video failed. Restarting...",
          "wait"
        );

        setTimeout(
          restartICE,
          300
        );
      }
    };


  peer.oniceconnectionstatechange =
    () => {

      if (
        peer &&
        peer.iceConnectionState ===
          "failed"
      ) {

        setTimeout(
          restartICE,
          300
        );
      }
    };


  if (localStream) {

    for (
      const track
      of localStream.getTracks()
    ) {

      peer.addTrack(
        track,
        localStream
      );
    }
  }


  return peer;
}


/* =====================================================
   MEDIA
===================================================== */

async function getMedia() {

  if (localStream) {
    return localStream;
  }


  localStream =
    await navigator.mediaDevices
      .getUserMedia({

        video: {
          facingMode: "user",

          width: {
            ideal: 1280
          },

          height: {
            ideal: 720
          }
        },

        audio: {
          echoCancellation: true,

          noiseSuppression: true,

          autoGainControl: true
        }
      });


  $("localVideo")
    .srcObject = localStream;


  $("localVideo")
    .play()
    .catch(() => {});


  return localStream;
}


/* =====================================================
   START VIDEO
===================================================== */

async function startVideo(
  caller
) {

  try {

    await getMedia();

    await createPeer();


    if (caller) {

      const offer =
        await peer.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true
        });


      await peer.setLocalDescription(
        offer
      );


      sendSignal(
        "offer",
        peer.localDescription
      );
    }

  } catch (error) {

    console.error(
      error
    );

    setStatus(
      "Camera/microphone permission is required.",
      "wait"
    );
  }
}


/* =====================================================
   OFFER
===================================================== */

async function handleOffer(
  offer
) {

  await getMedia();

  await createPeer();


  await peer.setRemoteDescription(
    new RTCSessionDescription(
      offer
    )
  );


  await flushICE();


  const answer =
    await peer.createAnswer();


  await peer.setLocalDescription(
    answer
  );


  sendSignal(
    "answer",
    peer.localDescription
  );
}


/* =====================================================
   ANSWER
===================================================== */

async function handleAnswer(
  answer
) {

  if (!peer) {
    return;
  }


  await peer.setRemoteDescription(
    new RTCSessionDescription(
      answer
    )
  );


  await flushICE();
}


/* =====================================================
   ICE
===================================================== */

async function handleCandidate(
  candidate
) {

  if (
    !peer ||
    !peer.remoteDescription
  ) {

    iceQueue.push(
      candidate
    );

    return;
  }


  try {

    await peer.addIceCandidate(
      candidate
    );

  } catch (error) {

    console.warn(
      "ICE candidate error",
      error
    );
  }
}


async function flushICE() {

  const queue =
    iceQueue.splice(0);


  for (
    const candidate
    of queue
  ) {

    try {

      await peer.addIceCandidate(
        candidate
      );

    } catch {}
  }
}


/* =====================================================
   SEND SIGNAL
===================================================== */

function sendSignal(
  type,
  data
) {

  if (
    !partnerConnected ||
    !ws ||
    ws.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }


  ws.send(
    JSON.stringify({
      type,
      data
    })
  );
}


/* =====================================================
   ICE RESTART
===================================================== */

async function restartICE() {

  if (
    !partnerConnected ||
    mode !== "video"
  ) {
    return;
  }


  try {

    await getMedia();

    await createPeer();


    if (role === "caller") {

      const offer =
        await peer.createOffer({
          iceRestart: true
        });


      await peer.setLocalDescription(
        offer
      );


      sendSignal(
        "offer",
        peer.localDescription
      );
    }

  } catch (error) {

    console.warn(
      "ICE restart failed",
      error
    );
  }
}


/* =====================================================
   CLEANUP
===================================================== */

async function cleanupVideo() {

  iceQueue = [];


  if (peer) {

    try {
      peer.close();
    } catch {}

    peer = null;
  }


  if (localStream) {

    for (
      const track
      of localStream.getTracks()
    ) {

      try {
        track.stop();
      } catch {}
    }

    localStream = null;
  }


  $("localVideo")
    .srcObject = null;

  $("remoteVideo")
    .srcObject = null;
}


/* =====================================================
   CAMERA
===================================================== */

$("camBtn").onclick =
  () => {

    if (!localStream) {
      return;
    }


    const track =
      localStream
        .getVideoTracks()[0];


    if (!track) {
      return;
    }


    track.enabled =
      !track.enabled;


    $("camBtn").textContent =
      track.enabled
        ? "Camera"
        : "Camera Off";
  };


/* =====================================================
   MICROPHONE
===================================================== */

$("micBtn").onclick =
  () => {

    if (!localStream) {
      return;
    }


    const track =
      localStream
        .getAudioTracks()[0];


    if (!track) {
      return;
    }


    track.enabled =
      !track.enabled;


    $("micBtn").textContent =
      track.enabled
        ? "Microphone"
        : "Mic Off";
  };


/* =====================================================
   VIDEO RECONNECT
===================================================== */

$("restartBtn").onclick =
  restartICE;


/* =====================================================
   MODE
===================================================== */

$("textTab").onclick =
  () => {

    if (partnerConnected) {
      return;
    }


    mode = "text";


    $("textTab")
      .classList
      .add("active");


    $("videoTab")
      .classList
      .remove("active");
  };


$("videoTab").onclick =
  () => {

    if (partnerConnected) {
      return;
    }


    mode = "video";


    $("videoTab")
      .classList
      .add("active");


    $("textTab")
      .classList
      .remove("active");
  };


/* =====================================================
   BUTTONS
===================================================== */

$("findBtn").onclick =
  findPerson;


$("nextBtn").onclick =
  nextPerson;


$("endBtn").onclick =
  endChat;


$("sendBtn").onclick =
  sendMessage;


$("chatInput").onkeydown =
  event => {

    if (
      event.key === "Enter"
    ) {

      sendMessage();
    }
  };


/* =====================================================
   PREFERENCES
===================================================== */

$("gender").onchange =
  () => {

    if (
      ws &&
      ws.readyState ===
        WebSocket.OPEN
    ) {

      ws.send(
        JSON.stringify({
          type: "prefs",
          prefs: getPrefs()
        })
      );
    }
  };


$("country").onchange =
  () => {

    if (
      ws &&
      ws.readyState ===
        WebSocket.OPEN
    ) {

      ws.send(
        JSON.stringify({
          type: "prefs",
          prefs: getPrefs()
        })
      );
    }
  };


/* =====================================================
   REPORT
===================================================== */

$("reportBtn").onclick =
  () => {

    if (!partnerConnected) {
      return;
    }


    const reason =
      prompt(
        "Why are you reporting this person?"
      );


    if (!reason?.trim()) {
      return;
    }


    ws.send(
      JSON.stringify({
        type: "report",
        reason:
          reason.trim()
      })
    );
  };


/* =====================================================
   PAGE CLOSE
===================================================== */

window.addEventListener(
  "beforeunload",
  () => {

    manualClose = true;

    try {
      ws?.close();
    } catch {}

    try {
      localStream
        ?.getTracks()
        .forEach(
          track => track.stop()
        );
    } catch {}
  }
);


/* =====================================================
   START
===================================================== */

setButtons(false);

connect();

})();

</script>

</body>

</html>`;
