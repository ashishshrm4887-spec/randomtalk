import { DurableObject } from "cloudflare:workers";

/*
========================================================
 RANDOMTALK
 Text Chat + Video Chat + WebRTC + Report System
 Cloudflare Worker + Durable Object
========================================================
*/

export class ChatRoom extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.env = env;

    this.waiting = {
      text: null,
      video: null
    };

    this.partners = new Map();
    this.modes = new Map();
    this.sessions = new Map();

    /*
      Make sure report storage exists.
      Reports are stored in Durable Object storage.
    */
  }

  async fetch(request) {

    if (
      request.method === "GET" &&
      request.headers.get("Upgrade") === "websocket"
    ) {

      const pair = new WebSocketPair();

      const client = pair[0];
      const server = pair[1];

      /*
        Current Cloudflare Durable Object
        WebSocket Hibernation API.
      */
      this.ctx.acceptWebSocket(server);

      const sessionId = crypto.randomUUID();

      this.sessions.set(server, {
        id: sessionId,
        mode: null
      });

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }

    return new Response("ChatRoom is running.", {
      status: 200
    });
  }

  send(socket, data) {

    if (
      socket &&
      socket.readyState === WebSocket.OPEN
    ) {
      try {
        socket.send(JSON.stringify(data));
      } catch {}
    }
  }

  webSocketMessage(socket, message) {

    let data;

    try {

      data =
        typeof message === "string"
          ? JSON.parse(message)
          : JSON.parse(new TextDecoder().decode(message));

    } catch {

      this.send(socket, {
        type: "error",
        message: "Invalid message."
      });

      return;
    }

    /*
    ======================================================
      JOIN
    ======================================================
    */

    if (data.type === "join") {

      const mode =
        data.mode === "video"
          ? "video"
          : "text";

      this.removeFromWaiting(socket);
      this.removePartnerOnly(socket);

      this.modes.set(socket, mode);

      const session =
        this.sessions.get(socket);

      if (session) {
        session.mode = mode;
      }

      const other =
        this.waiting[mode];

      if (
        other &&
        other !== socket &&
        other.readyState === WebSocket.OPEN
      ) {

        this.waiting[mode] = null;

        this.partners.set(socket, other);
        this.partners.set(other, socket);

        this.send(socket, {
          type: "matched",
          mode,
          initiator: false
        });

        this.send(other, {
          type: "matched",
          mode,
          initiator: true
        });

      } else {

        this.waiting[mode] = socket;

        this.send(socket, {
          type: "waiting",
          mode
        });
      }

      return;
    }

    /*
    ======================================================
      CHAT
    ======================================================
    */

    if (data.type === "chat") {

      const partner =
        this.partners.get(socket);

      if (
        partner &&
        partner.readyState === WebSocket.OPEN
      ) {

        const text =
          String(data.text || "")
            .trim()
            .slice(0, 2000);

        if (!text) return;

        this.send(partner, {
          type: "chat",
          text
        });
      }

      return;
    }

    /*
    ======================================================
      WEBRTC SIGNAL
    ======================================================
    */

    if (data.type === "signal") {

      const partner =
        this.partners.get(socket);

      if (
        partner &&
        partner.readyState === WebSocket.OPEN
      ) {

        this.send(partner, {
          type: "signal",
          signal: data.signal
        });
      }

      return;
    }

    /*
    ======================================================
      NEXT
    ======================================================
    */

    if (data.type === "next") {

      const mode =
        this.modes.get(socket) || "text";

      const partner =
        this.partners.get(socket);

      if (partner) {

        this.partners.delete(socket);
        this.partners.delete(partner);

        this.send(partner, {
          type: "partner_left"
        });
      }

      this.waitForUser(socket, mode);

      return;
    }

    /*
    ======================================================
      END
    ======================================================
    */

    if (data.type === "end") {

      this.endUser(socket);

      return;
    }

    /*
    ======================================================
      REPORT
    ======================================================
    */

    if (data.type === "report") {

      await this.saveReport(socket, data);

      return;
    }
  }

  webSocketClose(socket) {

    this.cleanup(socket);
  }

  webSocketError(socket) {

    this.cleanup(socket);
  }

  /*
  ========================================================
    WAIT FOR USER
  ========================================================
  */

  waitForUser(socket, mode) {

    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    mode =
      mode === "video"
        ? "video"
        : "text";

    this.removeFromWaiting(socket);
    this.removePartnerOnly(socket);

    this.modes.set(socket, mode);

    const session =
      this.sessions.get(socket);

    if (session) {
      session.mode = mode;
    }

    const other =
      this.waiting[mode];

    if (
      other &&
      other !== socket &&
      other.readyState === WebSocket.OPEN
    ) {

      this.waiting[mode] = null;

      this.partners.set(socket, other);
      this.partners.set(other, socket);

      this.send(socket, {
        type: "matched",
        mode,
        initiator: false
      });

      this.send(other, {
        type: "matched",
        mode,
        initiator: true
      });

      return;
    }

    this.waiting[mode] = socket;

    this.send(socket, {
      type: "waiting",
      mode
    });
  }

  /*
  ========================================================
    END USER
  ========================================================
  */

  endUser(socket) {

    this.removeFromWaiting(socket);

    const partner =
      this.partners.get(socket);

    if (partner) {

      this.partners.delete(socket);
      this.partners.delete(partner);

      this.send(partner, {
        type: "partner_left"
      });

      const partnerMode =
        this.modes.get(partner) || "text";

      /*
        Keep the partner searching.
      */
      if (
        partner.readyState === WebSocket.OPEN
      ) {

        this.waitForUser(
          partner,
          partnerMode
        );
      }
    }

    this.modes.delete(socket);
    this.sessions.delete(socket);
  }

  /*
  ========================================================
    REMOVE PARTNER ONLY
  ========================================================
  */

  removePartnerOnly(socket) {

    const partner =
      this.partners.get(socket);

    if (!partner) {
      return;
    }

    this.partners.delete(socket);
    this.partners.delete(partner);

    if (
      partner.readyState === WebSocket.OPEN
    ) {

      this.send(partner, {
        type: "partner_left"
      });
    }
  }

  /*
  ========================================================
    WAITING CLEANUP
  ========================================================
  */

  removeFromWaiting(socket) {

    if (this.waiting.text === socket) {
      this.waiting.text = null;
    }

    if (this.waiting.video === socket) {
      this.waiting.video = null;
    }
  }

  /*
  ========================================================
    CONNECTION CLEANUP
  ========================================================
  */

  cleanup(socket) {

    this.removeFromWaiting(socket);

    const partner =
      this.partners.get(socket);

    if (partner) {

      this.partners.delete(socket);
      this.partners.delete(partner);

      if (
        partner.readyState === WebSocket.OPEN
      ) {

        this.send(partner, {
          type: "partner_left"
        });

        const mode =
          this.modes.get(partner) || "text";

        this.waiting[mode] = partner;

        this.send(partner, {
          type: "waiting",
          mode
        });
      }
    }

    this.partners.delete(socket);
    this.modes.delete(socket);
    this.sessions.delete(socket);
  }

  /*
  ========================================================
    REPORT STORAGE
  ========================================================
  */

  async saveReport(socket, data) {

    const session =
      this.sessions.get(socket);

    const reporterId =
      session?.id ||
      crypto.randomUUID();

    const reasons = {
      nudity: "Nudity / sexual content",
      harassment: "Harassment / bullying",
      threats: "Threats / violence",
      spam: "Spam / scam",
      underage: "Underage concern",
      other: "Other"
    };

    const reason =
      reasons[data.reason]
        ? data.reason
        : "other";

    const reportId =
      crypto.randomUUID();

    const report = {
      id: reportId,
      reporterId,
      reason,
      description:
        String(data.description || "")
          .slice(0, 1000),
      createdAt:
        new Date().toISOString()
    };

    try {

      await this.ctx.storage.put(
        `report:${reportId}`,
        report
      );

      /*
        Keep a simple counter.
      */

      const oldCount =
        await this.ctx.storage.get(
          "report_count"
        );

      const count =
        Number(oldCount || 0) + 1;

      await this.ctx.storage.put(
        "report_count",
        count
      );

      this.send(socket, {
        type: "report_success",
        message:
          "Report submitted successfully."
      });

    } catch (error) {

      console.error(
        "Report storage error:",
        error
      );

      this.send(socket, {
        type: "report_error",
        message:
          "Could not save the report."
      });
    }
  }
}


/*
========================================================
 MAIN WORKER
========================================================
*/

export default {

  async fetch(request, env) {

    const url =
      new URL(request.url);

    /*
    ======================================================
      WEBSOCKET
    ======================================================
    */

    if (
      url.pathname === "/ws"
    ) {

      if (
        request.headers.get("Upgrade")
          ?.toLowerCase() !== "websocket"
      ) {

        return new Response(
          "WebSocket connection required.",
          {
            status: 426
          }
        );
      }

      const id =
        env.CHAT.idFromName(
          "global-chat-room"
        );

      const room =
        env.CHAT.get(id);

      return room.fetch(request);
    }

    /*
    ======================================================
      WEBSITE
    ======================================================
    */

    return new Response(
      HTML,
      {
        headers: {
          "content-type":
            "text/html; charset=UTF-8"
        }
      }
    );
  }
};


/*
========================================================
 HTML
========================================================
*/

const HTML = `<!DOCTYPE html>

<html lang="en">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1.0"
>

<title>RandomTalk</title>

<style>

* {
  box-sizing:border-box;
}

html {
  scroll-behavior:smooth;
}

body {
  margin:0;
  background:
    radial-gradient(
      circle at 80% 20%,
      rgba(124,58,237,.18),
      transparent 30%
    ),
    radial-gradient(
      circle at 20% 80%,
      rgba(217,70,239,.12),
      transparent 30%
    ),
    #050816;

  color:#f8fafc;

  font-family:
    Inter,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

button,
input,
textarea {
  font:inherit;
}

button {
  cursor:pointer;
}

.container {
  width:min(
    1100px,
    calc(100% - 28px)
  );

  margin:auto;
}

/* NAV */

.navbar {
  height:70px;

  border-bottom:
    1px solid #1c263b;

  display:flex;
  align-items:center;
}

.nav-inner {
  width:min(
    1100px,
    calc(100% - 28px)
  );

  margin:auto;

  display:flex;
  justify-content:space-between;
  align-items:center;
}

.logo {
  font-size:23px;
  font-weight:800;

  display:flex;
  align-items:center;
  gap:9px;
}

.logo-icon {
  width:38px;
  height:38px;

  border-radius:12px;

  display:grid;
  place-items:center;

  background:
    linear-gradient(
      135deg,
      #a855f7,
      #6366f1
    );
}

.logo span {
  background:
    linear-gradient(
      90deg,
      #d946ef,
      #6366f1
    );

  -webkit-background-clip:text;
  color:transparent;
}

/* HERO */

.hero {
  padding:
    55px
    0
    40px;

  text-align:center;
}

.hero h1 {
  font-size:
    clamp(
      45px,
      8vw,
      75px
    );

  line-height:1;

  margin:0;
}

.gradient {
  background:
    linear-gradient(
      90deg,
      #d946ef,
      #7c3aed,
      #6366f1
    );

  -webkit-background-clip:text;
  color:transparent;
}

.hero p {
  max-width:600px;
  margin:22px auto;

  color:#aab5ca;

  font-size:18px;
  line-height:1.6;
}

.primary {
  border:0;

  padding:
    16px
    25px;

  border-radius:14px;

  color:white;

  font-weight:800;

  background:
    linear-gradient(
      90deg,
      #d946ef,
      #7c3aed
    );
}

/* APP */

.chat-app {

  margin-bottom:50px;

  border:
    1px solid #25304a;

  background:#080f20;

  border-radius:22px;

  overflow:hidden;
}

/* TABS */

.tabs {

  display:flex;
  gap:10px;

  padding:14px;

  border-bottom:
    1px solid #202b42;
}

.tab {

  flex:1;

  padding:15px;

  border-radius:13px;

  border:
    1px solid #293651;

  background:
    #0b1222;

  color:#aeb9ce;

  font-weight:800;
}

.tab.active {

  color:white;

  border-color:transparent;

  background:
    linear-gradient(
      90deg,
      #a855f7,
      #6366f1
    );
}

/* HEADER */

.status {

  padding:
    18px
    20px;

  border-bottom:
    1px solid #202b42;

  display:flex;

  justify-content:space-between;

  align-items:center;
}

.status-title {
  font-weight:800;
}

.status-title.waiting {
  color:#fbbf24;
}

.status-title.connected {
  color:#4ade80;
}

.status-text {
  margin-top:5px;
  color:#94a3b8;
}

.report-btn {

  padding:
    10px
    16px;

  border-radius:20px;

  background:transparent;

  border:
    1px solid #7f3042;

  color:#fb7185;

  font-weight:700;
}

/* CONTENT */

.content {
  padding:20px;
}

/* VIDEO */

.video-area {
  display:none;
}

.video-area.show {
  display:block;
}

.video-box {

  position:relative;

  width:100%;

  height:
    min(
      500px,
      65vh
    );

  min-height:330px;

  border-radius:18px;

  overflow:hidden;

  background:#020617;

  border:
    1px solid #27334d;
}

#remoteVideo {

  width:100%;
  height:100%;

  object-fit:cover;

  background:#020617;
}

#localVideo {

  position:absolute;

  right:14px;
  bottom:14px;

  width:130px;
  height:175px;

  object-fit:cover;

  border-radius:15px;

  border:
    2px solid #7c3aed;

  background:#020617;

  z-index:5;
}

.video-placeholder {

  position:absolute;

  inset:0;

  display:grid;

  place-items:center;

  text-align:center;

  color:#94a3b8;

  z-index:2;
}

.video-placeholder-icon {
  font-size:55px;
  margin-bottom:10px;
}

.video-label {

  position:absolute;

  left:14px;
  bottom:14px;

  padding:
    8px
    13px;

  border-radius:18px;

  background:#000b;

  z-index:7;
}

/* CONTROLS */

.controls {

  display:none;

  gap:10px;

  margin-top:12px;
}

.controls.show {
  display:flex;
}

.control {

  flex:1;

  padding:13px;

  border-radius:12px;

  background:#111a2d;

  border:
    1px solid #27334d;

  color:white;

  font-weight:700;
}

/* TEXT */

.messages {

  min-height:300px;

  max-height:420px;

  overflow-y:auto;

  padding:10px 0;

  display:flex;

  flex-direction:column;

  gap:12px;
}

.message {

  max-width:80%;

  padding:
    12px
    15px;

  border-radius:16px;

  line-height:1.4;
}

.received {

  align-self:flex-start;

  background:#182238;
}

.sent {

  align-self:flex-end;

  background:
    linear-gradient(
      135deg,
      #6d28d9,
      #4f46e5
    );
}

/* INPUT */

.input-row {

  display:flex;

  gap:9px;

  margin-top:12px;
}

#messageInput {

  flex:1;

  min-width:0;

  padding:
    15px
    18px;

  border-radius:28px;

  background:#0c1426;

  border:
    1px solid #34415d;

  color:white;

  outline:none;
}

.send {

  width:52px;
  height:52px;

  border-radius:50%;

  border:0;

  color:white;

  background:
    linear-gradient(
      135deg,
      #d946ef,
      #7c3aed
    );
}

/* ACTIONS */

.actions {

  display:grid;

  grid-template-columns:
    1fr
    2fr;

  gap:10px;

  margin-top:15px;
}

.action {

  padding:15px;

  border-radius:13px;

  font-weight:800;
}

.end {

  color:#fb7185;

  background:#0b1222;

  border:
    1px solid #27334d;
}

.next {

  border:0;

  color:white;

  background:
    linear-gradient(
      90deg,
      #d946ef,
      #7c3aed
    );
}

/* REPORT MODAL */

.modal {

  position:fixed;

  inset:0;

  background:
    rgba(0,0,0,.75);

  display:none;

  align-items:center;

  justify-content:center;

  padding:20px;

  z-index:100;
}

.modal.show {
  display:flex;
}

.modal-box {

  width:
    min(
      420px,
      100%
    );

  background:#0b1222;

  border:
    1px solid #293651;

  border-radius:20px;

  padding:22px;

  box-shadow:
    0 25px 80px
    rgba(0,0,0,.5);
}

.modal-box h2 {
  margin-top:0;
}

.reason {

  width:100%;

  text-align:left;

  padding:13px;

  margin:
    6px
    0;

  border-radius:11px;

  background:#111a2d;

  border:
    1px solid #27334d;

  color:white;
}

.reason:hover {
  background:#1a2540;
}

.close-modal {

  width:100%;

  margin-top:10px;

  padding:12px;

  border-radius:11px;

  border:
    1px solid #27334d;

  background:transparent;

  color:#cbd5e1;
}

/* FOOTER */

.footer {

  text-align:center;

  padding:
    20px
    20px
    45px;

  color:#64748b;
}

/* MOBILE */

@media(max-width:700px) {

  .hero {
    padding-top:40px;
  }

  .hero h1 {
    font-size:50px;
  }

  .content {
    padding:14px;
  }

  .video-box {
    height:430px;
  }

  #localVideo {
    width:115px;
    height:160px;
  }

  .actions {
    grid-template-columns:1fr;
  }

  .status {
    align-items:flex-start;
    gap:10px;
  }

  .report-btn {
    flex-shrink:0;
  }
}

</style>

</head>

<body>

<header class="navbar">

<div class="nav-inner">

<div class="logo">

<div class="logo-icon">
💬
</div>

Random<span>Talk</span>

</div>

</div>

</header>


<main>

<section class="hero container">

<h1>
Talk to someone
<span class="gradient">new.</span>
</h1>

<p>
Meet random people through
text or video chat.
</p>

<button
class="primary"
onclick="goChat()"
>
🚀 Start Chatting
</button>

</section>


<section
class="container"
id="chat"
>

<div class="chat-app">

<div class="tabs">

<button
class="tab active"
id="textTab"
onclick="selectText()"
>
💬 Text Chat
</button>

<button
class="tab"
id="videoTab"
onclick="selectVideo()"
>
🎥 Video Chat
</button>

</div>


<div class="status">

<div>

<div
id="statusTitle"
class="status-title waiting"
>
● Ready
</div>

<div
id="statusText"
class="status-text"
>
Press Start Chatting to find someone
</div>

</div>

<button
class="report-btn"
onclick="openReport()"
>
⚠ Report
</button>

</div>


<div class="content">


<div
class="video-area"
id="videoArea"
>

<div class="video-box">

<video
id="remoteVideo"
autoplay
playsinline
></video>

<video
id="localVideo"
autoplay
muted
playsinline
></video>

<div
id="videoPlaceholder"
class="video-placeholder"
>

<div>

<div class="video-placeholder-icon">
🎥
</div>

<div id="videoPlaceholderText">
Press Start Chatting to begin
</div>

</div>

</div>

<div class="video-label">
Stranger
</div>

</div>


<div
id="videoControls"
class="controls"
>

<button
class="control"
onclick="toggleCamera()"
id="cameraButton"
>
📷 Camera On
</button>

<button
class="control"
onclick="toggleMicrophone()"
id="micButton"
>
🎤 Microphone On
</button>

</div>

</div>


<div
id="messages"
class="messages"
>

<div class="message received">
👋 Welcome to RandomTalk!
</div>

<div class="message received">
Choose Text or Video, then press Start Chatting.
</div>

</div>


<div class="input-row">

<input
id="messageInput"
type="text"
placeholder="Start a chat first..."
disabled
onkeydown="handleEnter(event)"
>

<button
class="send"
onclick="sendMessage()"
>
➤
</button>

</div>


<div class="actions">

<button
class="action end"
onclick="endChat()"
>
⏹ End Chat
</button>

<button
class="action next"
id="mainButton"
onclick="startOrNext()"
>
🚀 Start Chatting
</button>

</div>


</div>

</div>

</section>

</main>


<footer class="footer">

RandomTalk © 2026 · Talk safely. Meet someone new.

</footer>


<!-- REPORT MODAL -->

<div
id="reportModal"
class="modal"
>

<div class="modal-box">

<h2>
⚠ Report Stranger
</h2>

<p
style="color:#94a3b8"
>
Select the reason for your report.
</p>

<button
class="reason"
onclick="submitReport('nudity')"
>
🔞 Nudity / sexual content
</button>

<button
class="reason"
onclick="submitReport('harassment')"
>
😡 Harassment / bullying
</button>

<button
class="reason"
onclick="submitReport('threats')"
>
⚠️ Threats / violence
</button>

<button
class="reason"
onclick="submitReport('spam')"
>
🚨 Spam / scam
</button>

<button
class="reason"
onclick="submitReport('underage')"
>
🛡️ Underage concern
</button>

<button
class="reason"
onclick="submitReport('other')"
>
📝 Other
</button>

<button
class="close-modal"
onclick="closeReport()"
>
Cancel
</button>

</div>

</div>


<script>

let socket = null;

let connected = false;

let intentionallyClosed = false;

let currentMode = "text";

let localStream = null;

let peerConnection = null;

let isInitiator = false;

let cameraEnabled = true;

let microphoneEnabled = true;

let pendingIceCandidates = [];


/*
========================================================
 WEBRTC
========================================================
*/

const rtcConfig = {

  iceServers: [

    {
      urls:
        "stun:stun.l.google.com:19302"
    },

    {
      urls:
        "stun:stun1.l.google.com:19302"
    }

  ]
};


/*
========================================================
 MODE
========================================================
*/

function selectText() {

  if (connected) {

    alert(
      "End the current chat before changing mode."
    );

    return;
  }

  currentMode = "text";

  document
    .getElementById("textTab")
    .classList.add("active");

  document
    .getElementById("videoTab")
    .classList.remove("active");

  document
    .getElementById("videoArea")
    .classList.remove("show");

  document
    .getElementById("videoControls")
    .classList.remove("show");
}


function selectVideo() {

  if (connected) {

    alert(
      "End the current chat before changing mode."
    );

    return;
  }

  currentMode = "video";

  document
    .getElementById("videoTab")
    .classList.add("active");

  document
    .getElementById("textTab")
    .classList.remove("active");

  document
    .getElementById("videoArea")
    .classList.add("show");

  document
    .getElementById("videoControls")
    .classList.add("show");
}


/*
========================================================
 SOCKET
========================================================
*/

function connectSocket() {

  if (
    socket &&
    (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    )
  ) {
    return;
  }

  intentionallyClosed = false;

  const protocol =
    location.protocol === "https:"
      ? "wss:"
      : "ws:";

  socket =
    new WebSocket(
      protocol +
      "//" +
      location.host +
      "/ws"
    );


  socket.addEventListener(
    "open",
    () => {

      updateStatus(
        "● Searching...",
        currentMode === "video"
          ? "Looking for another video user..."
          : "Looking for a random person...",
        false
      );

      setButton(
        "⏳ Searching..."
      );

      socket.send(
        JSON.stringify({
          type:"join",
          mode:currentMode
        })
      );
    }
  );


  socket.addEventListener(
    "message",
    async event => {

      let data;

      try {

        data =
          JSON.parse(event.data);

      } catch {

        return;
      }


      /*
      WAITING
      */

      if (
        data.type === "waiting"
      ) {

        connected = false;

        updateStatus(
          "● Searching...",
          data.mode === "video"
            ? "Waiting for another video user..."
            : "Waiting for another person...",
          false
        );

        disableInput();

        setButton(
          "⏳ Searching..."
        );

        if (data.mode === "video") {

          showVideoWaiting();

        }

        return;
      }


      /*
      MATCHED
      */

      if (
        data.type === "matched"
      ) {

        connected = true;

        isInitiator =
          data.initiator === true;

        currentMode =
          data.mode === "video"
            ? "video"
            : "text";

        updateStatus(
          "● Connected",
          currentMode === "video"
            ? "Starting video connection..."
            : "You are chatting with a random stranger",
          true
        );

        enableInput();

        setButton(
          "⏭ Next"
        );

        addSystemMessage(
          "🎉 You are connected! Say hello."
        );


        if (
          currentMode === "video"
        ) {

          selectVideoForced();

          try {

            await startLocalMedia();

            await createPeerConnection();

            if (isInitiator) {

              await createOffer();

            }

          } catch (error) {

            console.error(
              error
            );

            addSystemMessage(
              "⚠️ Camera or microphone could not start. Check browser permissions."
            );
          }
        }

        return;
      }


      /*
      CHAT
      */

      if (
        data.type === "chat"
      ) {

        addReceivedMessage(
          data.text
        );

        return;
      }


      /*
      SIGNAL
      */

      if (
        data.type === "signal"
      ) {

        try {

          await handleSignal(
            data.signal
          );

        } catch (error) {

          console.error(
            "WebRTC signal error:",
            error
          );

        }

        return;
      }


      /*
      PARTNER LEFT
      */

      if (
        data.type === "partner_left"
      ) {

        connected = false;

        closePeerConnection();

        updateStatus(
          "● Stranger left",
          "Searching for another person...",
          false
        );

        disableInput();

        setButton(
          "⏳ Searching..."
        );

        addSystemMessage(
          "👋 Stranger left. Looking for another person..."
        );

        return;
      }


      /*
      REPORT SUCCESS
      */

      if (
        data.type === "report_success"
      ) {

        closeReport();

        alert(
          "✅ " +
          data.message
        );

        return;
      }


      /*
      REPORT ERROR
      */

      if (
        data.type === "report_error"
      ) {

        alert(
          "❌ " +
          data.message
        );

        return;
      }

    }
  );


  socket.addEventListener(
    "close",
    () => {

      connected = false;

      closePeerConnection();

      if (
        !intentionallyClosed
      ) {

        updateStatus(
          "● Disconnected",
          "Connection lost. Press Start Chatting.",
          false
        );

        disableInput();

        setButton(
          "🚀 Start Chatting"
        );
      }
    }
  );


  socket.addEventListener(
    "error",
    () => {

      updateStatus(
        "● Connection error",
        "Could not connect. Try again.",
        false
      );

      setButton(
        "🚀 Start Chatting"
      );
    }
  );
}


/*
========================================================
 CAMERA
========================================================
*/

async function startLocalMedia() {

  if (
    localStream
  ) {

    const localVideo =
      document.getElementById(
        "localVideo"
      );

    localVideo.srcObject =
      localStream;

    return localStream;
  }


  if (
    !navigator.mediaDevices ||
    !navigator.mediaDevices.getUserMedia
  ) {

    throw new Error(
      "Camera API unavailable"
    );
  }


  localStream =
    await navigator
      .mediaDevices
      .getUserMedia({

        video: {
          facingMode:"user"
        },

        audio:true

      });


  const localVideo =
    document.getElementById(
      "localVideo"
    );

  localVideo.srcObject =
    localStream;

  localVideo.muted =
    true;

  await localVideo
    .play()
    .catch(() => {});


  cameraEnabled =
    true;

  microphoneEnabled =
    true;

  updateVideoButtons();

  return localStream;
}


/*
========================================================
 PEER CONNECTION
========================================================
*/

async function createPeerConnection() {

  if (
    peerConnection
  ) {

    return peerConnection;
  }


  peerConnection =
    new RTCPeerConnection(
      rtcConfig
    );


  if (
    localStream
  ) {

    localStream
      .getTracks()
      .forEach(
        track => {

          peerConnection.addTrack(
            track,
            localStream
          );

        }
      );
  }


  peerConnection.addEventListener(
    "track",
    event => {

      if (
        !event.streams ||
        !event.streams[0]
      ) {

        return;
      }


      const remoteVideo =
        document.getElementById(
          "remoteVideo"
        );

      remoteVideo.srcObject =
        event.streams[0];

      remoteVideo
        .play()
        .catch(() => {});


      const placeholder =
        document.getElementById(
          "videoPlaceholder"
        );

      placeholder.style.display =
        "none";


      updateStatus(
        "● Connected",
        "You are on a video call with a stranger",
        true
      );
    }
  );


  peerConnection.addEventListener(
    "icecandidate",
    event => {

      if (
        !event.candidate ||
        !socket ||
        socket.readyState !== WebSocket.OPEN
      ) {

        return;
      }


      socket.send(
        JSON.stringify({

          type:"signal",

          signal: {

            type:"ice",

            candidate:
              event.candidate

          }

        })
      );
    }
  );


  peerConnection.addEventListener(
    "connectionstatechange",
    () => {

      if (
        !peerConnection
      ) {

        return;
      }


      const state =
        peerConnection.connectionState;


      if (
        state === "connected"
      ) {

        document
          .getElementById(
            "videoPlaceholder"
          )
          .style.display =
          "none";

        updateStatus(
          "● Connected",
          "You are on a video call with a stranger",
          true
        );
      }


      if (
        state === "failed"
      ) {

        const placeholder =
          document.getElementById(
            "videoPlaceholder"
          );

        placeholder.style.display =
          "grid";

        document
          .getElementById(
            "videoPlaceholderText"
          )
          .textContent =
          "Video connection failed. Try Next.";
      }

    }
  );


  return peerConnection;
}


/*
========================================================
 OFFER
========================================================
*/

async function createOffer() {

  if (
    !peerConnection
  ) {

    return;
  }


  const offer =
    await peerConnection
      .createOffer();


  await peerConnection
    .setLocalDescription(
      offer
    );


  if (
    socket &&
    socket.readyState === WebSocket.OPEN
  ) {

    socket.send(
      JSON.stringify({

        type:"signal",

        signal: {

          type:"offer",

          sdp:offer

        }

      })
    );
  }
}


/*
========================================================
 SIGNAL HANDLING
========================================================
*/

async function handleSignal(
  signal
) {

  if (
    !signal
  ) {

    return;
  }


  if (
    !peerConnection
  ) {

    await startLocalMedia();

    await createPeerConnection();
  }


  /*
  OFFER
  */

  if (
    signal.type === "offer"
  ) {

    await peerConnection
      .setRemoteDescription(
        new RTCSessionDescription(
          signal.sdp
        )
      );


    await flushPendingIce();


    const answer =
      await peerConnection
        .createAnswer();


    await peerConnection
      .setLocalDescription(
        answer
      );


    socket.send(
      JSON.stringify({

        type:"signal",

        signal: {

          type:"answer",

          sdp:answer

        }

      })
    );

    return;
  }


  /*
  ANSWER
  */

  if (
    signal.type === "answer"
  ) {

    await peerConnection
      .setRemoteDescription(
        new RTCSessionDescription(
          signal.sdp
        )
      );


    await flushPendingIce();

    return;
  }


  /*
  ICE
  */

  if (
    signal.type === "ice" &&
    signal.candidate
  ) {

    if (
      peerConnection.remoteDescription &&
      peerConnection.remoteDescription.type
    ) {

      try {

        await peerConnection
          .addIceCandidate(
            new RTCIceCandidate(
              signal.candidate
            )
          );

      } catch (
        error
      ) {

        console.error(
          error
        );
      }

    } else {

      pendingIceCandidates.push(
        signal.candidate
      );
    }
  }
}


/*
========================================================
 ICE QUEUE
========================================================
*/

async function flushPendingIce() {

  if (
    !peerConnection
  ) {

    return;
  }


  const candidates =
    pendingIceCandidates;


  pendingIceCandidates =
    [];


  for (
    const candidate
    of candidates
  ) {

    try {

      await peerConnection
        .addIceCandidate(
          new RTCIceCandidate(
            candidate
          )
        );

    } catch (
      error
    ) {

      console.error(
        "ICE queue error:",
        error
      );
    }
  }
}


/*
========================================================
 CLOSE VIDEO
========================================================
*/

function closePeerConnection() {

  pendingIceCandidates =
    [];


  if (
    peerConnection
  ) {

    try {

      peerConnection.close();

    } catch {}

    peerConnection =
      null;
  }


  const remoteVideo =
    document.getElementById(
      "remoteVideo"
    );


  if (
    remoteVideo
  ) {

    remoteVideo.srcObject =
      null;
  }


  showVideoWaiting();
}


function showVideoWaiting() {

  const placeholder =
    document.getElementById(
      "videoPlaceholder"
    );

  const text =
    document.getElementById(
      "videoPlaceholderText"
    );


  if (
    placeholder
  ) {

    placeholder.style.display =
      "grid";
  }


  if (
    text
  ) {

    text.textContent =
      "Waiting for stranger's video...";
  }
}


/*
========================================================
 VIDEO MODE FORCED
========================================================
*/

function selectVideoForced() {

  currentMode =
    "video";

  document
    .getElementById(
      "videoTab"
    )
    .classList.add(
      "active"
    );

  document
    .getElementById(
      "textTab"
    )
    .classList.remove(
      "active"
    );

  document
    .getElementById(
      "videoArea"
    )
    .classList.add(
      "show"
    );

  document
    .getElementById(
      "videoControls"
    )
    .classList.add(
      "show"
    );
}


/*
========================================================
 CAMERA TOGGLE
========================================================
*/

function toggleCamera() {

  if (
    !localStream
  ) {

    return;
  }


  const tracks =
    localStream
      .getVideoTracks();


  if (
    !tracks.length
  ) {

    return;
  }


  cameraEnabled =
    !cameraEnabled;


  tracks.forEach(
    track => {

      track.enabled =
        cameraEnabled;

    }
  );


  updateVideoButtons();
}


/*
========================================================
 MICROPHONE TOGGLE
========================================================
*/

function toggleMicrophone() {

  if (
    !localStream
  ) {

    return;
  }


  const tracks =
    localStream
      .getAudioTracks();


  if (
    !tracks.length
  ) {

    return;
  }


  microphoneEnabled =
    !microphoneEnabled;


  tracks.forEach(
    track => {

      track.enabled =
        microphoneEnabled;

    }
  );


  updateVideoButtons();
}


/*
========================================================
 VIDEO BUTTONS
========================================================
*/

function updateVideoButtons() {

  const camera =
    document.getElementById(
      "cameraButton"
    );

  const mic =
    document.getElementById(
      "micButton"
    );


  if (
    camera
  ) {

    camera.textContent =
      cameraEnabled
        ? "📷 Camera On"
        : "📷 Camera Off";
  }


  if (
    mic
  ) {

    mic.textContent =
      microphoneEnabled
        ? "🎤 Microphone On"
        : "🔇 Microphone Off";
  }
}


/*
========================================================
 START / NEXT
========================================================
*/

function startOrNext() {

  /*
    NEXT
  */

  if (
    socket &&
    socket.readyState === WebSocket.OPEN &&
    connected
  ) {

    closePeerConnection();

    clearMessages();

    socket.send(
      JSON.stringify({
        type:"next"
      })
    );


    connected =
      false;


    updateStatus(
      "● Searching...",
      "Finding another person...",
      false
    );


    disableInput();

    setButton(
      "⏳ Searching..."
    );

    return;
  }


  /*
    START
  */

  intentionallyClosed =
    false;


  if (
    !socket ||
    socket.readyState !== WebSocket.OPEN
  ) {

    connectSocket();

  }
}


/*
========================================================
 SEND MESSAGE
========================================================
*/

function sendMessage() {

  const input =
    document.getElementById(
      "messageInput"
    );


  const text =
    input.value.trim();


  if (
    !text ||
    !connected ||
    !socket ||
    socket.readyState !== WebSocket.OPEN
  ) {

    return;
  }


  socket.send(
    JSON.stringify({

      type:"chat",

      text

    })
  );


  addSentMessage(
    text
  );


  input.value =
    "";
}


/*
========================================================
 ENTER
========================================================
*/

function handleEnter(
  event
) {

  if (
    event.key === "Enter"
  ) {

    event.preventDefault();

    sendMessage();
  }
}


/*
========================================================
 END CHAT
========================================================
*/

function endChat() {

  if (
    socket &&
    socket.readyState === WebSocket.OPEN
  ) {

    socket.send(
      JSON.stringify({
        type:"end"
      })
    );


    intentionallyClosed =
      true;


    socket.close();
  }


  connected =
    false;


  closePeerConnection();

  disableInput();


  updateStatus(
    "● Offline",
    "Chat ended.",
    false
  );


  setButton(
    "🚀 Start Chatting"
  );


  addSystemMessage(
    "Chat ended."
  );
}


/*
========================================================
 STATUS
========================================================
*/

function updateStatus(
  title,
  text,
  connectedStatus
) {

  const status =
    document.getElementById(
      "statusTitle"
    );


  const description =
    document.getElementById(
      "statusText"
    );


  status.textContent =
    title;


  description.textContent =
    text;


  status.className =
    connectedStatus
      ? "status-title connected"
      : "status-title waiting";
}


/*
========================================================
 BUTTON
========================================================
*/

function setButton(
  text
) {

  document.getElementById(
    "mainButton"
  ).textContent =
    text;
}


/*
========================================================
 INPUT
========================================================
*/

function enableInput() {

  const input =
    document.getElementById(
      "messageInput"
    );


  input.disabled =
    false;


  input.placeholder =
    "Type a message...";
}


function disableInput() {

  const input =
    document.getElementById(
      "messageInput"
    );


  input.disabled =
    true;


  input.placeholder =
    "Waiting for a stranger...";
}


/*
========================================================
 MESSAGES
========================================================
*/

function clearMessages() {

  document.getElementById(
    "messages"
  ).innerHTML =
    "";
}


function addSystemMessage(
  text
) {

  const div =
    document.createElement(
      "div"
    );


  div.className =
    "message received";


  div.textContent =
    text;


  document
    .getElementById(
      "messages"
    )
    .appendChild(
      div
    );


  scrollMessages();
}


function addReceivedMessage(
  text
) {

  const div =
    document.createElement(
      "div"
    );


  div.className =
    "message received";


  div.textContent =
    text;


  document
    .getElementById(
      "messages"
    )
    .appendChild(
      div
    );


  scrollMessages();
}


function addSentMessage(
  text
) {

  const div =
    document.createElement(
      "div"
    );


  div.className =
    "message sent";


  div.textContent =
    text;


  document
    .getElementById(
      "messages"
    )
    .appendChild(
      div
    );


  scrollMessages();
}


function scrollMessages() {

  const box =
    document.getElementById(
      "messages"
    );


  box.scrollTop =
    box.scrollHeight;
}


/*
========================================================
 REPORT
========================================================
*/

function openReport() {

  if (
    !connected
  ) {

    alert(
      "You are not currently connected."
    );

    return;
  }


  document
    .getElementById(
      "reportModal"
    )
    .classList.add(
      "show"
    );
}


function closeReport() {

  document
    .getElementById(
      "reportModal"
    )
    .classList.remove(
      "show"
    );
}


function submitReport(
  reason
) {

  if (
    !connected ||
    !socket ||
    socket.readyState !== WebSocket.OPEN
  ) {

    closeReport();

    alert(
      "You are not currently connected."
    );

    return;
  }


  socket.send(
    JSON.stringify({

      type:"report",

      reason

    })
  );
}


/*
========================================================
 PAGE
========================================================
*/

function goChat() {

  document
    .getElementById(
      "chat"
    )
    .scrollIntoView({
      behavior:"smooth"
    });
}


window.addEventListener(
  "load",
  () => {

    selectText();

  }
);

</script>

</body>

</html>`;
