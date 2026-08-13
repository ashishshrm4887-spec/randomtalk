import { DurableObject } from "cloudflare:workers";

/* =========================================================
   RANDOMTALK
   Text + Video + Random Matching + Gender + Country
   Reports + Preferences + 18+ Safety Gate
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

  findSocketById(id) {
    if (!id) return null;

    for (const ws of this.ctx.getWebSockets()) {
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

    /* COUNTRY */

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

    /* GENDER */

    if (
      a.chatWith === "gender" &&
      a.preferredGender !== "any" &&
      a.preferredGender !== b.gender
    ) {
      return false;
    }

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

      if (other === ws) continue;

      if (other.readyState !== WebSocket.OPEN) {
        continue;
      }

      const otherInfo = this.getInfo(other);

      if (this.canMatch(user, otherInfo)) {
        return other;
      }
    }

    return null;
  }

  matchUsers(a, b) {

    const aInfo = this.getInfo(a);
    const bInfo = this.getInfo(b);

    this.setInfo(a, {
      ...aInfo,
      status: "matched",
      partnerId: bInfo.id
    });

    this.setInfo(b, {
      ...bInfo,
      status: "matched",
      partnerId: aInfo.id
    });

    this.send(a, {
      type: "matched",
      mode: aInfo.mode,
      initiator: false
    });

    this.send(b, {
      type: "matched",
      mode: bInfo.mode,
      initiator: true
    });
  }

  tryMatch(ws) {

    if (!ws) return;

    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const info = this.getInfo(ws);

    if (info.status !== "waiting") {
      return;
    }

    const other = this.findMatch(ws);

    if (!other) {
      this.send(ws, {
        type: "waiting",
        mode: info.mode
      });

      return;
    }

    this.matchUsers(ws, other);
  }

  async fetch(request) {

    if (
      request.headers.get("Upgrade")?.toLowerCase() !==
      "websocket"
    ) {

      return new Response(
        "RandomTalk ChatRoom is running.",
        {
          status: 200
        }
      );
    }

    const pair = new WebSocketPair();

    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);

    this.setInfo(server, {

      id: crypto.randomUUID(),

      status: "idle",

      mode: "text",

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
        ["male", "female", "other"].includes(
          data.gender
        )
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

        chatWith,

        gender,

        preferredGender,

        country,

        status: "waiting",

        partnerId: null

      };

      this.setInfo(ws, info);

      this.tryMatch(ws);

      return;
    }


    const info = this.getInfo(ws);


    /* =====================================================
       CHAT
    ===================================================== */

    if (data.type === "chat") {

      if (
        info.status !== "matched" ||
        !info.partnerId
      ) {
        return;
      }

      const partner =
        this.findSocketById(
          info.partnerId
        );

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


    /* =====================================================
       WEBRTC SIGNAL
    ===================================================== */

    if (data.type === "signal") {

      if (!info.partnerId) {
        return;
      }

      const partner =
        this.findSocketById(
          info.partnerId
        );

      if (!partner) return;

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

      const oldPartner =
        info.partnerId
          ? this.findSocketById(
              info.partnerId
            )
          : null;


      if (oldPartner) {

        const partnerInfo =
          this.getInfo(oldPartner);

        this.setInfo(oldPartner, {
          ...partnerInfo,

          status: "waiting",

          partnerId: null

        });

        this.send(oldPartner, {
          type: "partner_left"
        });

        this.send(oldPartner, {
          type: "waiting",
          mode: partnerInfo.mode
        });

        this.tryMatch(oldPartner);
      }


      this.setInfo(ws, {
        ...info,

        status: "waiting",

        partnerId: null

      });

      this.send(ws, {
        type: "waiting",
        mode: info.mode
      });

      this.tryMatch(ws);

      return;
    }


    /* =====================================================
       END
    ===================================================== */

    if (data.type === "end") {

      const partner =
        info.partnerId
          ? this.findSocketById(
              info.partnerId
            )
          : null;

      if (partner) {

        const partnerInfo =
          this.getInfo(partner);

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


    /* =====================================================
       REPORT
    ===================================================== */

    if (data.type === "report") {

      const report = {

        id: crypto.randomUUID(),

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


      const newCount =
        Number(oldCount || 0) + 1;


      await this.ctx.storage.put(
        "report_count",
        newCount
      );


      this.send(ws, {
        type: "report_success"
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


  async webSocketClose(ws) {

    const info =
      this.getInfo(ws);

    if (!info.partnerId) {
      return;
    }

    const partner =
      this.findSocketById(
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

    this.tryMatch(partner);
  }


  async webSocketError(ws) {

    await this.webSocketClose(ws);
  }
}


/* =========================================================
   WEBSITE
========================================================= */

const HTML_PAGE = `<!DOCTYPE html>

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
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;

  background:
    radial-gradient(
      circle at 80% 10%,
      rgba(124,58,237,.22),
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
    Arial,
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

.container {
  width:
    min(
      1150px,
      calc(100% - 30px)
    );

  margin: auto;
}


/* NAV */

.navbar {
  height: 72px;

  border-bottom:
    1px solid
    rgba(148,163,184,.12);

  display: flex;

  align-items: center;
}

.nav-inner {
  width:
    min(
      1150px,
      calc(100% - 30px)
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


/* HERO */

.hero {
  padding: 65px 0 40px;
}

.hero h1 {
  margin: 0;

  font-size:
    clamp(
      45px,
      8vw,
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

  color: transparent;
}

.hero p {
  max-width: 600px;

  color: #aab5ca;

  font-size: 20px;

  line-height: 1.6;
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
  background: transparent;

  color: white;

  border:
    1px solid #34415d;
}


/* APP */

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

  padding: 15px;

  border-bottom:
    1px solid #202b42;
}

.tab {
  flex: 1;

  padding: 14px;

  border-radius: 12px;

  background: transparent;

  color: #aeb9ce;

  border:
    1px solid #26324b;

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

  grid-template-columns:
    270px 1fr;
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

  margin-bottom: 8px;
}

.preference-buttons {
  display: flex;
}

.preference-buttons button {
  width: 50%;

  padding: 10px;

  background: #111a2d;

  color: white;

  border:
    1px solid #27334d;
}

.preference-buttons button.selected {
  background: #7c3aed;
}

.select-box {
  width: 100%;

  padding: 12px;

  border-radius: 10px;

  background: #111a2d;

  color: white;

  border:
    1px solid #27334d;
}

.save-btn {
  width: 100%;

  padding: 13px;

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


/* CHAT */

.chat-panel {
  min-height: 620px;

  display: flex;

  flex-direction: column;
}

.chat-header {
  padding: 20px;

  display: flex;

  align-items: center;

  justify-content: space-between;

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
  padding: 9px 14px;

  border-radius: 20px;

  border:
    1px solid #6b2737;

  background: transparent;

  color: #fb7185;
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

  height: 470px;

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
}

.video-placeholder {
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

  padding: 12px 18px;
}

.video-controls.show {
  display: flex;
}

.control-btn {
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

  max-height: 400px;

  overflow-y: auto;

  padding: 22px;

  display: flex;

  flex-direction: column;

  gap: 12px;
}

.message {
  max-width: 75%;

  padding: 12px 16px;

  border-radius: 16px;

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

.message-input {
  display: flex;

  gap: 10px;

  padding:
    0 20px 18px;
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

.send-btn {
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

.chat-actions {
  display: grid;

  grid-template-columns:
    1fr 2fr;

  gap: 12px;

  padding: 18px;

  border-top:
    1px solid #202b42;
}

.end-btn,
.next-btn {
  padding: 14px;

  border-radius: 12px;

  font-weight: 800;
}

.end-btn {
  background: #0b1222;

  border:
    1px solid #202b42;

  color: #fb7185;
}

.next-btn {
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

  z-index: 10000;

  display: none;

  align-items: center;

  justify-content: center;

  padding: 20px;

  background: rgba(0,0,0,.78);
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

  padding: 25px;

  border-radius: 18px;

  border:
    1px solid #34415d;

  background: #0b1222;
}

.modal-box select,
.modal-box textarea {
  width: 100%;

  padding: 12px;

  margin-bottom: 12px;

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

  border: 0;

  border-radius: 10px;
}

.cancel-btn {
  background: #182238;

  color: white;
}

.submit-btn {
  background: #dc2626;

  color: white;
}


/* AGE GATE */

.age-gate {
  position: fixed;

  inset: 0;

  z-index: 99999;

  display: flex;

  align-items: center;

  justify-content: center;

  padding: 20px;

  background:
    rgba(3,7,18,.98);
}

.age-gate.hidden {
  display: none;
}

.age-box {
  width:
    min(
      450px,
      100%
    );

  padding: 30px;

  text-align: center;

  border-radius: 22px;

  border:
    1px solid #34415d;

  background: #0b1222;
}

.age-icon {
  font-size: 55px;
}

.age-box p {
  color: #aab5ca;

  line-height: 1.6;
}

.age-enter,
.age-leave {
  width: 100%;

  padding: 14px;

  margin-top: 10px;

  border-radius: 11px;

  font-weight: 800;
}

.age-enter {
  border: 0;

  color: white;

  background:
    linear-gradient(
      90deg,
      #d946ef,
      #7c3aed
    );
}

.age-leave {
  border:
    1px solid #34415d;

  background: #111a2d;

  color: white;
}


/* MOBILE */

@media(max-width:800px) {

  .layout {
    grid-template-columns: 1fr;
  }

  .sidebar {
    border-right: 0;

    border-bottom:
      1px solid #202b42;
  }

  .chat-actions {
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
}

</style>

</head>


<body>


<!-- =====================================================
     18+ GATE
===================================================== -->

<div
  id="ageGate"
  class="age-gate"
>

  <div class="age-box">

    <div class="age-icon">
      🔞
    </div>

    <h2>
      RandomTalk is 18+
    </h2>

    <p>
      RandomTalk connects you with strangers.
      Never share your address, phone number,
      passwords, financial information, or other
      private information.
    </p>

    <button
      class="age-enter"
      onclick="enterSite()"
    >
      I am 18 or older — Enter
    </button>

    <button
      class="age-leave"
      onclick="leaveSite()"
    >
      Leave
    </button>

  </div>

</div>


<!-- =====================================================
     NAV
===================================================== -->

<header class="navbar">

  <div class="nav-inner">

    <div class="logo">
      💬 Random<span>Talk</span>
    </div>

  </div>

</header>


<main>


<!-- HERO -->

<section class="hero container">

  <h1>
    Talk to someone
    <span class="gradient">
      new.
    </span>
  </h1>

  <p>
    Meet random people through
    text or video chat.
  </p>

  <button
    class="primary"
    onclick="startFromHero()"
  >
    🚀 Start Chatting
  </button>

</section>


<!-- CHAT APP -->

<section
  id="chat"
  class="container"
>

<div class="chat-app">


<!-- TABS -->

<div class="tabs">

<button
  id="textTab"
  class="tab active"
  onclick="selectText()"
>
  💬 Text Chat
</button>

<button
  id="videoTab"
  class="tab"
  onclick="selectVideo()"
>
  🎥 Video Chat
</button>

</div>


<div class="layout">


<!-- SIDEBAR -->

<aside class="sidebar">

<h3>
  ⚙️ Preferences
</h3>


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
  id="genderSettings"
  style="display:none"
>

<div class="preference">

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


<div class="preference">

<div class="preference-title">
  Preferred gender
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

</select>

</div>


<button
  class="save-btn"
  onclick="savePreferences()"
>
  ✨ Save Preferences
</button>


<p
  style="
    color:#94a3b8;
    line-height:1.7;
  "
>
  <b>Safety</b><br>
  • Be respectful<br>
  • Don't share personal information<br>
  • Report inappropriate users<br>
  • Leave anytime
</p>

</aside>


<!-- CHAT PANEL -->

<section class="chat-panel">


<div class="chat-header">

<div>

<div
  id="connectionStatus"
  class="status"
>
  ● Ready
</div>

<small
  id="connectionText"
>
  Press Start Chatting.
</small>

</div>


<button
  class="report-btn"
  onclick="openReport()"
>
  ⚠ Report
</button>

</div>


<!-- VIDEO -->

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

<div
  id="videoPlaceholder"
  class="video-placeholder"
>

<div>

<div style="font-size:55px">
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

</div>


<!-- VIDEO CONTROLS -->

<div
  id="videoControls"
  class="video-controls"
>

<button
  class="control-btn"
  onclick="toggleCamera()"
>
  📷 Camera On
</button>

<button
  class="control-btn"
  onclick="toggleMicrophone()"
>
  🎤 Microphone On
</button>

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
  Choose Text or Video and press Start Chatting.
</div>

</div>


<!-- INPUT -->

<div class="message-input">

<input
  id="messageInput"
  type="text"
  placeholder="Start a chat first..."
  disabled
  onkeydown="handleEnter(event)"
>

<button
  class="send-btn"
  onclick="sendMessage()"
>
  ➤
</button>

</div>


<!-- ACTIONS -->

<div class="chat-actions">

<button
  class="end-btn"
  onclick="endChat()"
>
  ⏹ End Chat
</button>

<button
  id="startNextButton"
  class="next-btn"
  onclick="startOrNext()"
>
  🚀 Start Chatting
</button>

</div>


</section>

</div>

</div>

</section>

</main>


<!-- =====================================================
     REPORT MODAL
===================================================== -->

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
  class="cancel-btn"
  onclick="closeReport()"
>
  Cancel
</button>

<button
  class="submit-btn"
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
   ELEMENTS
========================================================= */

const textTab =
  document.getElementById("textTab");

const videoTab =
  document.getElementById("videoTab");

const videoArea =
  document.getElementById("videoArea");

const videoControls =
  document.getElementById("videoControls");

const remoteVideo =
  document.getElementById("remoteVideo");

const localVideo =
  document.getElementById("localVideo");

const videoPlaceholder =
  document.getElementById("videoPlaceholder");

const videoPlaceholderText =
  document.getElementById(
    "videoPlaceholderText"
  );

const messages =
  document.getElementById("messages");

const messageInput =
  document.getElementById("messageInput");

const connectionStatus =
  document.getElementById(
    "connectionStatus"
  );

const connectionText =
  document.getElementById(
    "connectionText"
  );

const startNextButton =
  document.getElementById(
    "startNextButton"
  );

const ageGate =
  document.getElementById("ageGate");

const genderSettings =
  document.getElementById(
    "genderSettings"
  );

const countrySelect =
  document.getElementById("country");

const myGenderSelect =
  document.getElementById("myGender");

const preferredGenderSelect =
  document.getElementById(
    "preferredGender"
  );


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
   AGE GATE
========================================================= */

function enterSite() {

  localStorage.setItem(
    "randomtalk_age_verified",
    "yes"
  );

  ageGate.classList.add("hidden");
}


function leaveSite() {

  document.body.innerHTML = `

<div
  style="
    min-height:100vh;
    display:grid;
    place-items:center;
    padding:30px;
    background:#050816;
    color:white;
    text-align:center;
    font-family:Arial,sans-serif;
  "
>

<div>

<h1>
  Thanks for visiting.
</h1>

<p style="color:#94a3b8">
  You must be 18 or older
  to use RandomTalk.
</p>

</div>

</div>

`;

}


/* =========================================================
   MODE
========================================================= */

function selectText() {

  currentMode = "text";

  textTab.classList.add("active");

  videoTab.classList.remove("active");

  videoArea.classList.remove("show");

  videoControls.classList.remove("show");
}


function selectVideo() {

  currentMode = "video";

  videoTab.classList.add("active");

  textTab.classList.remove("active");

  videoArea.classList.add("show");

  videoControls.classList.add("show");
}


/* =========================================================
   GENDER
========================================================= */

function chooseEveryone() {

  currentChatWith = "everyone";

  document
    .getElementById("everyoneBtn")
    .classList.add("selected");

  document
    .getElementById("genderBtn")
    .classList.remove("selected");

  genderSettings.style.display =
    "none";
}


function chooseGender() {

  currentChatWith = "gender";

  document
    .getElementById("genderBtn")
    .classList.add("selected");

  document
    .getElementById("everyoneBtn")
    .classList.remove("selected");

  genderSettings.style.display =
    "block";
}


/* =========================================================
   SOCKET
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

          mode: currentMode,

          chatWith:
            currentChatWith,

          gender:
            myGenderSelect.value,

          preferredGender:
            currentChatWith === "gender"
              ? preferredGenderSelect.value
              : "any",

          country:
            countrySelect.value

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
          JSON.parse(event.data);

      } catch {

        return;

      }


      /* WAITING */

      if (
        data.type === "waiting"
      ) {

        connected = false;

        updateStatus(
          "● Searching...",
          "Waiting for another compatible person...",
          false
        );

        disableInput();

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


        updateStatus(
          "● Connected",
          currentMode === "video"
            ? "Starting video..."
            : "You are chatting with a stranger.",
          true
        );


        enableInput();

        setButton(
          "⏭ Next"
        );


        addSystemMessage(
          "🎉 Connected! Say hello."
        );


        if (
          currentMode === "video"
        ) {

          selectVideo();


          try {

            await startLocalMedia();

            await createPeerConnection();


            if (isInitiator) {

              await createOffer();

            }

          } catch (error) {

            console.error(
              "Camera/microphone error:",
              error
            );


            addSystemMessage(
              "⚠️ Camera/microphone permission failed. Check your browser permissions."
            );

          }

        }

        return;
      }


      /* CHAT */

      if (
        data.type === "chat"
      ) {

        addReceivedMessage(
          data.text
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
            "WebRTC signal error:",
            error
          );

        }

        return;
      }


      /* PARTNER LEFT */

      if (
        data.type === "partner_left"
      ) {

        connected = false;

        closePeerConnection();

        disableInput();

        setButton(
          "⏳ Searching..."
        );


        updateStatus(
          "● Stranger left",
          "Searching for another compatible person...",
          false
        );


        addSystemMessage(
          "👋 Stranger left. Searching..."
        );

        return;
      }


      /* REPORT */

      if (
        data.type === "report_success"
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

      setButton(
        "🚀 Start Chatting"
      );


      updateStatus(
        "● Disconnected",
        "Press Start Chatting.",
        false
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
   CAMERA + MICROPHONE
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
    await navigator.mediaDevices.getUserMedia({

      video: {
        facingMode: "user"
      },

      audio: true

    });


  localVideo.srcObject =
    localStream;


  localVideo.muted = true;


  await localVideo
    .play()
    .catch(function(){});


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


      remoteVideo.srcObject =
        event.streams[0];


      remoteVideo
        .play()
        .catch(function(){});


      videoPlaceholder.style.display =
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


      if (
        peerConnection.connectionState ===
        "connected"
      ) {

        videoPlaceholder.style.display =
          "none";


        updateStatus(
          "● Connected",
          "You are on a video call.",
          true
        );

      }


      if (
        peerConnection.connectionState ===
        "failed"
      ) {

        videoPlaceholder.style.display =
          "grid";


        videoPlaceholderText.textContent =
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
    await peerConnection.createOffer();


  await peerConnection.setLocalDescription(
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

async function handleSignal(signal) {

  if (!signal) {
    return;
  }


  if (!peerConnection) {

    await startLocalMedia();

    await createPeerConnection();

  }


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
   ICE
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
        "Queued ICE error:",
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


  remoteVideo.srcObject =
    null;


  videoPlaceholder.style.display =
    "grid";


  videoPlaceholderText.textContent =
    "Waiting for video...";

}


/* =========================================================
   CAMERA
========================================================= */

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


/* =========================================================
   MICROPHONE
========================================================= */

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


/* =========================================================
   VIDEO BUTTONS
========================================================= */

function updateVideoButtons() {

  const buttons =
    document.querySelectorAll(
      ".control-btn"
    );


  if (buttons.length >= 2) {

    buttons[0].textContent =
      cameraEnabled
        ? "📷 Camera On"
        : "📷 Camera Off";


    buttons[1].textContent =
      microphoneEnabled
        ? "🎤 Microphone On"
        : "🔇 Microphone Off";

  }

}


/* =========================================================
   START
========================================================= */

function startFromHero() {

  document
    .getElementById("chat")
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


    updateStatus(
      "● Searching...",
      "Finding another compatible person...",
      false
    );


    disableInput();


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

  const text =
    messageInput.value.trim();


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


  messageInput.value =
    "";

}


function handleEnter(event) {

  if (
    event.key === "Enter"
  ) {

    event.preventDefault();

    sendMessage();

  }

}


/* =========================================================
   END
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


  addSystemMessage(
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


  document
    .getElementById("reportModal")
    .classList.add("show");

}


function closeReport() {

  document
    .getElementById("reportModal")
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
    document
      .getElementById(
        "reportReason"
      )
      .value;


  const details =
    document
      .getElementById(
        "reportDetails"
      )
      .value;


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

function savePreferences() {

  localStorage.setItem(
    "randomtalk_country",
    countrySelect.value
  );


  localStorage.setItem(
    "randomtalk_gender",
    myGenderSelect.value
  );


  localStorage.setItem(
    "randomtalk_preferred_gender",
    preferredGenderSelect.value
  );


  alert(
    "✅ Preferences saved."
  );

}


/* =========================================================
   UI
========================================================= */

function updateStatus(
  title,
  text,
  isConnected
) {

  connectionStatus.textContent =
    title;


  connectionText.textContent =
    text;


  if (isConnected) {

    connectionStatus.classList.add(
      "connected"
    );

  } else {

    connectionStatus.classList.remove(
      "connected"
    );

  }

}


function setButton(text) {

  startNextButton.textContent =
    text;

}


function enableInput() {

  messageInput.disabled =
    false;


  messageInput.placeholder =
    "Type a message...";

}


function disableInput() {

  messageInput.disabled =
    true;


  messageInput.placeholder =
    "Waiting for a stranger...";

}


function clearMessages() {

  messages.innerHTML =
    "";

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


  messages.appendChild(div);


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


  messages.appendChild(div);


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


  messages.appendChild(div);


  scrollMessages();

}


function scrollMessages() {

  messages.scrollTop =
    messages.scrollHeight;

}


/* =========================================================
   LOAD
========================================================= */

window.addEventListener(
  "load",
  function() {

    selectText();


    /* AGE */

    if (
      localStorage.getItem(
        "randomtalk_age_verified"
      ) === "yes"
    ) {

      ageGate.classList.add(
        "hidden"
      );

    }


    /* COUNTRY */

    const savedCountry =
      localStorage.getItem(
        "randomtalk_country"
      );


    if (savedCountry) {

      countrySelect.value =
        savedCountry;

    }


    /* GENDER */

    const savedGender =
      localStorage.getItem(
        "randomtalk_gender"
      );


    if (savedGender) {

      myGenderSelect.value =
        savedGender;

    }


    /* PREFERRED GENDER */

    const savedPreferred =
      localStorage.getItem(
        "randomtalk_preferred_gender"
      );


    if (savedPreferred) {

      preferredGenderSelect.value =
        savedPreferred;

    }

  }
);

</script>

</body>

</html>`;


/* =========================================================
   MAIN WORKER
========================================================= */

export default {

  async fetch(request, env) {

    const url =
      new URL(request.url);


    /* WEBSOCKET */

    if (
      url.pathname === "/ws"
    ) {

      if (
        request.headers
          .get("Upgrade")
          ?.toLowerCase() !==
        "websocket"
      ) {

        return new Response(
          "WebSocket upgrade required.",
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


      return room.fetch(
        request
      );

    }


    /* HEALTH */

    if (
      url.pathname === "/health"
    ) {

      return new Response(

        JSON.stringify({

          ok: true,

          service:
            "RandomTalk",

          time:
            new Date().toISOString()

        }),

        {
          headers: {
            "content-type":
              "application/json"
          }
        }

      );

    }


    /* WEBSITE */

    return new Response(
      HTML_PAGE,
      {
        headers: {
          "content-type":
            "text/html; charset=UTF-8"
        }
      }
    );

  }

};
