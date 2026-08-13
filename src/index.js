import { DurableObject } from "cloudflare:workers";

/* =========================================================
   RANDOMTALK
   Text + Video + Report + Gender + Country Matching
========================================================= */

export class ChatRoom extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);
  }

  /* =======================================================
     WEBSOCKET HELPERS
  ======================================================= */

  send(ws, data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    try {
      ws.send(JSON.stringify(data));
    } catch (e) {
      console.error("Send error:", e);
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

  getSockets() {
    return this.ctx.getWebSockets();
  }

  findSocketById(id) {
    if (!id) return null;

    for (const ws of this.getSockets()) {
      const info = this.getInfo(ws);

      if (info.id === id) {
        return ws;
      }
    }

    return null;
  }

  /* =======================================================
     MATCHING

     Rules:

     Everyone:
       Any available user with the same country filter.

     Gender:
       User chooses Male/Female/Other.
       The server checks both users' gender preferences.

     Country:
       "any" = any country.
       Specific country = same country only.
  ======================================================= */

  canMatch(a, b) {

    if (!a || !b) return false;

    if (a.status !== "waiting") return false;
    if (b.status !== "waiting") return false;

    if (a.mode !== b.mode) return false;

    /* User A country preference */
    if (
      a.country &&
      a.country !== "any" &&
      a.country !== b.country
    ) {
      return false;
    }

    /* User B country preference */
    if (
      b.country &&
      b.country !== "any" &&
      b.country !== a.country
    ) {
      return false;
    }

    /* User A gender preference */
    if (
      a.chatWith === "gender" &&
      a.preferredGender &&
      a.preferredGender !== "any" &&
      a.preferredGender !== b.gender
    ) {
      return false;
    }

    /* User B gender preference */
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

  /* =======================================================
     WEBSOCKET CONNECTION
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
      Cloudflare Durable Object Hibernation API
    */

    this.ctx.acceptWebSocket(server);

    const id = crypto.randomUUID();

    this.setInfo(server, {
      id,
      mode: "text",
      status: "idle",

      /* Matching preferences */
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

      const other = this.findMatch(ws);

      if (!other) {

        this.send(ws, {
          type: "waiting",
          mode
        });

        return;
      }

      const otherInfo = this.getInfo(other);

      this.setInfo(ws, {
        ...info,
        status: "matched",
        partnerId: otherInfo.id
      });

      this.setInfo(other, {
        ...otherInfo,
        status: "matched",
        partnerId: info.id
      });

      this.send(ws, {
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

    /* =====================================================
       CHAT
    ===================================================== */

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

    /* =====================================================
       WEBRTC SIGNAL
    ===================================================== */

    if (data.type === "signal") {

      const info = this.getInfo(ws);

      if (!info.partnerId) return;

      const partner =
        this.findSocketById(info.partnerId);

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

      const info = this.getInfo(ws);

      const partner =
        info.partnerId
          ? this.findSocketById(info.partnerId)
          : null;

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

        /*
          Try to match the partner again.
        */

        const newPartner =
          this.findMatch(partner);

        if (newPartner) {

          const newInfo =
            this.getInfo(newPartner);

          this.setInfo(partner, {
            ...partnerInfo,
            status: "matched",
            partnerId: newInfo.id
          });

          this.setInfo(newPartner, {
            ...newInfo,
            status: "matched",
            partnerId: partnerInfo.id
          });

          this.send(partner, {
            type: "matched",
            mode: partnerInfo.mode,
            initiator: false
          });

          this.send(newPartner, {
            type: "matched",
            mode: newInfo.mode,
            initiator: true
          });

        }
      }

      this.setInfo(ws, {
        ...info,
        status: "waiting",
        partnerId: null
      });

      const match =
        this.findMatch(ws);

      if (match) {

        const matchInfo =
          this.getInfo(match);

        this.setInfo(ws, {
          ...info,
          status: "matched",
          partnerId: matchInfo.id
        });

        this.setInfo(match, {
          ...matchInfo,
          status: "matched",
          partnerId: info.id
        });

        this.send(ws, {
          type: "matched",
          mode: info.mode,
          initiator: false
        });

        this.send(match, {
          type: "matched",
          mode: matchInfo.mode,
          initiator: true
        });

      } else {

        this.send(ws, {
          type: "waiting",
          mode: info.mode
        });

      }

      return;
    }

    /* =====================================================
       END
    ===================================================== */

    if (data.type === "end") {

      const info = this.getInfo(ws);

      const partner =
        info.partnerId
          ? this.findSocketById(info.partnerId)
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

      const info = this.getInfo(ws);

      const reason =
        String(data.reason || "Other")
          .slice(0, 100);

      const details =
        String(data.details || "")
          .slice(0, 500);

      const report = {

        id: crypto.randomUUID(),

        createdAt:
          new Date().toISOString(),

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
     SAVE REPORT
  ======================================================= */

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
      "Report saved:",
      report.id
    );
  }

  /* =======================================================
     CLOSE
  ======================================================= */

  async webSocketClose(
    ws,
    code,
    reason,
    wasClean
  ) {

    const info = this.getInfo(ws);

    if (!info.partnerId) return;

    const partner =
      this.findSocketById(
        info.partnerId
      );

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

    this.send(partner, {
      type: "waiting",
      mode: partnerInfo.mode
    });
  }

  /* =======================================================
     ERROR
  ======================================================= */

  async webSocketError(ws, error) {

    console.error(
      "WebSocket error:",
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


/* =========================================================
   MAIN WORKER
========================================================= */

export default {

  async fetch(request, env) {

    const url =
      new URL(request.url);

    /* WEBSOCKET */

    if (url.pathname === "/ws") {

      if (
        request.headers.get("Upgrade")
          ?.toLowerCase() !== "websocket"
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

    /* HEALTH */

    if (url.pathname === "/health") {

      return new Response(
        JSON.stringify({
          ok: true,
          service: "RandomTalk",
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


/* =========================================================
   HTML
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
      rgba(124,58,237,.2),
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
select,
textarea {
  font:inherit;
}

button {
  cursor:pointer;
}

.container {
  width:min(
    1180px,
    calc(100% - 32px)
  );

  margin:auto;
}

/* NAV */

.navbar {
  height:75px;

  border-bottom:
    1px solid rgba(
      148,
      163,
      184,
      .12
    );

  display:flex;
  align-items:center;
}

.nav-inner {
  width:min(
    1180px,
    calc(100% - 32px)
  );

  margin:auto;

  display:flex;
  align-items:center;
  justify-content:space-between;
}

.logo {
  font-size:24px;
  font-weight:900;
}

.logo span {
  color:#a855f7;
}

.nav-links {
  display:flex;
  gap:30px;
}

.nav-links a {
  color:#dbe3f1;
  text-decoration:none;
}

/* HERO */

.hero {
  padding:70px 0;

  display:grid;

  grid-template-columns:1fr;

  gap:40px;
}

.hero h1 {
  margin:0;

  font-size:
    clamp(
      45px,
      6vw,
      76px
    );

  line-height:1;

  letter-spacing:-3px;
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
  color:#aab5ca;

  font-size:20px;

  line-height:1.6;

  max-width:600px;
}

.hero-buttons {
  display:flex;

  gap:12px;

  flex-wrap:wrap;
}

.primary,
.secondary {
  padding:15px 22px;

  border-radius:13px;

  font-weight:800;
}

.primary {
  border:0;

  color:white;

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

  color:white;

  background:transparent;
}

/* APP */

.chat-app {
  margin-bottom:70px;

  border:
    1px solid #25304a;

  background:#080f20;

  border-radius:22px;

  overflow:hidden;
}

.tabs {
  display:flex;

  gap:10px;

  padding:16px;

  border-bottom:
    1px solid #202b42;
}

.tab {
  flex:1;

  padding:14px;

  border-radius:12px;

  border:
    1px solid #26324b;

  background:transparent;

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

.layout {
  display:grid;

  grid-template-columns:270px 1fr;
}

.sidebar {
  padding:20px;

  border-right:
    1px solid #202b42;
}

.preference {
  margin:20px 0;
}

.preference-title {
  color:#aab5ca;

  margin-bottom:9px;
}

.preference-buttons {
  display:flex;
}

.preference-buttons button {
  flex:1;

  padding:10px;

  border:
    1px solid #27334d;

  background:#111a2d;

  color:white;
}

.preference-buttons button.selected {
  background:#7c3aed;
}

.select-box {
  width:100%;

  padding:12px;

  border-radius:10px;

  border:
    1px solid #27334d;

  background:#111a2d;

  color:white;
}

.save-btn {
  width:100%;

  padding:12px;

  border:0;

  border-radius:10px;

  color:white;

  font-weight:800;

  background:
    linear-gradient(
      90deg,
      #c026d3,
      #7c3aed
    );
}

.preference-hidden {
  display:none;
}

/* CHAT */

.chat-panel {
  min-height:620px;

  display:flex;

  flex-direction:column;
}

.chat-header {
  padding:20px;

  display:flex;

  justify-content:space-between;

  border-bottom:
    1px solid #202b42;
}

.status {
  color:#fbbf24;

  font-weight:800;
}

.status.connected {
  color:#4ade80;
}

.report-btn {
  border:
    1px solid #6b2737;

  background:transparent;

  color:#fb7185;

  padding:9px 14px;

  border-radius:20px;
}

/* VIDEO */

.video-area {
  display:none;

  padding:18px;
}

.video-area.show {
  display:block;
}

.video-box {
  position:relative;

  height:480px;

  overflow:hidden;

  border-radius:18px;

  background:#020617;

  border:
    1px solid #27334d;
}

#remoteVideo {
  width:100%;
  height:100%;

  object-fit:cover;
}

#localVideo {
  position:absolute;

  right:15px;
  bottom:15px;

  width:150px;
  height:115px;

  object-fit:cover;

  border-radius:14px;

  border:
    2px solid #7c3aed;

  background:#020617;
}

.video-placeholder {
  position:absolute;

  inset:0;

  display:grid;

  place-items:center;

  text-align:center;

  color:#94a3b8;

  font-size:18px;
}

.video-controls {
  display:none;

  gap:10px;

  padding:12px 18px;
}

.video-controls.show {
  display:flex;
}

.control {
  flex:1;

  padding:12px;

  border-radius:10px;

  border:
    1px solid #27334d;

  background:#111a2d;

  color:white;
}

/* MESSAGES */

.messages {
  flex:1;

  padding:22px;

  display:flex;

  flex-direction:column;

  gap:12px;

  overflow-y:auto;

  max-height:400px;
}

.message {
  max-width:75%;

  padding:12px 16px;

  border-radius:16px;

  line-height:1.45;
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

.message-input {
  display:flex;

  gap:10px;

  padding:0 20px 18px;
}

.message-input input {
  flex:1;

  min-width:0;

  padding:14px 18px;

  border-radius:25px;

  border:
    1px solid #34415d;

  outline:none;

  background:#0c1426;

  color:white;
}

.send {
  width:52px;
  height:52px;

  border:0;

  border-radius:50%;

  color:white;

  background:
    linear-gradient(
      135deg,
      #d946ef,
      #7c3aed
    );
}

.actions {
  display:grid;

  grid-template-columns:1fr 2fr;

  gap:12px;

  padding:18px;

  border-top:
    1px solid #202b42;
}

.end,
.next {
  padding:14px;

  border-radius:12px;

  font-weight:800;
}

.end {
  background:#0b1222;

  border:
    1px solid #202b42;

  color:#fb7185;
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

  display:none;

  align-items:center;

  justify-content:center;

  padding:20px;

  background:rgba(0,0,0,.75);

  z-index:100;
}

.modal.show {
  display:flex;
}

.modal-box {
  width:min(
    430px,
    100%
  );

  padding:24px;

  border-radius:18px;

  border:
    1px solid #34415d;

  background:#0b1222;
}

.modal-box h2 {
  margin-top:0;
}

.modal-box select,
.modal-box textarea {
  width:100%;

  margin-bottom:12px;

  padding:12px;

  border-radius:10px;

  border:
    1px solid #34415d;

  background:#111a2d;

  color:white;
}

.modal-buttons {
  display:flex;

  gap:10px;
}

.modal-buttons button {
  flex:1;

  padding:12px;

  border-radius:10px;

  border:0;
}

.cancel {
  background:#182238;

  color:white;
}

.submit-report {
  background:#dc2626;

  color:white;
}

/* MOBILE */

@media(max-width:800px) {

  .nav-links {
    display:none;
  }

  .hero {
    padding-top:45px;
  }

  .layout {
    grid-template-columns:1fr;
  }

  .sidebar {
    display:block;

    border-right:0;

    border-bottom:
      1px solid #202b42;
  }

  .actions {
    grid-template-columns:1fr;
  }

  .video-box {
    height:390px;
  }

  #localVideo {
    width:115px;
    height:150px;
  }

  .message {
    max-width:85%;
  }
}

</style>

</head>

<body>

<header class="navbar">

<div class="nav-inner">

<div class="logo">
💬 Random<span>Talk</span>
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
Meet random people through
text or video chat.
</p>

<div class="hero-buttons">

<button
class="primary"
onclick="startFromHero()"
>
🚀 Start Chatting
</button>

<button
class="secondary"
onclick="showHow()"
>
▶ How it works
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


<aside class="sidebar">

<h3>⚙️ Preferences</h3>


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


<div
id="safety"
style="
margin-top:25px;
color:#94a3b8;
line-height:1.8;
"
>

<b>Safety</b><br>

• Be respectful<br>
• Don't share personal information<br>
• Report inappropriate users<br>
• You can leave anytime

</div>

</aside>


<section class="chat-panel">


<div class="chat-header">

<div>

<div
id="status"
class="status"
>
● Ready
</div>

<small id="statusText">
Choose your preferences and press Start Chatting.
</small>

</div>

<button
class="report-btn"
onclick="openReport()"
>
⚠ Report
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

<div
id="videoPlaceholder"
class="video-placeholder"
>

<div>

<div style="font-size:55px">
🎥
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
📷 Camera On
</button>

<button
class="control"
onclick="toggleMicrophone()"
>
🎤 Microphone On
</button>

</div>


<div
id="messages"
class="messages"
>

<div class="message received">
👋 Welcome to RandomTalk!
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

</div>

</section>

</main>


<!-- REPORT -->

<div
id="reportModal"
class="modal"
>

<div class="modal-box">

<h2>⚠ Report User</h2>

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
   MODE
========================================================= */

function selectText() {

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

  document
    .getElementById("myGenderBox")
    .style.display = "none";

  document
    .getElementById("preferredGenderBox")
    .style.display = "none";
}


function chooseGender() {

  currentChatWith = "gender";

  document
    .getElementById("genderBtn")
    .classList.add("selected");

  document
    .getElementById("everyoneBtn")
    .classList.remove("selected");

  document
    .getElementById("myGenderBox")
    .style.display = "block";

  document
    .getElementById("preferredGenderBox")
    .style.display = "block";
}


/* =========================================================
   SOCKET
========================================================= */

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

      const myGender =
        document.getElementById(
          "myGender"
        ).value;

      const preferredGender =
        document.getElementById(
          "preferredGender"
        ).value;

      const country =
        document.getElementById(
          "country"
        ).value;


      updateStatus(
        "● Searching...",
        "Looking for a matching person...",
        false
      );


      socket.send(
        JSON.stringify({

          type: "join",

          mode: currentMode,

          chatWith:
            currentChatWith,

          gender:
            myGender,

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
        data =
          JSON.parse(event.data);
      } catch {
        return;
      }


      /* WAITING */

      if (data.type === "waiting") {

        connected = false;

        updateStatus(
          "● Searching...",
          "Waiting for a compatible stranger...",
          false
        );

        disableInput();

        setButton(
          "⏳ Searching..."
        );

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
          "● Connected",
          currentMode === "video"
            ? "Starting video..."
            : "You are chatting with a stranger.",
          true
        );

        enableInput();

        setButton("⏭ Next");

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
              "Camera error:",
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

      if (data.type === "chat") {

        addReceivedMessage(
          data.text
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
            "Signal error:",
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

        updateStatus(
          "● Stranger left",
          "Searching for another compatible person...",
          false
        );

        disableInput();

        setButton(
          "⏳ Searching..."
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

      updateStatus(
        "● Disconnected",
        "Press Start Chatting.",
        false
      );

      disableInput();

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
    await navigator.mediaDevices.getUserMedia({

      video: {
        facingMode: "user"
      },

      audio: true

    });

  const video =
    document.getElementById(
      "localVideo"
    );

  video.srcObject =
    localStream;

  video.muted = true;

  await video.play()
    .catch(function(){});

  cameraEnabled = true;

  microphoneEnabled = true;

  updateVideoButtons();

  return localStream;
}


/* =========================================================
   PEER
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

      const remote =
        document.getElementById(
          "remoteVideo"
        );

      remote.srcObject =
        event.streams[0];

      remote.play()
        .catch(function(){});

      document
        .getElementById(
          "videoPlaceholder"
        )
        .style.display = "none";

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

        document
          .getElementById(
            "videoPlaceholder"
          )
          .style.display = "none";

        updateStatus(
          "● Connected",
          "You are on a video call.",
          true
        );
      }


      if (
        state === "failed"
      ) {

        document
          .getElementById(
            "videoPlaceholder"
          )
          .style.display = "grid";

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

  const remote =
    document.getElementById(
      "remoteVideo"
    );

  if (remote) {
    remote.srcObject = null;
  }

  const placeholder =
    document.getElementById(
      "videoPlaceholder"
    );

  if (placeholder) {
    placeholder.style.display =
      "grid";
  }
}


/* =========================================================
   CAMERA / MIC
========================================================= */

function toggleCamera() {

  if (!localStream) return;

  const tracks =
    localStream.getVideoTracks();

  if (!tracks.length) return;

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

  if (!localStream) return;

  const tracks =
    localStream.getAudioTracks();

  if (!tracks.length) return;

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
      behavior:"smooth"
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
        type:"next"
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

    return;
  }
}


/* =========================================================
   CHAT
========================================================= */

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
    socket.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  socket.send(
    JSON.stringify({
      type:"chat",
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
        type:"end"
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
    .getElementById(
      "reportModal"
    )
    .classList.add("show");
}


function closeReport() {

  document
    .getElementById(
      "reportModal"
    )
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
    document.getElementById(
      "reportReason"
    ).value;

  const details =
    document.getElementById(
      "reportDetails"
    ).value;

  socket.send(
    JSON.stringify({

      type:"report",

      reason,

      details

    })
  );
}


/* =========================================================
   PREFERENCES
========================================================= */

function savePreferences() {

  const country =
    document.getElementById(
      "country"
    ).value;

  const myGender =
    document.getElementById(
      "myGender"
    ).value;

  const preferredGender =
    document.getElementById(
      "preferredGender"
    ).value;

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
    "✅ Preferences saved. They will be used for your next match."
  );
}


/* =========================================================
   HOW IT WORKS
========================================================= */

function showHow() {

  alert(
    "1. Choose Text or Video Chat.\\n\\n" +
    "2. Choose Everyone or Gender.\\n\\n" +
    "3. Choose your country preference.\\n\\n" +
    "4. Press Start Chatting.\\n\\n" +
    "5. RandomTalk finds a compatible available user."
  );
}


/* =========================================================
   UI
========================================================= */

function updateStatus(
  title,
  text,
  connectedState
) {

  const status =
    document.getElementById(
      "status"
    );

  const statusText =
    document.getElementById(
      "statusText"
    );

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

  document.getElementById(
    "nextButton"
  ).textContent =
    text;
}


function enableInput() {

  const input =
    document.getElementById(
      "messageInput"
    );

  input.disabled = false;

  input.placeholder =
    "Type a message...";
}


function disableInput() {

  const input =
    document.getElementById(
      "messageInput"
    );

  input.disabled = true;

  input.placeholder =
    "Waiting for a stranger...";
}


function clearMessages() {

  document.getElementById(
    "messages"
  ).innerHTML = "";
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

  document
    .getElementById(
      "messages"
    )
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

  document
    .getElementById(
      "messages"
    )
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

  document
    .getElementById(
      "messages"
    )
    .appendChild(div);

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


/* =========================================================
   LOAD
========================================================= */

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

      document
        .getElementById(
          "country"
        )
        .value =
        savedCountry;
    }


    if (savedGender) {

      document
        .getElementById(
          "myGender"
        )
        .value =
        savedGender;
    }


    if (savedPreferred) {

      document
        .getElementById(
          "preferredGender"
        )
        .value =
        savedPreferred;
    }

  }
);

</script>

</body>

</html>`;
