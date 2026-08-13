import { DurableObject } from "cloudflare:workers";

const MAX_TEXT = 2000;

/* =========================================================
   RANDOMTALK - DURABLE OBJECT CHAT ROOM
   Text + Video + Reports + Gender + Country Matching
========================================================= */

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
    ws.serializeAttachment(info);
  }

  findSocket(id) {
    if (!id) return null;

    for (const ws of this.ctx.getWebSockets()) {
      const info = this.getInfo(ws);

      if (info.id === id) {
        return ws;
      }
    }

    return null;
  }

  /* =======================================================
     MATCHING
  ======================================================= */

  compatible(a, b) {

    if (!a || !b) return false;

    if (a.status !== "waiting") return false;
    if (b.status !== "waiting") return false;

    /* Text only matches text.
       Video only matches video. */
    if (a.mode !== b.mode) return false;

    /* Country */
    if (
      a.country !== "any" &&
      a.country !== b.country
    ) {
      return false;
    }

    if (
      b.country !== "any" &&
      b.country !== a.country
    ) {
      return false;
    }

    /* Gender preference A */
    if (
      a.chatWith === "gender" &&
      a.preferredGender !== "any" &&
      a.preferredGender !== b.gender
    ) {
      return false;
    }

    /* Gender preference B */
    if (
      b.chatWith === "gender" &&
      b.preferredGender !== "any" &&
      b.preferredGender !== a.gender
    ) {
      return false;
    }

    return true;
  }

  findMatch(ws) {

    const user = this.getInfo(ws);

    for (const other of this.ctx.getWebSockets()) {

      if (other === ws) {
        continue;
      }

      if (other.readyState !== WebSocket.OPEN) {
        continue;
      }

      const otherInfo = this.getInfo(other);

      if (this.compatible(user, otherInfo)) {
        return other;
      }
    }

    return null;
  }

  pairUsers(aWs, bWs) {

    const a = this.getInfo(aWs);
    const b = this.getInfo(bWs);

    if (!this.compatible(a, b)) {
      return false;
    }

    this.setInfo(aWs, {
      ...a,
      status: "matched",
      partnerId: b.id
    });

    this.setInfo(bWs, {
      ...b,
      status: "matched",
      partnerId: a.id
    });

    this.send(aWs, {
      type: "matched",
      mode: a.mode,
      initiator: false
    });

    this.send(bWs, {
      type: "matched",
      mode: b.mode,
      initiator: true
    });

    return true;
  }

  /* =======================================================
     CONNECTION
  ======================================================= */

  async fetch(request) {

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

    /*
      Cloudflare Durable Object
      WebSocket Hibernation API
    */

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

  /* =======================================================
     MESSAGE HANDLER
  ======================================================= */

  async webSocketMessage(ws, rawMessage) {

    let data;

    try {

      if (typeof rawMessage === "string") {

        data = JSON.parse(rawMessage);

      } else {

        data = JSON.parse(
          new TextDecoder().decode(rawMessage)
        );

      }

    } catch {

      this.send(ws, {
        type: "error",
        message: "Invalid message."
      });

      return;
    }

    if (!data || !data.type) {
      return;
    }

    /* =====================================================
       JOIN
    ===================================================== */

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
        [
          "male",
          "female",
          "other"
        ].includes(data.gender)
          ? data.gender
          : "other";

      const preferredGender =
        [
          "male",
          "female",
          "other",
          "any"
        ].includes(data.preferredGender)
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

      const other = this.findMatch(ws);

      if (!other) {

        this.send(ws, {
          type: "waiting",
          mode
        });

        return;
      }

      this.pairUsers(ws, other);

      return;
    }

    const info = this.getInfo(ws);

    /* =====================================================
       CHAT MESSAGE
    ===================================================== */

    if (data.type === "chat") {

      if (
        info.status !== "matched" ||
        !info.partnerId
      ) {
        return;
      }

      const partner =
        this.findSocket(info.partnerId);

      if (!partner) {
        return;
      }

      const text =
        String(data.text || "")
          .trim()
          .slice(0, MAX_TEXT);

      if (!text) {
        return;
      }

      this.send(partner, {
        type: "chat",
        text
      });

      return;
    }

    /* =====================================================
       WEBRTC SIGNAL
    ===================================================== */

    if (data.type === "signal") {

      if (!info.partnerId) {
        return;
      }

      const partner =
        this.findSocket(info.partnerId);

      if (!partner) {
        return;
      }

      this.send(partner, {
        type: "signal",
        signal: data.signal
      });

      return;
    }

    /* =====================================================
       NEXT
    ===================================================== */

    if (data.type === "next") {

      const partner =
        this.findSocket(info.partnerId);

      /* Put current user into waiting */
      this.setInfo(ws, {
        ...info,
        status: "waiting",
        partnerId: null
      });

      this.send(ws, {
        type: "waiting",
        mode: info.mode
      });

      /* Put previous partner into waiting */
      if (partner) {

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

        this.send(partner, {
          type: "waiting",
          mode: partnerInfo.mode
        });

        /* Try to find someone for old partner */
        const partnerMatch =
          this.findMatch(partner);

        if (partnerMatch) {
          this.pairUsers(
            partner,
            partnerMatch
          );
        }
      }

      /* Try to find someone for current user */
      const match =
        this.findMatch(ws);

      if (match) {

        this.pairUsers(
          ws,
          match
        );

      }

      return;
    }

    /* =====================================================
       END
    ===================================================== */

    if (data.type === "end") {

      const partner =
        this.findSocket(info.partnerId);

      this.setInfo(ws, {
        ...info,
        status: "idle",
        partnerId: null
      });

      if (partner) {

        const partnerInfo =
          this.getInfo(partner);

        this.setInfo(partner, {
          ...partnerInfo,
          status: "idle",
          partnerId: null
        });

        this.send(partner, {
          type: "partner_left",
          ended: true
        });
      }

      return;
    }

    /* =====================================================
       REPORT
    ===================================================== */

    if (data.type === "report") {

      const report = {

        id:
          crypto.randomUUID(),

        createdAt:
          new Date().toISOString(),

        reason:
          String(
            data.reason || "Other"
          ).slice(0, 100),

        details:
          String(
            data.details || ""
          ).slice(0, 500),

        reporterId:
          info.id || "unknown",

        reportedUserId:
          info.partnerId || "unknown",

        mode:
          info.mode || "text",

        country:
          info.country || "unknown"

      };

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
        "Report saved:",
        report.id
      );

      this.send(ws, {
        type: "report_success",
        message:
          "Report submitted successfully."
      });

      return;
    }

    /* =====================================================
       PING
    ===================================================== */

    if (data.type === "ping") {

      this.send(ws, {
        type: "pong"
      });

      return;
    }
  }

  /* =======================================================
     CLOSE
  ======================================================= */

  async webSocketClose(ws) {

    const info =
      this.getInfo(ws);

    const partner =
      this.findSocket(
        info.partnerId
      );

    if (!partner) {
      return;
    }

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

    this.send(partner, {
      type: "waiting",
      mode: partnerInfo.mode
    });

    const match =
      this.findMatch(partner);

    if (match) {
      this.pairUsers(
        partner,
        match
      );
    }
  }

  /* =======================================================
     ERROR
  ======================================================= */

  async webSocketError(ws, error) {

    console.error(
      "WebSocket error:",
      error
    );

    await this.webSocketClose(ws);
  }
}


/* =========================================================
   MAIN WORKER
========================================================= */

export default {

  async fetch(request, env) {

    const url =
      new URL(request.url);

    /* -----------------------------------------------------
       WEBSOCKET
    ----------------------------------------------------- */

    if (url.pathname === "/ws") {

      if (
        request.method !== "GET" ||
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

    /* -----------------------------------------------------
       HEALTH
    ----------------------------------------------------- */

    if (url.pathname === "/health") {

      return Response.json({

        ok: true,

        service: "RandomTalk",

        time:
          new Date().toISOString()

      });
    }

    /* -----------------------------------------------------
       WEBSITE
    ----------------------------------------------------- */

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


/* =========================================================
   WEBSITE
========================================================= */

const HTML_PAGE = `<!DOCTYPE html>

<html lang="en">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>RandomTalk</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;

  background: #050816;

  color: #f8fafc;

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
select,
textarea {
  font: inherit;
}

button {
  cursor: pointer;
}

.wrap {
  width:
    min(
      1100px,
      calc(100% - 28px)
    );

  margin: auto;
}

/* NAV */

.nav {
  height: 70px;

  border-bottom:
    1px solid #202b42;

  display: flex;

  align-items: center;
}

.nav-inner {
  display: flex;

  justify-content: space-between;

  align-items: center;
}

.logo {
  font-size: 24px;

  font-weight: 900;
}

.logo b {
  color: #a855f7;
}

.links {
  display: flex;

  gap: 24px;
}

.links a {
  color: #cbd5e1;

  text-decoration: none;
}

/* HERO */

.hero {
  padding:
    65px 0
    35px;
}

.hero h1 {
  margin: 0;

  font-size:
    clamp(
      46px,
      7vw,
      78px
    );

  line-height: .98;

  letter-spacing: -4px;
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

  color: transparent;
}

.hero p {
  max-width: 650px;

  color: #9eabc0;

  font-size: 19px;

  line-height: 1.6;
}

.primary {
  padding:
    14px 20px;

  border: 0;

  border-radius: 12px;

  color: white;

  font-weight: 800;

  background:
    linear-gradient(
      90deg,
      #d946ef,
      #7c3aed
    );
}

/* APP */

.app {
  margin-bottom: 60px;

  overflow: hidden;

  border:
    1px solid #25304a;

  border-radius: 20px;

  background: #080f20;
}

.tabs {
  display: flex;

  gap: 10px;

  padding: 14px;

  border-bottom:
    1px solid #202b42;
}

.tab {
  flex: 1;

  padding: 13px;

  border:
    1px solid #27334d;

  border-radius: 12px;

  background: #0c1426;

  color: #aeb9ce;

  font-weight: 800;
}

.tab.active {
  border-color: transparent;

  background:
    linear-gradient(
      90deg,
      #a855f7,
      #6366f1
    );

  color: white;
}

.grid {
  display: grid;

  grid-template-columns:
    280px 1fr;
}

/* SIDEBAR */

.sidebar {
  padding: 20px;

  border-right:
    1px solid #202b42;
}

.preference {
  margin: 18px 0;
}

.label {
  margin-bottom: 8px;

  color: #aab5ca;
}

.choice {
  display: flex;
}

.choice button {
  flex: 1;

  padding: 10px;

  border:
    1px solid #27334d;

  background: #111a2d;

  color: white;
}

.choice button.selected {
  background: #7c3aed;
}

.select {
  width: 100%;

  padding: 12px;

  border:
    1px solid #27334d;

  border-radius: 10px;

  background: #111a2d;

  color: white;
}

.save {
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

.hint {
  margin-top: 22px;

  color: #94a3b8;

  line-height: 1.7;
}

/* CHAT PANEL */

.panel {
  min-height: 650px;

  display: flex;

  flex-direction: column;
}

.header {
  padding: 18px 20px;

  display: flex;

  justify-content: space-between;

  align-items: center;

  gap: 12px;

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

.report {
  padding:
    9px 14px;

  border:
    1px solid #6b2737;

  border-radius: 20px;

  background: transparent;

  color: #fb7185;
}

/* VIDEO */

.video {
  display: none;

  padding: 16px;
}

.video.show {
  display: block;
}

.video-box {
  position: relative;

  height: 450px;

  overflow: hidden;

  border:
    1px solid #27334d;

  border-radius: 16px;

  background: #020617;
}

#remoteVideo {
  width: 100%;

  height: 100%;

  object-fit: cover;
}

#localVideo {
  position: absolute;

  right: 14px;

  bottom: 14px;

  width: 145px;

  height: 115px;

  object-fit: cover;

  border:
    2px solid #7c3aed;

  border-radius: 13px;

  background: #000;
}

.placeholder {
  position: absolute;

  inset: 0;

  display: grid;

  place-items: center;

  text-align: center;

  color: #94a3b8;
}

.video-controls {
  display: none;

  gap: 10px;

  padding: 12px 0;
}

.video-controls.show {
  display: flex;
}

.control {
  flex: 1;

  padding: 11px;

  border:
    1px solid #27334d;

  border-radius: 12px;

  background: #111a2d;

  color: white;
}

/* MESSAGES */

.messages {
  flex: 1;

  min-height: 230px;

  max-height: 360px;

  overflow-y: auto;

  padding: 20px;

  display: flex;

  flex-direction: column;

  gap: 10px;
}

.message {
  max-width: 78%;

  padding:
    11px 15px;

  border-radius: 15px;

  line-height: 1.45;
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

/* COMPOSER */

.composer {
  display: flex;

  gap: 9px;

  padding:
    0 18px
    16px;
}

.composer input {
  flex: 1;

  min-width: 0;

  padding:
    13px 17px;

  border:
    1px solid #34415d;

  border-radius: 24px;

  outline: none;

  background: #0c1426;

  color: white;
}

.send {
  width: 50px;

  height: 50px;

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

/* ACTIONS */

.actions {
  display: grid;

  grid-template-columns:
    1fr 2fr;

  gap: 10px;

  padding: 16px;

  border-top:
    1px solid #202b42;
}

.end,
.next {
  padding: 13px;

  border-radius: 12px;

  font-weight: 800;
}

.end {
  border:
    1px solid #202b42;

  background: #0b1222;

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

/* REPORT MODAL */

.modal {
  position: fixed;

  inset: 0;

  display: none;

  align-items: center;

  justify-content: center;

  padding: 20px;

  background:
    rgba(0,0,0,.75);

  z-index: 50;
}

.modal.show {
  display: flex;
}

.modal-box {
  width:
    min(
      430px,
      100%
    );

  padding: 22px;

  border:
    1px solid #34415d;

  border-radius: 18px;

  background: #0b1222;
}

.modal-box select,
.modal-box textarea {
  width: 100%;

  margin:
    8px 0;

  padding: 12px;

  border:
    1px solid #34415d;

  border-radius: 10px;

  background: #111a2d;

  color: white;
}

.modal-buttons {
  display: flex;

  gap: 10px;

  margin-top: 8px;
}

.modal-buttons button {
  flex: 1;

  padding: 12px;

  border: 0;

  border-radius: 10px;
}

.cancel {
  background: #182238;

  color: white;
}

.submit-report {
  background: #dc2626;

  color: white;
}

/* MOBILE */

@media(max-width:800px) {

  .links {
    display: none;
  }

  .grid {
    grid-template-columns: 1fr;
  }

  .sidebar {
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

    height: 145px;
  }

  .message {
    max-width: 88%;
  }

}

</style>

</head>

<body>

<header class="nav">

<div class="wrap nav-inner">

<div class="logo">
💬 Random<b>Talk</b>
</div>

<nav class="links">

<a href="#top">
Home
</a>

<a href="#chat">
Chat
</a>

<a href="#safety">
Safety
</a>

</nav>

</div>

</header>


<main
  id="top"
  class="wrap"
>

<section class="hero">

<h1>

Talk to<br>

someone
<span class="gradient">
new.
</span>

</h1>

<p>

Meet random people through
text or video chat.
Choose your matching
preferences and connect
with an available stranger.

</p>

<button
class="primary"
onclick="startHero()"
>

🚀 Start Chatting

</button>

</section>


<section
id="chat"
class="app"
>

<div class="tabs">

<button
id="textTab"
class="tab active"
onclick="setMode('text')"
>

💬 Text Chat

</button>

<button
id="videoTab"
class="tab"
onclick="setMode('video')"
>

🎥 Video Chat

</button>

</div>


<div class="grid">


<aside class="sidebar">

<h3>
⚙️ Preferences
</h3>


<div class="preference">

<div class="label">
Chat with
</div>

<div class="choice">

<button
id="everyoneBtn"
class="selected"
onclick="setChatWith('everyone')"
>
Everyone
</button>

<button
id="genderBtn"
onclick="setChatWith('gender')"
>
Gender
</button>

</div>

</div>


<div
id="genderPrefs"
style="display:none"
>

<div class="preference">

<div class="label">
My gender
</div>

<select
id="myGender"
class="select"
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


<div class="preference">

<div class="label">
I want to chat with
</div>

<select
id="preferredGender"
class="select"
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

</div>


<div class="preference">

<div class="label">
Country
</div>

<select
id="country"
class="select"
>

<option value="any">
Any country
</option>

<option value="india">
India 🇮🇳
</option>

<option value="usa">
United States 🇺🇸
</option>

<option value="uk">
United Kingdom 🇬🇧
</option>

<option value="canada">
Canada 🇨🇦
</option>

<option value="australia">
Australia 🇦🇺
</option>

<option value="other">
Other
</option>

</select>

</div>


<button
class="save"
onclick="savePrefs()"
>

✨ Save Preferences

</button>


<div
id="safety"
class="hint"
>

<b>
Safety
</b>

<br>

• Be respectful
<br>

• Don't share personal information
<br>

• Report inappropriate users
<br>

• Leave anytime

</div>

</aside>


<section class="panel">


<div class="header">

<div>

<div
id="status"
class="status"
>

● Ready

</div>

<small
id="statusText"
>

Choose Text or Video
and press Start Chatting.

</small>

</div>


<button
class="report"
onclick="openReport()"
>

⚠ Report

</button>

</div>


<!-- VIDEO -->

<div
id="videoArea"
class="video"
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
class="placeholder"
>

<div>

<div
style="font-size:55px"
>
🎥
</div>

<div
id="videoPlaceholderText"
>

Waiting for video...

</div>

</div>

</div>

</div>


<div
id="videoControls"
class="video-controls"
>

<button
id="cameraButton"
class="control"
onclick="toggleCamera()"
>

📷 Camera On

</button>

<button
id="microphoneButton"
class="control"
onclick="toggleMicrophone()"
>

🎤 Microphone On

</button>

</div>

</div>


<!-- MESSAGES -->

<div
id="messages"
class="messages"
>

<div class="message received">

👋 Welcome to RandomTalk!

</div>

<div class="message received">

Press Start Chatting to find someone.

</div>

</div>


<!-- COMPOSER -->

<div class="composer">

<input
id="messageInput"
disabled
placeholder="Start a chat first..."
onkeydown="handleEnter(event)"
>

<button
class="send"
onclick="sendMessage()"
>

➤

</button>

</div>


<!-- ACTIONS -->

<div class="actions">

<button
class="end"
onclick="endChat()"
>

⏹ End Chat

</button>

<button
id="nextButton"
class="next"
onclick="startOrNext()"
>

🚀 Start Chatting

</button>

</div>


</section>

</div>

</section>

</main>


<!-- REPORT MODAL -->

<div
id="reportModal"
class="modal"
>

<div class="modal-box">

<h2>
⚠ Report User
</h2>

<p
style="color:#94a3b8"
>

Tell us what happened.

</p>


<select
id="reportReason"
>

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

/* =========================================================
   STATE
========================================================= */

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


/* =========================================================
   WEBRTC
========================================================= */

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


/* =========================================================
   HELPER
========================================================= */

function $(id) {

  return document.getElementById(id);

}


/* =========================================================
   MODE
========================================================= */

function setMode(mode) {

  currentMode = mode;

  $("textTab")
    .classList.toggle(
      "active",
      mode === "text"
    );

  $("videoTab")
    .classList.toggle(
      "active",
      mode === "video"
    );

  $("videoArea")
    .classList.toggle(
      "show",
      mode === "video"
    );

  $("videoControls")
    .classList.toggle(
      "show",
      mode === "video"
    );
}


/* =========================================================
   GENDER
========================================================= */

function setChatWith(value) {

  currentChatWith = value;

  $("everyoneBtn")
    .classList.toggle(
      "selected",
      value === "everyone"
    );

  $("genderBtn")
    .classList.toggle(
      "selected",
      value === "gender"
    );

  $("genderPrefs").style.display =
    value === "gender"
      ? "block"
      : "none";
}


/* =========================================================
   STATUS
========================================================= */

function updateStatus(
  title,
  text,
  connectedState
) {

  $("status").textContent =
    title;

  $("statusText").textContent =
    text;

  $("status")
    .classList.toggle(
      "connected",
      connectedState
    );
}


function setButton(text) {

  $("nextButton").textContent =
    text;
}


/* =========================================================
   MESSAGES
========================================================= */

function addMessage(
  text,
  type = "received"
) {

  const div =
    document.createElement(
      "div"
    );

  div.className =
    "message " + type;

  div.textContent =
    text;

  $("messages")
    .appendChild(div);

  $("messages").scrollTop =
    $("messages").scrollHeight;
}


function clearMessages() {

  $("messages").innerHTML = "";

}


/* =========================================================
   INPUT
========================================================= */

function enableInput() {

  $("messageInput").disabled =
    false;

  $("messageInput").placeholder =
    "Type a message...";
}


function disableInput() {

  $("messageInput").disabled =
    true;

  $("messageInput").placeholder =
    "Waiting for a stranger...";
}


/* =========================================================
   WEBSOCKET
========================================================= */

function connectSocket() {

  if (
    socket &&
    (
      socket.readyState ===
        WebSocket.OPEN ||

      socket.readyState ===
        WebSocket.CONNECTING
    )
  ) {

    return;
  }


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
    function() {

      const gender =
        $("myGender").value;

      const preferredGender =
        $("preferredGender").value;

      const country =
        $("country").value;


      updateStatus(
        "● Searching...",
        "Looking for a compatible stranger...",
        false
      );


      setButton(
        "⏳ Searching..."
      );


      socket.send(
        JSON.stringify({

          type: "join",

          mode:
            currentMode,

          chatWith:
            currentChatWith,

          gender:
            gender,

          preferredGender:
            currentChatWith ===
            "gender"
              ? preferredGender
              : "any",

          country:
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

        data =
          JSON.parse(
            event.data
          );

      } catch {

        return;
      }


      /* WAITING */

      if (
        data.type === "waiting"
      ) {

        connected = false;

        disableInput();

        updateStatus(
          "● Searching...",
          "Waiting for a compatible stranger...",
          false
        );

        setButton(
          "⏳ Searching..."
        );

        return;
      }


      /* MATCHED */

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


        enableInput();

        setButton(
          "⏭ Next"
        );


        updateStatus(
          "● Connected",
          currentMode === "video"
            ? "Starting video..."
            : "You are chatting with a stranger.",
          true
        );


        addMessage(
          "🎉 Connected! Say hello."
        );


        if (
          currentMode === "video"
        ) {

          setMode("video");

          try {

            await startLocalMedia();

            await createPeerConnection();

            if (isInitiator) {

              await createOffer();

            }

          } catch (error) {

            console.error(
              "Camera error:",
              error
            );

            addMessage(
              "⚠️ Camera/microphone permission was not granted."
            );

          }

        }

        return;
      }


      /* CHAT */

      if (
        data.type === "chat"
      ) {

        addMessage(
          data.text,
          "received"
        );

        return;
      }


      /* SIGNAL */

      if (
        data.type === "signal"
      ) {

        try {

          await handleSignal(
            data.signal
          );

        } catch (error) {

          console.error(
            "Signal error:",
            error
          );

        }

        return;
      }


      /* PARTNER LEFT */

      if (
        data.type ===
        "partner_left"
      ) {

        connected = false;

        closePeerConnection();

        disableInput();

        updateStatus(
          "● Stranger left",
          "Searching for another compatible person...",
          false
        );

        setButton(
          "⏳ Searching..."
        );

        addMessage(
          "👋 Stranger left. Searching..."
        );

        return;
      }


      /* REPORT */

      if (
        data.type ===
        "report_success"
      ) {

        closeReport();

        alert(
          "✅ Report submitted successfully."
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

      disableInput();

      updateStatus(
        "● Disconnected",
        "Press Start Chatting.",
        false
      );

      setButton(
        "🚀 Start Chatting"
      );

    }
  );


  socket.addEventListener(
    "error",
    function() {

      updateStatus(
        "● Connection error",
        "Please try again.",
        false
      );

    }
  );

}


/* =========================================================
   CAMERA
========================================================= */

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
    await navigator.mediaDevices
      .getUserMedia({

        video: {
          facingMode: "user"
        },

        audio: true

      });


  $("localVideo").srcObject =
    localStream;

  $("localVideo").muted =
    true;


  await $("localVideo")
    .play()
    .catch(
      function() {}
    );


  cameraEnabled = true;

  microphoneEnabled = true;

  updateVideoButtons();


  return localStream;
}


/* =========================================================
   PEER CONNECTION
========================================================= */

async function createPeerConnection() {

  if (peerConnection) {

    return peerConnection;

  }


  peerConnection =
    new RTCPeerConnection(
      rtcConfig
    );


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


      $("remoteVideo").srcObject =
        event.streams[0];


      $("remoteVideo")
        .play()
        .catch(
          function() {}
        );


      $("videoPlaceholder")
        .style.display =
        "none";


      updateStatus(
        "● Connected",
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

            candidate:
              event.candidate

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
        peerConnection
          .connectionState;


      console.log(
        "WebRTC:",
        state
      );


      if (
        state === "connected"
      ) {

        $("videoPlaceholder")
          .style.display =
          "none";


        updateStatus(
          "● Connected",
          "You are on a video call.",
          true
        );

      }


      if (
        state === "failed"
      ) {

        $("videoPlaceholder")
          .style.display =
          "grid";


        $("videoPlaceholderText")
          .textContent =
          "Video connection failed. Try Next.";

      }

    }
  );


  return peerConnection;
}


/* =========================================================
   OFFER
========================================================= */

async function createOffer() {

  if (!peerConnection) {

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
    socket.readyState ===
      WebSocket.OPEN
  ) {

    socket.send(
      JSON.stringify({

        type: "signal",

        signal: {

          type: "offer",

          sdp: offer

        }

      })
    );

  }
}


/* =========================================================
   SIGNAL
========================================================= */

async function handleSignal(
  signal
) {

  if (!signal) {

    return;

  }


  if (!peerConnection) {

    await startLocalMedia();

    await createPeerConnection();

  }


  if (
    signal.type ===
    "offer"
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

        type: "signal",

        signal: {

          type: "answer",

          sdp: answer

        }

      })
    );


    return;
  }


  if (
    signal.type ===
    "answer"
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


  if (
    signal.type ===
      "ice" &&
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
          "ICE error:",
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


/* =========================================================
   ICE QUEUE
========================================================= */

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
        "ICE queue error:",
        error
      );

    }

  }

}


/* =========================================================
   CLOSE VIDEO
========================================================= */

function closePeerConnection() {

  pendingIceCandidates = [];


  if (peerConnection) {

    try {

      peerConnection.close();

    } catch {}

    peerConnection = null;

  }


  $("remoteVideo").srcObject =
    null;


  $("videoPlaceholder")
    .style.display =
    "grid";


  $("videoPlaceholderText")
    .textContent =
    "Waiting for video...";

}


/* =========================================================
   CAMERA CONTROLS
========================================================= */

function toggleCamera() {

  if (!localStream) {

    return;

  }


  const tracks =
    localStream
      .getVideoTracks();


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
    localStream
      .getAudioTracks();


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

  $("cameraButton")
    .textContent =
    cameraEnabled
      ? "📷 Camera On"
      : "📷 Camera Off";


  $("microphoneButton")
    .textContent =
    microphoneEnabled
      ? "🎤 Microphone On"
      : "🔇 Microphone Off";

}


/* =========================================================
   START / NEXT
========================================================= */

function startHero() {

  $("chat")
    .scrollIntoView({
      behavior: "smooth"
    });


  setTimeout(
    function() {

      startOrNext();

    },
    400
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

    disableInput();


    updateStatus(
      "● Searching...",
      "Finding another compatible person...",
      false
    );


    setButton(
      "⏳ Searching..."
    );


    return;
  }


  if (
    !socket ||
    socket.readyState !==
      WebSocket.OPEN
  ) {

    connectSocket();

  }

}


/* =========================================================
   CHAT
========================================================= */

function sendMessage() {

  const input =
    $("messageInput");


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


  addMessage(
    text,
    "sent"
  );


  input.value = "";

}


function handleEnter(event) {

  if (
    event.key ===
    "Enter"
  ) {

    event.preventDefault();

    sendMessage();

  }

}


/* =========================================================
   END CHAT
========================================================= */

function endChat() {

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

  disableInput();


  updateStatus(
    "● Offline",
    "Chat ended.",
    false
  );


  setButton(
    "🚀 Start Chatting"
  );


  addMessage(
    "Chat ended."
  );

}


/* =========================================================
   REPORT
========================================================= */

function openReport() {

  if (!connected) {

    alert(
      "You are not currently connected."
    );

    return;

  }


  $("reportModal")
    .classList.add(
      "show"
    );

}


function closeReport() {

  $("reportModal")
    .classList.remove(
      "show"
    );

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
    $("reportReason").value;


  const details =
    $("reportDetails").value;


  socket.send(
    JSON.stringify({

      type: "report",

      reason,

      details

    })
  );

}


/* =========================================================
   PREFERENCES
========================================================= */

function savePrefs() {

  localStorage.setItem(
    "randomtalk_country",
    $("country").value
  );


  localStorage.setItem(
    "randomtalk_gender",
    $("myGender").value
  );


  localStorage.setItem(
    "randomtalk_preferred_gender",
    $("preferredGender").value
  );


  alert(
    "✅ Preferences saved."
  );

}


/* =========================================================
   LOAD
========================================================= */

window.addEventListener(
  "load",
  function() {

    setMode("text");


    const country =
      localStorage.getItem(
        "randomtalk_country"
      );


    const gender =
      localStorage.getItem(
        "randomtalk_gender"
      );


    const preferred =
      localStorage.getItem(
        "randomtalk_preferred_gender"
      );


    if (country) {

      $("country").value =
        country;

    }


    if (gender) {

      $("myGender").value =
        gender;

    }


    if (preferred) {

      $("preferredGender").value =
        preferred;

    }

  }
);

</script>

</body>

</html>`;
