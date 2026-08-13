import { DurableObject } from "cloudflare:workers";

/*
  ============================================================
  RANDOMTALK - COMPLETE CLOUDFLARE WORKER
  ============================================================

  Features:
  - Text random chat
  - 1-to-1 video chat using WebRTC
  - Gender preference matching
  - Country preference matching
  - Next / End chat
  - Report system stored in Durable Object storage
  - Optional admin report endpoint
  - WebRTC ICE restart/recovery for intermittent black screens
  - Camera/microphone controls
  - Mobile-friendly UI

  IMPORTANT:
  WebRTC media travels peer-to-peer. The Worker is used for
  signaling/matching; it does not receive the video stream.

  Optional TURN:
  For the best reliability across restrictive mobile/Wi-Fi
  networks, set:
    TURN_URL
    TURN_USERNAME
    TURN_CREDENTIAL

  Without TURN, Google STUN servers are used and some networks
  can still prevent a direct WebRTC connection.
*/


/* ============================================================
   DURABLE OBJECT
============================================================ */

export class ChatRoom extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);
  }

  send(ws, data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    try {
      ws.send(JSON.stringify(data));
    } catch (error) {
      console.error("WebSocket send error:", error);
    }
  }

  getInfo(ws) {
    try {
      return ws.deserializeAttachment() || {};
    } catch {
      return {};
    }
  }

  setInfo(ws, info) {
    try {
      ws.serializeAttachment(info);
    } catch (error) {
      console.error("Attachment error:", error);
    }
  }

  getSockets() {
    return this.ctx.getWebSockets();
  }

  findSocketById(id) {
    if (!id) return null;

    for (const ws of this.getSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      const info = this.getInfo(ws);

      if (info.id === id) {
        return ws;
      }
    }

    return null;
  }

  canMatch(a, b) {
    if (!a || !b) return false;

    if (a.status !== "waiting") return false;
    if (b.status !== "waiting") return false;

    if (a.mode !== b.mode) return false;

    /*
      Country:
      "any" accepts every country.
      Otherwise both users must accept the other's country.
    */
    if (
      a.country &&
      a.country !== "any" &&
      a.country !== b.country
    ) {
      return false;
    }

    if (
      b.country &&
      b.country !== "any" &&
      b.country !== a.country
    ) {
      return false;
    }

    /*
      Gender:
      "everyone" ignores preferred gender.
      "gender" applies each user's preference.
    */
    if (
      a.chatWith === "gender" &&
      a.preferredGender &&
      a.preferredGender !== "any" &&
      a.preferredGender !== b.gender
    ) {
      return false;
    }

    if (
      b.chatWith === "gender" &&
      b.preferredGender &&
      b.preferredGender !== "any" &&
      b.preferredGender !== a.gender
    ) {
      return false;
    }

    return true;
  }

  findMatch(ws) {
    const user = this.getInfo(ws);

    for (const other of this.getSockets()) {
      if (other === ws) continue;
      if (other.readyState !== WebSocket.OPEN) continue;

      const otherInfo = this.getInfo(other);

      if (this.canMatch(user, otherInfo)) {
        return other;
      }
    }

    return null;
  }

  matchUsers(aSocket, bSocket) {
    if (!aSocket || !bSocket) return false;
    if (aSocket === bSocket) return false;

    const a = this.getInfo(aSocket);
    const b = this.getInfo(bSocket);

    if (!this.canMatch(a, b)) {
      return false;
    }

    this.setInfo(aSocket, {
      ...a,
      status: "matched",
      partnerId: b.id
    });

    this.setInfo(bSocket, {
      ...b,
      status: "matched",
      partnerId: a.id
    });

    this.send(aSocket, {
      type: "matched",
      mode: a.mode,
      initiator: false
    });

    this.send(bSocket, {
      type: "matched",
      mode: b.mode,
      initiator: true
    });

    return true;
  }

  putIntoQueue(ws) {
    const info = this.getInfo(ws);

    this.setInfo(ws, {
      ...info,
      status: "waiting",
      partnerId: null
    });

    const match = this.findMatch(ws);

    if (match) {
      return this.matchUsers(ws, match);
    }

    this.send(ws, {
      type: "waiting",
      mode: info.mode || "text"
    });

    return false;
  }

  async fetch(request) {
    const internalUrl = new URL(request.url);

    if (internalUrl.pathname === "/__internal_reports") {
      const entries = await this.ctx.storage.list({
        prefix: "report:"
      });

      const reports = [];

      for (const value of entries.values()) {
        reports.push(value);
      }

      reports.sort(
        (a, b) =>
          String(b.createdAt).localeCompare(
            String(a.createdAt)
          )
      );

      const count =
        Number(
          (await this.ctx.storage.get("report_count")) || 0
        );

      return new Response(
        JSON.stringify(
          {
            count,
            reports: reports.slice(0, 500)
          },
          null,
          2
        ),
        {
          headers: {
            "content-type":
              "application/json; charset=UTF-8"
          }
        }
      );
    }

    if (
      request.headers.get("Upgrade")?.toLowerCase() !==
      "websocket"
    ) {
      return new Response(
        "RandomTalk ChatRoom is running.",
        { status: 200 }
      );
    }

    const pair = new WebSocketPair();

    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);

    const id = crypto.randomUUID();

    this.setInfo(server, {
      id,
      mode: "text",
      status: "idle",

      chatWith: "everyone",
      gender: "other",
      preferredGender: "any",
      country: "any",

      partnerId: null,
      joinedAt: Date.now()
    });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(ws, message) {
    let data;

    try {
      if (typeof message === "string") {
        data = JSON.parse(message);
      } else {
        data = JSON.parse(
          new TextDecoder().decode(message)
        );
      }
    } catch {
      this.send(ws, {
        type: "error",
        message: "Invalid message."
      });
      return;
    }

    if (!data || !data.type) return;

    /* ========================================================
       JOIN
    ======================================================== */

    if (data.type === "join") {
      const oldInfo = this.getInfo(ws);

      const mode =
        data.mode === "video"
          ? "video"
          : "text";

      const chatWith =
        data.chatWith === "gender"
          ? "gender"
          : "everyone";

      const gender =
        ["male", "female", "other"].includes(data.gender)
          ? data.gender
          : "other";

      const preferredGender =
        ["male", "female", "other", "any"].includes(
          data.preferredGender
        )
          ? data.preferredGender
          : "any";

      const country =
        typeof data.country === "string" &&
        data.country.length <= 30
          ? data.country
          : "any";

      const info = {
        ...oldInfo,
        mode,
        status: "waiting",
        chatWith,
        gender,
        preferredGender,
        country,
        partnerId: null
      };

      this.setInfo(ws, info);

      const match = this.findMatch(ws);

      if (match) {
        this.matchUsers(ws, match);
      } else {
        this.send(ws, {
          type: "waiting",
          mode
        });
      }

      return;
    }

    /* ========================================================
       CHAT
    ======================================================== */

    if (data.type === "chat") {
      const info = this.getInfo(ws);

      if (
        info.status !== "matched" ||
        !info.partnerId
      ) {
        return;
      }

      const partner =
        this.findSocketById(info.partnerId);

      if (!partner) return;

      const text =
        String(data.text || "")
          .trim()
          .slice(0, 2000);

      if (!text) return;

      this.send(partner, {
        type: "chat",
        text
      });

      return;
    }

    /* ========================================================
       WEBRTC SIGNALING
    ======================================================== */

    if (data.type === "signal") {
      const info = this.getInfo(ws);

      if (
        info.status !== "matched" ||
        !info.partnerId ||
        !data.signal
      ) {
        return;
      }

      const partner =
        this.findSocketById(info.partnerId);

      if (!partner) return;

      this.send(partner, {
        type: "signal",
        signal: data.signal
      });

      return;
    }

    /* ========================================================
       NEXT
    ======================================================== */

    if (data.type === "next") {
      const info = this.getInfo(ws);

      const partner =
        info.partnerId
          ? this.findSocketById(info.partnerId)
          : null;

      /*
        Temporarily make the person pressing Next idle so the
        partner cannot immediately be matched back to them.
      */
      this.setInfo(ws, {
        ...info,
        status: "idle",
        partnerId: null
      });

      if (partner) {
        const partnerInfo = this.getInfo(partner);

        this.setInfo(partner, {
          ...partnerInfo,
          status: "waiting",
          partnerId: null
        });

        this.send(partner, {
          type: "partner_left"
        });

        this.send(partner, {
          type: "waiting",
          mode: partnerInfo.mode || "text"
        });

        /*
          Try to immediately match the partner with somebody
          else. If no one is available, they remain waiting.
        */
        this.putIntoQueue(partner);
      }

      /*
        Now queue the person who pressed Next.
      */
      this.putIntoQueue(ws);

      return;
    }

    /* ========================================================
       END
    ======================================================== */

    if (data.type === "end") {
      const info = this.getInfo(ws);

      const partner =
        info.partnerId
          ? this.findSocketById(info.partnerId)
          : null;

      if (partner) {
        const partnerInfo = this.getInfo(partner);

        this.setInfo(partner, {
          ...partnerInfo,
          status: "idle",
          partnerId: null
        });

        this.send(partner, {
          type: "partner_left"
        });
      }

      this.setInfo(ws, {
        ...info,
        status: "idle",
        partnerId: null
      });

      return;
    }

    /* ========================================================
       REPORT
    ======================================================== */

    if (data.type === "report") {
      const info = this.getInfo(ws);

      const reason =
        String(data.reason || "Other")
          .slice(0, 100);

      const details =
        String(data.details || "")
          .slice(0, 500);

      const report = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),

        reason,
        details,

        reporterId:
          info.id || "unknown",

        reportedUserId:
          info.partnerId || "unknown",

        mode:
          info.mode || "text",

        country:
          info.country || "unknown"
      };

      await this.saveReport(report);

      this.send(ws, {
        type: "report_success",
        message:
          "Report submitted successfully."
      });

      return;
    }

    /* ========================================================
       PING
    ======================================================== */

    if (data.type === "ping") {
      this.send(ws, {
        type: "pong"
      });
    }
  }

  async saveReport(report) {
    await this.ctx.storage.put(
      "report:" + report.id,
      report
    );

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

    console.log(
      "RandomTalk report saved:",
      report.id
    );
  }

  async webSocketClose(
    ws,
    code,
    reason,
    wasClean
  ) {
    const info = this.getInfo(ws);

    if (!info.partnerId) return;

    const partner =
      this.findSocketById(info.partnerId);

    if (!partner) return;

    const partnerInfo =
      this.getInfo(partner);

    this.setInfo(partner, {
      ...partnerInfo,
      status: "waiting",
      partnerId: null
    });

    this.send(partner, {
      type: "partner_left"
    });

    this.putIntoQueue(partner);
  }

  async webSocketError(ws, error) {
    console.error(
      "RandomTalk WebSocket error:",
      error
    );

    await this.webSocketClose(
      ws,
      1011,
      "error",
      false
    );
  }
}


/* ============================================================
   MAIN WORKER
============================================================ */

export default {

  async fetch(request, env) {
    const url = new URL(request.url);

    /* --------------------------------------------------------
       WEBSOCKET
    -------------------------------------------------------- */

    if (url.pathname === "/ws") {
      if (
        request.headers.get("Upgrade")?.toLowerCase() !==
        "websocket"
      ) {
        return new Response(
          "WebSocket upgrade required.",
          { status: 426 }
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

    /* --------------------------------------------------------
       HEALTH
    -------------------------------------------------------- */

    if (url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "RandomTalk",
        time: new Date().toISOString()
      });
    }

    /* --------------------------------------------------------
       ADMIN REPORTS
       Requires ADMIN_TOKEN environment variable.
       Request:
         Authorization: Bearer YOUR_ADMIN_TOKEN
    -------------------------------------------------------- */

    if (url.pathname === "/admin/reports") {
      const expected =
        env.ADMIN_TOKEN;

      const auth =
        request.headers.get("Authorization") || "";

      if (
        !expected ||
        auth !== `Bearer ${expected}`
      ) {
        return new Response(
          "Unauthorized",
          { status: 401 }
        );
      }

      const id =
        env.CHAT.idFromName(
          "global-chat-room"
        );

      const room =
        env.CHAT.get(id);

      return room.fetch(
        new Request(
          new URL(
            "/__internal_reports",
            request.url
          ),
          request
        )
      );
    }

    /* --------------------------------------------------------
       WEBSITE
    -------------------------------------------------------- */

    return new Response(
      HTML_PAGE,
      {
        headers: {
          "content-type":
            "text/html; charset=UTF-8",
          "cache-control":
            "no-store"
        }
      }
    );
  }
};


/* ============================================================
   JSON HELPER
============================================================ */

function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=UTF-8"
      }
    }
  );
}


/* ============================================================
   HTML
============================================================ */

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1.0,viewport-fit=cover"
>

<meta
  name="theme-color"
  content="#050816"
>

<title>RandomTalk</title>

<style>

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  background:
    radial-gradient(
      circle at 80% 20%,
      rgba(124,58,237,.20),
      transparent 30%
    ),
    radial-gradient(
      circle at 20% 80%,
      rgba(217,70,239,.12),
      transparent 30%
    ),
    #050816;
  color: #f8fafc;
  font-family:
    Inter,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

button,
input,
select,
textarea {
  font: inherit;
}

button {
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.container {
  width: min(
    1180px,
    calc(100% - 32px)
  );
  margin: auto;
}

.navbar {
  height: 75px;
  border-bottom:
    1px solid rgba(
      148,
      163,
      184,
      .12
    );
  display: flex;
  align-items: center;
}

.nav-inner {
  width: min(
    1180px,
    calc(100% - 32px)
  );
  margin: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.logo {
  font-size: 24px;
  font-weight: 900;
}

.logo span {
  color: #a855f7;
}

.nav-links {
  display: flex;
  gap: 30px;
}

.nav-links a {
  color: #dbe3f1;
  text-decoration: none;
}

.hero {
  padding: 70px 0 45px;
  display: grid;
  grid-template-columns: 1fr;
  gap: 40px;
}

.hero h1 {
  margin: 0;
  font-size:
    clamp(
      45px,
      6vw,
      76px
    );
  line-height: 1;
  letter-spacing: -3px;
}

.gradient {
  background:
    linear-gradient(
      90deg,
      #d946ef,
      #7c3aed,
      #6366f1
    );
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.hero p {
  color: #aab5ca;
  font-size: 20px;
  line-height: 1.6;
  max-width: 600px;
}

.hero-buttons {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.primary,
.secondary {
  padding: 15px 22px;
  border-radius: 13px;
  font-weight: 800;
}

.primary {
  border: 0;
  color: white;
  background:
    linear-gradient(
      90deg,
      #d946ef,
      #7c3aed
    );
}

.secondary {
  border:
    1px solid #34415d;
  color: white;
  background: transparent;
}

.chat-app {
  margin-bottom: 70px;
  border:
    1px solid #25304a;
  background: #080f20;
  border-radius: 22px;
  overflow: hidden;
}

.tabs {
  display: flex;
  gap: 10px;
  padding: 16px;
  border-bottom:
    1px solid #202b42;
}

.tab {
  flex: 1;
  padding: 14px;
  border-radius: 12px;
  border:
    1px solid #26324b;
  background: transparent;
  color: #aeb9ce;
  font-weight: 800;
}

.tab.active {
  color: white;
  border-color: transparent;
  background:
    linear-gradient(
      90deg,
      #a855f7,
      #6366f1
    );
}

.layout {
  display: grid;
  grid-template-columns: 270px 1fr;
}

.sidebar {
  padding: 20px;
  border-right:
    1px solid #202b42;
}

.preference {
  margin: 20px 0;
}

.preference-title {
  color: #aab5ca;
  margin-bottom: 9px;
}

.preference-buttons {
  display: flex;
}

.preference-buttons button {
  flex: 1;
  padding: 10px;
  border:
    1px solid #27334d;
  background: #111a2d;
  color: white;
}

.preference-buttons button.selected {
  background: #7c3aed;
}

.select-box {
  width: 100%;
  padding: 12px;
  border-radius: 10px;
  border:
    1px solid #27334d;
  background: #111a2d;
  color: white;
}

.save-btn {
  width: 100%;
  padding: 12px;
  border: 0;
  border-radius: 10px;
  color: white;
  font-weight: 800;
  background:
    linear-gradient(
      90deg,
      #c026d3,
      #7c3aed
    );
}

.chat-panel {
  min-height: 620px;
  display: flex;
  flex-direction: column;
}

.chat-header {
  padding: 20px;
  display: flex;
  justify-content: space-between;
  gap: 15px;
  border-bottom:
    1px solid #202b42;
}

.status {
  color: #fbbf24;
  font-weight: 800;
}

.status.connected {
  color: #4ade80;
}

.report-btn {
  border:
    1px solid #6b2737;
  background: transparent;
  color: #fb7185;
  padding: 9px 14px;
  border-radius: 20px;
  white-space: nowrap;
}

/* VIDEO */

.video-area {
  display: none;
  padding: 18px;
}

.video-area.show {
  display: block;
}

.video-box {
  position: relative;
  height: 480px;
  overflow: hidden;
  border-radius: 18px;
  background: #020617;
  border:
    1px solid #27334d;
}

#remoteVideo {
  width: 100%;
  height: 100%;
  object-fit: cover;
  background: #020617;
}

#localVideo {
  position: absolute;
  right: 15px;
  bottom: 15px;
  width: 150px;
  height: 115px;
  object-fit: cover;
  border-radius: 14px;
  border:
    2px solid #7c3aed;
  background: #020617;
  z-index: 3;
}

.video-placeholder {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  text-align: center;
  color: #94a3b8;
  font-size: 18px;
  z-index: 2;
  pointer-events: none;
}

.video-status-pill {
  position: absolute;
  left: 15px;
  top: 15px;
  z-index: 4;
  padding: 8px 12px;
  border-radius: 999px;
  background: rgba(2,6,23,.72);
  border: 1px solid rgba(148,163,184,.25);
  color: #dbe3f1;
  font-size: 13px;
}

.video-controls {
  display: none;
  gap: 10px;
  padding: 12px 18px;
}

.video-controls.show {
  display: flex;
}

.control {
  flex: 1;
  padding: 12px;
  border-radius: 10px;
  border:
    1px solid #27334d;
  background: #111a2d;
  color: white;
}

/* MESSAGES */

.messages {
  flex: 1;
  padding: 22px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  max-height: 400px;
}

.message {
  max-width: 75%;
  padding: 12px 16px;
  border-radius: 16px;
  line-height: 1.45;
  word-break: break-word;
}

.received {
  align-self: flex-start;
  background: #182238;
}

.sent {
  align-self: flex-end;
  background:
    linear-gradient(
      135deg,
      #6d28d9,
      #4f46e5
    );
}

.message-input {
  display: flex;
  gap: 10px;
  padding: 0 20px 18px;
}

.message-input input {
  flex: 1;
  min-width: 0;
  padding: 14px 18px;
  border-radius: 25px;
  border:
    1px solid #34415d;
  outline: none;
  background: #0c1426;
  color: white;
}

.send {
  width: 52px;
  height: 52px;
  border: 0;
  border-radius: 50%;
  color: white;
  background:
    linear-gradient(
      135deg,
      #d946ef,
      #7c3aed
    );
}

.actions {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 12px;
  padding: 18px;
  border-top:
    1px solid #202b42;
}

.end,
.next {
  padding: 14px;
  border-radius: 12px;
  font-weight: 800;
}

.end {
  background: #0b1222;
  border:
    1px solid #202b42;
  color: #fb7185;
}

.next {
  border: 0;
  color: white;
  background:
    linear-gradient(
      90deg,
      #d946ef,
      #7c3aed
    );
}

/* REPORT */

.modal {
  position: fixed;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(0,0,0,.75);
  z-index: 100;
}

.modal.show {
  display: flex;
}

.modal-box {
  width: min(
    430px,
    100%
  );
  padding: 24px;
  border-radius: 18px;
  border:
    1px solid #34415d;
  background: #0b1222;
}

.modal-box h2 {
  margin-top: 0;
}

.modal-box select,
.modal-box textarea {
  width: 100%;
  margin-bottom: 12px;
  padding: 12px;
  border-radius: 10px;
  border:
    1px solid #34415d;
  background: #111a2d;
  color: white;
}

.modal-buttons {
  display: flex;
  gap: 10px;
}

.modal-buttons button {
  flex: 1;
  padding: 12px;
  border-radius: 10px;
  border: 0;
}

.cancel {
  background: #182238;
  color: white;
}

.submit-report {
  background: #dc2626;
  color: white;
}

@media(max-width:800px) {

  .nav-links {
    display: none;
  }

  .hero {
    padding-top: 45px;
  }

  .layout {
    grid-template-columns: 1fr;
  }

  .sidebar {
    display: block;
    border-right: 0;
    border-bottom:
      1px solid #202b42;
  }

  .actions {
    grid-template-columns: 1fr;
  }

  .video-box {
    height: 390px;
  }

  #localVideo {
    width: 115px;
    height: 150px;
  }

  .message {
    max-width: 85%;
  }

  .chat-header {
    align-items: flex-start;
  }
}

</style>

</head>

<body>

<header class="navbar">

<div class="nav-inner">

<div class="logo">
ð¬ Random<span>Talk</span>
</div>

<nav class="nav-links">
<a href="#">Home</a>
<a href="#chat">Chat</a>
<a href="#safety">Safety</a>
</nav>

</div>

</header>

<main>

<section class="hero container">

<div>

<h1>
Talk to<br>
someone
<span class="gradient">new.</span>
</h1>

<p>
Meet random people through text or video chat.
Find compatible strangers and move to the next person whenever you want.
</p>

<div class="hero-buttons">

<button
class="primary"
onclick="startFromHero()"
>
ð Start Chatting
</button>

<button
class="secondary"
onclick="showHow()"
>
â¶ How it works
</button>

</div>

</div>

</section>

<section
class="container"
id="chat"
>

<div class="chat-app">

<div class="tabs">

<button
id="textTab"
class="tab active"
onclick="selectText()"
>
ð¬ Text Chat
</button>

<button
id="videoTab"
class="tab"
onclick="selectVideo()"
>
ð¥ Video Chat
</button>

</div>

<div class="layout">

<aside class="sidebar">

<h3>âï¸ Preferences</h3>

<div class="preference">

<div class="preference-title">
Chat with
</div>

<div class="preference-buttons">

<button
id="everyoneBtn"
class="selected"
onclick="chooseEveryone()"
>
Everyone
</button>

<button
id="genderBtn"
onclick="chooseGender()"
>
Gender
</button>

</div>

</div>

<div
id="myGenderBox"
class="preference"
style="display:none"
>

<div class="preference-title">
My gender
</div>

<select
id="myGender"
class="select-box"
>

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

<div
id="preferredGenderBox"
class="preference"
style="display:none"
>

<div class="preference-title">
I want to chat with
</div>

<select
id="preferredGender"
class="select-box"
>

<option value="any">
Any gender
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

<div class="preference">

<div class="preference-title">
Country
</div>

<select
id="country"
class="select-box"
>

<option value="any">
Any country
</option>

<option value="india">
India ð®ð³
</option>

<option value="usa">
United States ðºð¸
</option>

<option value="uk">
United Kingdom ð¬ð§
</option>

<option value="canada">
Canada ð¨ð¦
</option>

<option value="australia">
Australia ð¦ðº
</option>

<option value="germany">
Germany ð©ðª
</option>

<option value="france">
France ð«ð·
</option>

<option value="japan">
Japan ð¯ðµ
</option>

</select>

</div>

<button
class="save-btn"
onclick="savePreferences()"
>
â¨ Save Preferences
</button>

<div
id="safety"
style="
margin-top:25px;
color:#94a3b8;
line-height:1.8;
"
>

<b>Safety</b><br>

â¢ Be respectful<br>
â¢ Don't share personal information<br>
â¢ Report inappropriate users<br>
â¢ You can leave anytime<br>
â¢ Never send money to strangers

</div>

</aside>

<section class="chat-panel">

<div class="chat-header">

<div>

<div
id="status"
class="status"
>
â Ready
</div>

<small id="statusText">
Choose Text or Video Chat and press Start Chatting.
</small>

</div>

<button
class="report-btn"
onclick="openReport()"
>
â  Report
</button>

</div>

<div
id="videoArea"
class="video-area"
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

<div class="video-status-pill" id="videoStatusPill">
Video not connected
</div>

<div
id="videoPlaceholder"
class="video-placeholder"
>

<div>

<div style="font-size:55px">
ð¥
</div>

<div id="videoPlaceholderText">
Waiting for video...
</div>

</div>

</div>

</div>

</div>

<div
id="videoControls"
class="video-controls"
>

<button
class="control"
onclick="toggleCamera()"
>
ð· Camera On
</button>

<button
class="control"
onclick="toggleMicrophone()"
>
ð¤ Microphone On
</button>

</div>

<div
id="messages"
class="messages"
>

<div class="message received">
ð Welcome to RandomTalk!
</div>

<div class="message received">
Choose Text or Video Chat and press Start Chatting.
</div>

</div>

<div class="message-input">

<input
id="messageInput"
placeholder="Start a chat first..."
disabled
maxlength="2000"
onkeydown="handleEnter(event)"
>

<button
class="send"
onclick="sendMessage()"
>
â¤
</button>

</div>

<div class="actions">

<button
class="end"
onclick="endChat()"
>
â¹ End Chat
</button>

<button
id="nextButton"
class="next"
onclick="startOrNext()"
>
ð Start Chatting
</button>

</div>

</section>

</div>

</div>

</section>

</main>

<div
id="reportModal"
class="modal"
>

<div class="modal-box">

<h2>â  Report User</h2>

<p style="color:#94a3b8">
Tell us what happened.
</p>

<select id="reportReason">

<option value="Harassment">
Harassment
</option>

<option value="Sexual content">
Sexual content
</option>

<option value="Hate or abuse">
Hate or abuse
</option>

<option value="Spam">
Spam
</option>

<option value="Scam">
Scam
</option>

<option value="Inappropriate behavior">
Inappropriate behavior
</option>

<option value="Other">
Other
</option>

</select>

<textarea
id="reportDetails"
rows="4"
maxlength="500"
placeholder="Optional details..."
></textarea>

<div class="modal-buttons">

<button
class="cancel"
onclick="closeReport()"
>
Cancel
</button>

<button
class="submit-report"
onclick="submitReport()"
>
Submit Report
</button>

</div>

</div>

</div>

<script>

/* ============================================================
   STATE
============================================================ */

let socket = null;
let connected = false;
let currentMode = "text";
let currentChatWith = "everyone";

let localStream = null;
let peerConnection = null;
let isInitiator = false;

let cameraEnabled = true;
let microphoneEnabled = true;

let pendingIceCandidates = [];

let reconnectTimer = null;
let videoRecoveryTimer = null;
let intentionalClose = false;


/* ============================================================
   WEBRTC CONFIG
============================================================ */

const rtcConfig = {
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302"
    },
    {
      urls: "stun:stun1.l.google.com:19302"
    }
  ]
};


/* ============================================================
   SAFE ELEMENT
============================================================ */

function el(id) {
  return document.getElementById(id);
}


/* ============================================================
   MODE
============================================================ */

function selectText() {

  currentMode = "text";

  el("textTab").classList.add("active");
  el("videoTab").classList.remove("active");

  el("videoArea").classList.remove("show");
  el("videoControls").classList.remove("show");

  updateVideoPill("Video mode off");
}


function selectVideo() {

  currentMode = "video";

  el("videoTab").classList.add("active");
  el("textTab").classList.remove("active");

  el("videoArea").classList.add("show");
  el("videoControls").classList.add("show");

  updateVideoPill("Waiting for video");
}


/* ============================================================
   GENDER
============================================================ */

function chooseEveryone() {

  currentChatWith = "everyone";

  el("everyoneBtn").classList.add("selected");
  el("genderBtn").classList.remove("selected");

  el("myGenderBox").style.display = "none";
  el("preferredGenderBox").style.display = "none";
}


function chooseGender() {

  currentChatWith = "gender";

  el("genderBtn").classList.add("selected");
  el("everyoneBtn").classList.remove("selected");

  el("myGenderBox").style.display = "block";
  el("preferredGenderBox").style.display = "block";
}


/* ============================================================
   SOCKET
============================================================ */

function connectSocket() {

  intentionalClose = false;

  if (
    socket &&
    (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    )
  ) {
    return;
  }

  const protocol =
    location.protocol === "https:"
      ? "wss:"
      : "ws:";

  const wsUrl =
    protocol +
    "//" +
    location.host +
    "/ws";

  socket = new WebSocket(wsUrl);

  socket.addEventListener(
    "open",
    function() {

      clearTimeout(reconnectTimer);

      const myGender =
        el("myGender").value;

      const preferredGender =
        el("preferredGender").value;

      const country =
        el("country").value;

      updateStatus(
        "â Searching...",
        "Looking for a compatible person...",
        false
      );

      setButton("â³ Searching...");

      socket.send(
        JSON.stringify({
          type: "join",
          mode: currentMode,
          chatWith: currentChatWith,
          gender: myGender,
          preferredGender:
            currentChatWith === "gender"
              ? preferredGender
              : "any",
          country
        })
      );
    }
  );


  socket.addEventListener(
    "message",
    async function(event) {

      let data;

      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      /* WAITING */

      if (data.type === "waiting") {

        connected = false;

        updateStatus(
          "â Searching...",
          "Waiting for a compatible stranger...",
          false
        );

        disableInput();

        setButton("â³ Searching...");

        updateVideoPill("Waiting for video");

        return;
      }


      /* MATCHED */

      if (data.type === "matched") {

        connected = true;

        isInitiator =
          data.initiator === true;

        currentMode =
          data.mode === "video"
            ? "video"
            : "text";

        updateStatus(
          "â Connected",
          currentMode === "video"
            ? "Starting video..."
            : "You are chatting with a stranger.",
          true
        );

        enableInput();
        setButton("â­ Next");

        addSystemMessage(
          "ð Connected! Say hello."
        );

        if (currentMode === "video") {

          selectVideo();

          try {

            await startLocalMedia();
            await createPeerConnection();

            if (isInitiator) {
              await createOffer(false);
            }

          } catch (error) {

            console.error(
              "Camera startup error:",
              error
            );

            updateVideoPill(
              "Camera/microphone unavailable"
            );

            addSystemMessage(
              "â ï¸ Camera or microphone permission was not available. You can still use text chat."
            );
          }
        }

        return;
      }


      /* CHAT */

      if (data.type === "chat") {

        addReceivedMessage(
          String(data.text || "")
        );

        return;
      }


      /* SIGNAL */

      if (data.type === "signal") {

        try {

          await handleSignal(
            data.signal
          );

        } catch (error) {

          console.error(
            "WebRTC signaling error:",
            error
          );

          updateVideoPill(
            "Video connection error"
          );
        }

        return;
      }


      /* PARTNER LEFT */

      if (data.type === "partner_left") {

        connected = false;

        closePeerConnection();

        updateStatus(
          "â Stranger left",
          "Searching for another compatible person...",
          false
        );

        disableInput();
        setButton("â³ Searching...");

        addSystemMessage(
          "ð Stranger left. Searching..."
        );

        updateVideoPill(
          "Waiting for another video user"
        );

        return;
      }


      /* REPORT */

      if (data.type === "report_success") {

        closeReport();

        el("reportDetails").value = "";

        alert(
          "â Report submitted successfully."
        );

        return;
      }


      /* ERROR */

      if (data.type === "error") {

        addSystemMessage(
          "â ï¸ " +
          String(data.message || "Something went wrong.")
        );

        return;
      }

    }
  );


  socket.addEventListener(
    "close",
    function() {

      connected = false;

      closePeerConnection();

      updateStatus(
        "â Disconnected",
        intentionalClose
          ? "Chat ended."
          : "Connection closed. Press Start Chatting.",
        false
      );

      disableInput();

      setButton(
        "ð Start Chatting"
      );

      updateVideoPill(
        "Video disconnected"
      );

    }
  );


  socket.addEventListener(
    "error",
    function(error) {

      console.error(
        "WebSocket error:",
        error
      );

      updateStatus(
        "â Connection error",
        "Please try again.",
        false
      );
    }
  );
}


/* ============================================================
   CAMERA
============================================================ */

async function startLocalMedia() {

  if (localStream) {
    return localStream;
  }

  if (
    !navigator.mediaDevices ||
    !navigator.mediaDevices.getUserMedia
  ) {
    throw new Error(
      "Camera API unavailable."
    );
  }

  localStream =
    await navigator.mediaDevices.getUserMedia({
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

  const video =
    el("localVideo");

  video.srcObject =
    localStream;

  video.muted = true;

  await video.play()
    .catch(function() {});

  cameraEnabled = true;
  microphoneEnabled = true;

  updateVideoButtons();

  return localStream;
}


/* ============================================================
   PEER CONNECTION
============================================================ */

async function createPeerConnection() {

  if (peerConnection) {
    return peerConnection;
  }

  peerConnection =
    new RTCPeerConnection(
      rtcConfig
    );

  pendingIceCandidates = [];


  if (localStream) {

    localStream
      .getTracks()
      .forEach(
        function(track) {

          peerConnection.addTrack(
            track,
            localStream
          );

        }
      );
  }


  peerConnection.addEventListener(
    "track",
    function(event) {

      if (
        !event.streams ||
        !event.streams[0]
      ) {
        return;
      }

      const remote =
        el("remoteVideo");

      remote.srcObject =
        event.streams[0];

      remote.play()
        .catch(function() {});

      el("videoPlaceholder")
        .style.display = "none";

      updateVideoPill(
        "Video connected"
      );

      updateStatus(
        "â Connected",
        "You are on a video call.",
        true
      );
    }
  );


  peerConnection.addEventListener(
    "icecandidate",
    function(event) {

      if (
        !event.candidate ||
        !socket ||
        socket.readyState !==
          WebSocket.OPEN
      ) {
        return;
      }

      socket.send(
        JSON.stringify({
          type: "signal",
          signal: {
            type: "ice",
            candidate: event.candidate
          }
        })
      );
    }
  );


  peerConnection.addEventListener(
    "connectionstatechange",
    function() {

      if (!peerConnection) {
        return;
      }

      const state =
        peerConnection.connectionState;

      console.log(
        "WebRTC connection:",
        state
      );

      if (state === "connected") {

        el("videoPlaceholder")
          .style.display = "none";

        updateVideoPill(
          "Video connected"
        );

        updateStatus(
          "â Connected",
          "You are on a video call.",
          true
        );

        return;
      }

      if (state === "connecting") {

        updateVideoPill(
          "Connecting video..."
        );

        return;
      }

      if (state === "disconnected") {

        updateVideoPill(
          "Reconnecting video..."
        );

        scheduleIceRestart();

        return;
      }

      if (state === "failed") {

        updateVideoPill(
          "Recovering video..."
        );

        restartIceNow();

        return;
      }

      if (state === "closed") {

        updateVideoPill(
          "Video closed"
        );
      }
    }
  );


  /*
    ICE-specific recovery.
    This is the main protection against an intermittent
    black/blank remote video screen.
  */
  peerConnection.addEventListener(
    "iceconnectionstatechange",
    function() {

      if (!peerConnection) {
        return;
      }

      const state =
        peerConnection.iceConnectionState;

      console.log(
        "ICE state:",
        state
      );

      if (
        state === "connected" ||
        state === "completed"
      ) {

        updateVideoPill(
          "Video connected"
        );

        return;
      }

      if (state === "checking") {

        updateVideoPill(
          "Checking video connection..."
        );

        return;
      }

      if (state === "disconnected") {

        updateVideoPill(
          "Reconnecting video..."
        );

        scheduleIceRestart();

        return;
      }

      if (state === "failed") {

        updateVideoPill(
          "Recovering video..."
        );

        restartIceNow();

        return;
      }
    }
  );

  return peerConnection;
}


/* ============================================================
   OFFER
============================================================ */

async function createOffer(iceRestart) {

  if (!peerConnection) {
    return;
  }

  const offer =
    await peerConnection.createOffer({
      iceRestart: Boolean(iceRestart)
    });

  await peerConnection.setLocalDescription(
    offer
  );

  sendSignal({
    type: "offer",
    sdp: offer
  });
}


/* ============================================================
   ICE RESTART
============================================================ */

function scheduleIceRestart() {

  clearTimeout(
    videoRecoveryTimer
  );

  videoRecoveryTimer =
    setTimeout(
      async function() {

        if (!peerConnection) {
          return;
        }

        if (
          !connected ||
          currentMode !== "video"
        ) {
          return;
        }

        const state =
          peerConnection.iceConnectionState;

        if (
          state !== "disconnected" &&
          state !== "failed"
        ) {
          return;
        }

        await restartIceNow();

      },
      1500
    );
}


async function restartIceNow() {

  if (!peerConnection) {
    return;
  }

  if (!connected) {
    return;
  }

  if (!isInitiator) {

    /*
      The initiator is responsible for creating a new
      offer. The other peer waits for that offer.
    */
    return;
  }

  try {

    updateVideoPill(
      "Restarting video connection..."
    );

    /*
      restartIce() tells the peer connection to gather
      fresh ICE credentials/candidates.
    */
    peerConnection.restartIce();

    await createOffer(true);

  } catch (error) {

    console.error(
      "ICE restart error:",
      error
    );

    updateVideoPill(
      "Video recovery failed - press Next"
    );
  }
}


/* ============================================================
   SIGNAL
============================================================ */

async function handleSignal(signal) {

  if (!signal) {
    return;
  }

  if (!peerConnection) {

    await startLocalMedia();
    await createPeerConnection();

  }


  if (signal.type === "offer") {

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

    sendSignal({
      type: "answer",
      sdp: answer
    });

    return;
  }


  if (signal.type === "answer") {

    await peerConnection
      .setRemoteDescription(
        new RTCSessionDescription(
          signal.sdp
        )
      );

    await flushPendingIce();

    return;
  }


  if (
    signal.type === "ice" &&
    signal.candidate
  ) {

    if (
      peerConnection.remoteDescription
    ) {

      try {

        await peerConnection
          .addIceCandidate(
            new RTCIceCandidate(
              signal.candidate
            )
          );

      } catch (error) {

        console.error(
          "ICE candidate error:",
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


/* ============================================================
   SEND SIGNAL
============================================================ */

function sendSignal(signal) {

  if (
    !socket ||
    socket.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  socket.send(
    JSON.stringify({
      type: "signal",
      signal
    })
  );
}


/* ============================================================
   FLUSH ICE
============================================================ */

async function flushPendingIce() {

  if (!peerConnection) {
    return;
  }

  const list =
    pendingIceCandidates;

  pendingIceCandidates = [];

  for (
    const candidate of list
  ) {

    try {

      await peerConnection
        .addIceCandidate(
          new RTCIceCandidate(
            candidate
          )
        );

    } catch (error) {

      console.error(
        "Queued ICE error:",
        error
      );
    }
  }
}


/* ============================================================
   CLOSE VIDEO
============================================================ */

function closePeerConnection() {

  clearTimeout(
    videoRecoveryTimer
  );

  pendingIceCandidates = [];

  if (peerConnection) {

    try {
      peerConnection.close();
    } catch {}

    peerConnection = null;
  }

  const remote =
    el("remoteVideo");

  if (remote) {
    remote.srcObject = null;
  }

  const placeholder =
    el("videoPlaceholder");

  if (placeholder) {
    placeholder.style.display = "grid";
  }

  updateVideoPill(
    "Waiting for video"
  );
}


/* ============================================================
   STOP LOCAL MEDIA
============================================================ */

function stopLocalMedia() {

  if (!localStream) {
    return;
  }

  localStream
    .getTracks()
    .forEach(
      function(track) {
        try {
          track.stop();
        } catch {}
      }
    );

  localStream = null;

  const video =
    el("localVideo");

  if (video) {
    video.srcObject = null;
  }
}


/* ============================================================
   CAMERA / MICROPHONE
============================================================ */

function toggleCamera() {

  if (!localStream) {
    return;
  }

  const tracks =
    localStream.getVideoTracks();

  if (!tracks.length) {
    return;
  }

  cameraEnabled =
    !cameraEnabled;

  tracks.forEach(
    function(track) {
      track.enabled =
        cameraEnabled;
    }
  );

  updateVideoButtons();
}


function toggleMicrophone() {

  if (!localStream) {
    return;
  }

  const tracks =
    localStream.getAudioTracks();

  if (!tracks.length) {
    return;
  }

  microphoneEnabled =
    !microphoneEnabled;

  tracks.forEach(
    function(track) {
      track.enabled =
        microphoneEnabled;
    }
  );

  updateVideoButtons();
}


function updateVideoButtons() {

  const buttons =
    document.querySelectorAll(
      ".control"
    );

  if (buttons.length >= 2) {

    buttons[0].textContent =
      cameraEnabled
        ? "ð· Camera On"
        : "ð· Camera Off";

    buttons[1].textContent =
      microphoneEnabled
        ? "ð¤ Microphone On"
        : "ð Microphone Off";
  }
}


/* ============================================================
   START / NEXT
============================================================ */

function startFromHero() {

  el("chat").scrollIntoView({
    behavior: "smooth"
  });

  setTimeout(
    function() {
      startOrNext();
    },
    500
  );
}


function startOrNext() {

  if (
    socket &&
    socket.readyState ===
      WebSocket.OPEN &&
    connected
  ) {

    closePeerConnection();
    clearMessages();

    socket.send(
      JSON.stringify({
        type: "next"
      })
    );

    connected = false;

    updateStatus(
      "â Searching...",
      "Finding another compatible person...",
      false
    );

    disableInput();
    setButton("â³ Searching...");

    return;
  }


  if (
    !socket ||
    socket.readyState !==
      WebSocket.OPEN
  ) {

    connectSocket();

    return;
  }


  /*
    Socket is open but currently waiting.
    The user should not accidentally send a second join.
  */
  updateStatus(
    "â Searching...",
    "Already searching for a stranger...",
    false
  );
}


/* ============================================================
   CHAT
============================================================ */

function sendMessage() {

  const input =
    el("messageInput");

  const text =
    input.value.trim();

  if (
    !text ||
    !connected ||
    !socket ||
    socket.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  socket.send(
    JSON.stringify({
      type: "chat",
      text
    })
  );

  addSentMessage(text);

  input.value = "";
}


function handleEnter(event) {

  if (
    event.key === "Enter"
  ) {

    event.preventDefault();

    sendMessage();
  }
}


/* ============================================================
   END
============================================================ */

function endChat() {

  intentionalClose = true;

  if (
    socket &&
    socket.readyState ===
      WebSocket.OPEN
  ) {

    socket.send(
      JSON.stringify({
        type: "end"
      })
    );

    socket.close();
  }

  connected = false;

  closePeerConnection();
  stopLocalMedia();

  disableInput();

  updateStatus(
    "â Offline",
    "Chat ended.",
    false
  );

  setButton(
    "ð Start Chatting"
  );

  updateVideoPill(
    "Video ended"
  );

  addSystemMessage(
    "Chat ended."
  );
}


/* ============================================================
   REPORT
============================================================ */

function openReport() {

  if (!connected) {

    alert(
      "You are not currently connected."
    );

    return;
  }

  el("reportModal")
    .classList.add("show");
}


function closeReport() {

  el("reportModal")
    .classList.remove("show");
}


function submitReport() {

  if (
    !socket ||
    socket.readyState !==
      WebSocket.OPEN ||
    !connected
  ) {

    alert(
      "You are not currently connected."
    );

    return;
  }

  const reason =
    el("reportReason").value;

  const details =
    el("reportDetails").value;

  socket.send(
    JSON.stringify({
      type: "report",
      reason,
      details
    })
  );
}


/* ============================================================
   PREFERENCES
============================================================ */

function savePreferences() {

  const country =
    el("country").value;

  const myGender =
    el("myGender").value;

  const preferredGender =
    el("preferredGender").value;

  localStorage.setItem(
    "randomtalk_country",
    country
  );

  localStorage.setItem(
    "randomtalk_gender",
    myGender
  );

  localStorage.setItem(
    "randomtalk_preferred_gender",
    preferredGender
  );

  alert(
    "â Preferences saved. They will be used for your next connection."
  );
}


/* ============================================================
   HOW IT WORKS
============================================================ */

function showHow() {

  alert(
    "1. Choose Text or Video Chat.\\n\\n" +
    "2. Choose Everyone or Gender.\\n\\n" +
    "3. Choose a country preference.\\n\\n" +
    "4. Press Start Chatting.\\n\\n" +
    "5. RandomTalk finds a compatible available user.\\n\\n" +
    "6. Press Next anytime to find another person."
  );
}


/* ============================================================
   UI
============================================================ */

function updateStatus(
  title,
  text,
  connectedState
) {

  const status =
    el("status");

  const statusText =
    el("statusText");

  status.textContent =
    title;

  statusText.textContent =
    text;

  if (connectedState) {
    status.classList.add(
      "connected"
    );
  } else {
    status.classList.remove(
      "connected"
    );
  }
}


function setButton(text) {

  el("nextButton")
    .textContent = text;
}


function enableInput() {

  const input =
    el("messageInput");

  input.disabled = false;

  input.placeholder =
    "Type a message...";
}


function disableInput() {

  const input =
    el("messageInput");

  input.disabled = true;

  input.placeholder =
    "Waiting for a stranger...";
}


function updateVideoPill(text) {

  const pill =
    el("videoStatusPill");

  if (pill) {
    pill.textContent =
      text;
  }
}


function clearMessages() {

  el("messages")
    .innerHTML = "";
}


function addSystemMessage(text) {

  const div =
    document.createElement(
      "div"
    );

  div.className =
    "message received";

  div.textContent =
    text;

  el("messages")
    .appendChild(div);

  scrollMessages();
}


function addReceivedMessage(text) {

  const div =
    document.createElement(
      "div"
    );

  div.className =
    "message received";

  div.textContent =
    text;

  el("messages")
    .appendChild(div);

  scrollMessages();
}


function addSentMessage(text) {

  const div =
    document.createElement(
      "div"
    );

  div.className =
    "message sent";

  div.textContent =
    text;

  el("messages")
    .appendChild(div);

  scrollMessages();
}


function scrollMessages() {

  const box =
    el("messages");

  box.scrollTop =
    box.scrollHeight;
}


/* ============================================================
   LOAD
============================================================ */

window.addEventListener(
  "load",
  function() {

    selectText();

    const savedCountry =
      localStorage.getItem(
        "randomtalk_country"
      );

    const savedGender =
      localStorage.getItem(
        "randomtalk_gender"
      );

    const savedPreferred =
      localStorage.getItem(
        "randomtalk_preferred_gender"
      );

    if (savedCountry) {
      el("country").value =
        savedCountry;
    }

    if (savedGender) {
      el("myGender").value =
        savedGender;
    }

    if (savedPreferred) {
      el("preferredGender").value =
        savedPreferred;
    }

  }
);


/* ============================================================
   PAGE VISIBILITY / RECOVERY
============================================================ */

document.addEventListener(
  "visibilitychange",
  function() {

    if (
      document.visibilityState !== "visible"
    ) {
      return;
    }

    /*
      Mobile browsers can temporarily pause WebRTC when
      the tab is backgrounded. When the page returns, check
      whether the connection needs an ICE restart.
    */

    if (
      connected &&
      currentMode === "video" &&
      peerConnection
    ) {

      const state =
        peerConnection.iceConnectionState;

      if (
        state === "disconnected" ||
        state === "failed"
      ) {

        restartIceNow();

      }
    }
  }
);

</script>

</body>
</html>`;
