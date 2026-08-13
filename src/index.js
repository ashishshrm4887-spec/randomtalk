export class ChatRoom {

  constructor(state, env) {

    this.state = state;

    this.env = env;

    this.waiting = null;

    this.partners = new Map();

  }

  async fetch(request) {

    if (request.headers.get("Upgrade") !== "websocket") {

      return new Response("ChatRoom is running.");

    }

    const pair = new WebSocketPair();

    const client = pair[0];

    const server = pair[1];

    server.accept();

    if (this.waiting && this.waiting.readyState === WebSocket.OPEN) {

      const other = this.waiting;

      this.waiting = null;

      this.partners.set(server, other);

      this.partners.set(other, server);

      server.send(JSON.stringify({

        type: "matched",

        initiator: true

      }));

      other.send(JSON.stringify({

        type: "matched",

        initiator: false

      }));

    } else {

      this.waiting = server;

      server.send(JSON.stringify({

        type: "waiting"

      }));

    }

    server.addEventListener("message", event => {

      let data;

      try {

        data = JSON.parse(event.data);

      } catch {

        return;

      }

      const partner = this.partners.get(server);

      if (data.type === "chat") {

        if (partner && partner.readyState === WebSocket.OPEN) {

          partner.send(JSON.stringify({

            type: "chat",

            text: String(data.text || "").slice(0, 2000)

          }));

        }

      }

      /*

       * WEBRTC SIGNALING

       */

      if (data.type === "signal") {

        if (partner && partner.readyState === WebSocket.OPEN) {

          partner.send(JSON.stringify({

            type: "signal",

            data: data.data

          }));

        }

      }

      if (data.type === "next") {

        this.disconnectPair(server);

        this.waitForUser(server);

      }

      if (data.type === "end") {

        this.disconnectPair(server);

        this.removeUser(server);

      }

    });

    const cleanup = () => {

      if (this.waiting === server) {

        this.waiting = null;

      }

      const partner = this.partners.get(server);

      if (partner) {

        this.partners.delete(server);

        this.partners.delete(partner);

        if (partner.readyState === WebSocket.OPEN) {

          partner.send(JSON.stringify({

            type: "partner_left"

          }));

          this.waiting = partner;

          partner.send(JSON.stringify({

            type: "waiting"

          }));

        }

      }

    };

    server.addEventListener("close", cleanup);

    server.addEventListener("error", cleanup);

    return new Response(null, {

      status: 101,

      webSocket: client

    });

  }

  waitForUser(socket) {

    if (!socket || socket.readyState !== WebSocket.OPEN) {

      return;

    }

    if (this.waiting && this.waiting !== socket) {

      const other = this.waiting;

      if (other.readyState === WebSocket.OPEN) {

        this.waiting = null;

        this.partners.set(socket, other);

        this.partners.set(other, socket);

        socket.send(JSON.stringify({

          type: "matched",

          initiator: true

        }));

        other.send(JSON.stringify({

          type: "matched",

          initiator: false

        }));

        return;

      }

    }

    this.waiting = socket;

    socket.send(JSON.stringify({

      type: "waiting"

    }));

  }

  disconnectPair(socket) {

    const partner = this.partners.get(socket);

    if (!partner) {

      return;

    }

    this.partners.delete(socket);

    this.partners.delete(partner);

    if (partner.readyState === WebSocket.OPEN) {

      partner.send(JSON.stringify({

        type: "partner_left"

      }));

    }

  }

  removeUser(socket) {

    if (this.waiting === socket) {

      this.waiting = null;

    }

    this.partners.delete(socket);

  }

}

export default {

  async fetch(request, env) {

    const url = new URL(request.url);

    /*

     * REAL-TIME CHAT + WEBRTC SIGNALING

     */

    if (url.pathname === "/ws") {

      const id =

        env.CHAT.idFromName("global-chat-room");

      const room =

        env.CHAT.get(id);

      return room.fetch(request);

    }

    /*

     * RANDOMTALK WEBSITE

     */

    return new Response(`<!DOCTYPE html>

<html lang="en">

<head>

<meta charset="UTF-8">

<meta

  name="viewport"

  content="width=device-width, initial-scale=1.0"

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

      rgba(124,58,237,.18),

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

select {

  font: inherit;

}

button {

  cursor: pointer;

}

.container {

  width: min(1180px, calc(100% - 32px));

  margin: auto;

}

/* NAVBAR */

.navbar {

  height: 82px;

  border-bottom:

    1px solid rgba(148,163,184,.12);

  display: flex;

  align-items: center;

}

.nav-inner {

  width: min(1180px, calc(100% - 32px));

  margin: auto;

  display: flex;

  align-items: center;

  justify-content: space-between;

}

.logo {

  display: flex;

  align-items: center;

  gap: 10px;

  font-size: 25px;

  font-weight: 800;

}

.logo-icon {

  width: 38px;

  height: 38px;

  border-radius: 13px;

  display: grid;

  place-items: center;

  background:

    linear-gradient(

      135deg,

      #a855f7,

      #6366f1

    );

  box-shadow:

    0 0 30px rgba(168,85,247,.35);

}

.logo span {

  background:

    linear-gradient(

      90deg,

      #a855f7,

      #6366f1

    );

  -webkit-background-clip: text;

  color: transparent;

}

.nav-links {

  display: flex;

  gap: 38px;

}

.nav-links a {

  color: #dbe3f1;

  text-decoration: none;

  font-weight: 600;

}

.nav-actions {

  display: flex;

  gap: 12px;

  align-items: center;

}

.language,

.profile {

  border: 1px solid #26324b;

  background:

    rgba(15,23,42,.7);

  color: white;

}

.language {

  padding: 11px 18px;

  border-radius: 25px;

}

.profile {

  width: 44px;

  height: 44px;

  border-radius: 50%;

}

/* HERO */

.hero {

  padding: 80px 0 55px;

  display: grid;

  grid-template-columns:

    1fr 1fr;

  gap: 55px;

  align-items: center;

}

.hero h1 {

  margin: 0;

  font-size:

    clamp(48px,6vw,76px);

  line-height: 1.02;

  letter-spacing: -3px;

}

.gradient-text {

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

  color: #aab5ca;

  font-size: 21px;

  line-height: 1.6;

  max-width: 570px;

}

.stats {

  display: flex;

  gap: 12px;

  flex-wrap: wrap;

  margin: 25px 0;

}

.stat {

  background:

    rgba(15,23,42,.75);

  border:

    1px solid #1d2942;

  border-radius: 12px;

  padding: 11px 15px;

  color: #dce4f3;

}

.online-dot {

  color: #4ade80;

}

.hero-buttons {

  display: flex;

  gap: 14px;

  flex-wrap: wrap;

}

.primary-btn,

.secondary-btn {

  padding: 16px 25px;

  border-radius: 14px;

  font-weight: 800;

  border: 1px solid transparent;

}

.primary-btn {

  color: white;

  background:

    linear-gradient(

      90deg,

      #d946ef,

      #7c3aed

    );

  box-shadow:

    0 10px 35px

    rgba(124,58,237,.3);

}

.secondary-btn {

  background: transparent;

  border-color: #34415d;

  color: white;

}

/* HERO VISUAL */

.hero-visual {

  min-height: 380px;

  position: relative;

  display: flex;

  align-items: center;

  justify-content: center;

}

.orbit {

  width: 250px;

  height: 250px;

  border:

    1px dashed #8b5cf6;

  border-radius: 50%;

  position: absolute;

  box-shadow:

    0 0 60px

    rgba(124,58,237,.15);

}

.orbit-center {

  width: 90px;

  height: 90px;

  border-radius: 50%;

  background:

    linear-gradient(

      135deg,

      #7c3aed,

      #c026d3

    );

  display: grid;

  place-items: center;

  font-size: 38px;

  box-shadow:

    0 0 60px

    rgba(168,85,247,.55);

}

.person-card {

  width: 155px;

  padding: 12px;

  border:

    1px solid #7652e8;

  background:

    rgba(15,23,42,.92);

  border-radius: 22px;

  position: absolute;

  box-shadow:

    0 20px 50px

    rgba(0,0,0,.4);

}

.person-card.left {

  left: 5%;

  transform:

    rotate(-8deg);

}

.person-card.right {

  right: 5%;

  transform:

    rotate(8deg);

}

.avatar {

  height: 140px;

  border-radius: 15px;

  background:

    linear-gradient(

      135deg,

      #312e81,

      #581c87

    );

  display: grid;

  place-items: center;

  font-size: 65px;

}

.person-info {

  padding:

    10px 3px 3px;

  line-height: 1.5;

}

/* CHAT APP */

.chat-app {

  border:

    1px solid #25304a;

  background:

    rgba(8,15,32,.85);

  border-radius: 25px;

  overflow: hidden;

  box-shadow:

    0 30px 90px

    rgba(0,0,0,.35);

  margin-bottom: 80px;

}

.chat-tabs {

  padding: 18px;

  border-bottom:

    1px solid #202b42;

  display: flex;

  gap: 10px;

}

.tab {

  flex: 1;

  padding: 15px;

  border-radius: 14px;

  border:

    1px solid #26324b;

  background: transparent;

  color: #aeb9ce;

  font-weight: 800;

}

.tab.active {

  color: white;

  background:

    linear-gradient(

      90deg,

      #a855f7,

      #6366f1

    );

  border-color: transparent;

}

/* CHAT LAYOUT */

.chat-layout {

  display: grid;

  grid-template-columns:

    270px 1fr;

}

.sidebar {

  padding: 22px;

  border-right:

    1px solid #202b42;

}

.sidebar h3 {

  margin-top: 0;

}

.preference {

  margin: 20px 0;

}

.preference-title {

  color: #aab5ca;

  margin-bottom: 10px;

}

.preference-buttons {

  display: flex;

}

.preference-buttons button {

  flex: 1;

  padding: 11px;

  background: #111a2d;

  border:

    1px solid #27334d;

  color: white;

}

.preference-buttons button:first-child {

  border-radius:

    10px 0 0 10px;

}

.preference-buttons button:last-child {

  border-radius:

    0 10px 10px 0;

}

.preference-buttons .selected {

  background: #7c3aed;

}

.select-box {

  width: 100%;

  padding: 13px;

  border-radius: 10px;

  background: #111a2d;

  border:

    1px solid #27334d;

  color: white;

}

.save-btn {

  width: 100%;

  margin-top: 10px;

  padding: 13px;

  border: 0;

  border-radius: 11px;

  color: white;

  font-weight: 800;

  background:

    linear-gradient(

      90deg,

      #c026d3,

      #7c3aed

    );

}

.tips {

  margin-top: 35px;

  color: #aab5ca;

  line-height: 1.9;

}

/* CHAT PANEL */

.chat-panel {

  min-height: 620px;

  display: flex;

  flex-direction: column;

}

.chat-header {

  padding: 20px 25px;

  border-bottom:

    1px solid #202b42;

  display: flex;

  align-items: center;

  justify-content: space-between;

}

.connected {

  color: #4ade80;

  font-weight: 800;

}

.waiting {

  color: #fbbf24;

  font-weight: 800;

}

.report {

  border:

    1px solid #6b2737;

  background: transparent;

  color: #fb7185;

  padding: 9px 15px;

  border-radius: 20px;

}

/* MESSAGES */

.messages {

  flex: 1;

  padding: 25px;

  display: flex;

  flex-direction: column;

  gap: 16px;

  overflow-y: auto;

}

.message {

  max-width: 70%;

  padding:

    13px 17px;

  border-radius: 17px;

  line-height: 1.45;

}

.received {

  align-self: flex-start;

  background: #182238;

  color: #e2e8f0;

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

.message small {

  display: block;

  opacity: .6;

  margin-top: 4px;

  font-size: 11px;

}

/* MESSAGE INPUT */

.message-input {

  margin:

    0 25px 20px;

  display: flex;

  gap: 10px;

}

.message-input input {

  flex: 1;

  padding: 16px;

  border-radius: 28px;

  background: #0c1426;

  border:

    1px solid #34415d;

  color: white;

  outline: none;

}

.message-input input:disabled {

  opacity: .55;

}

.send-btn {

  width: 55px;

  height: 55px;

  border-radius: 50%;

  border: 0;

  color: white;

  background:

    linear-gradient(

      135deg,

      #d946ef,

      #7c3aed

    );

}

/* ACTIONS */

.chat-actions {

  padding: 20px;

  border-top:

    1px solid #202b42;

  display: grid;

  grid-template-columns:

    1fr 2fr;

  gap: 15px;

}

.end-btn,

.next-btn {

  padding: 16px;

  border-radius: 13px;

  font-weight: 800;

}

.end-btn {

  color: #fb7185;

  background: #0b1222;

  border:

    1px solid #202b42;

}

.next-btn {

  color: white;

  border: 0;

  background:

    linear-gradient(

      90deg,

      #d946ef,

      #7c3aed

    );

}

/* =========================

   REAL VIDEO CHAT

========================= */

.video-area {

  display: none;

  padding: 20px;

  background:

    #050b18;

}

.video-area.active {

  display: block;

}

.video-main {

  position: relative;

  width: 100%;

  height: 520px;

  background:

    #020617;

  border:

    1px solid #27334d;

  border-radius: 20px;

  overflow: hidden;

  display: flex;

  align-items: center;

  justify-content: center;

}

#remoteVideo {

  width: 100%;

  height: 100%;

  object-fit: cover;

  background: #020617;

}

.video-placeholder {

  position: absolute;

  inset: 0;

  display: flex;

  flex-direction: column;

  align-items: center;

  justify-content: center;

  gap: 12px;

  color: #94a3b8;

  background:

    radial-gradient(

      circle at center,

      #111827,

      #020617

    );

  text-align: center;

}

.video-placeholder.hidden {

  display: none;

}

.video-icon {

  font-size: 55px;

}

.remote-label {

  position: absolute;

  left: 16px;

  bottom: 16px;

  padding:

    8px 14px;

  border-radius: 20px;

  background:

    rgba(0,0,0,.65);

  color: white;

  font-weight: 700;

  backdrop-filter: blur(8px);

}

/* LOCAL VIDEO */

.local-video-container {

  position: absolute;

  width: 170px;

  height: 125px;

  right: 18px;

  bottom: 18px;

  border:

    2px solid

    rgba(255,255,255,.25);

  border-radius: 15px;

  overflow: hidden;

  background: #111827;

  box-shadow:

    0 10px 35px

    rgba(0,0,0,.5);

  z-index: 5;

}

#localVideo {

  width: 100%;

  height: 100%;

  object-fit: cover;

  background: #111827;

}

.local-placeholder {

  position: absolute;

  inset: 0;

  display: flex;

  align-items: center;

  justify-content: center;

  font-size: 35px;

  background: #111827;

}

.local-placeholder.hidden {

  display: none;

}

.local-label {

  position: absolute;

  left: 8px;

  bottom: 7px;

  padding:

    4px 8px;

  border-radius: 8px;

  background:

    rgba(0,0,0,.65);

  font-size: 11px;

  font-weight: 700;

}

/* VIDEO CONTROLS */

.video-controls {

  display: flex;

  justify-content: center;

  gap: 12px;

  margin-top: 15px;

  flex-wrap: wrap;

}

.video-control-btn {

  padding:

    12px 18px;

  border-radius: 12px;

  border:

    1px solid #34415d;

  background: #111a2d;

  color: white;

  font-weight: 700;

}

.video-control-btn.off {

  background: #7f1d1d;

  border-color: #991b1b;

}

/* FOOTER */

.footer {

  text-align: center;

  color: #64748b;

  padding:

    20px 0 50px;

}

/* MOBILE */

@media (max-width: 800px) {

  .nav-links {

    display: none;

  }

  .navbar {

    height: 70px;

  }

  .language {

    display: none;

  }

  .hero {

    grid-template-columns: 1fr;

    padding-top: 55px;

  }

  .hero h1 {

    font-size: 50px;

  }

  .hero p {

    font-size: 18px;

  }

  .hero-visual {

    min-height: 330px;

    transform:

      scale(.85);

  }

  .person-card.left {

    left: 0;

  }

  .person-card.right {

    right: 0;

  }

  .chat-layout {

    grid-template-columns: 1fr;

  }

  .sidebar {

    display: none;

  }

  .chat-panel {

    min-height: 600px;

  }

  .chat-actions {

    grid-template-columns: 1fr;

  }

  .chat-tabs {

    padding: 12px;

  }

  .message {

    max-width: 82%;

  }

  .logo {

    font-size: 22px;

  }

  .video-main {

    height: 430px;

  }

  .local-video-container {

    width: 125px;

    height: 95px;

    right: 12px;

    bottom: 12px;

  }

}

/* SMALL PHONE */

@media (max-width: 480px) {

  .video-main {

    height: 390px;

  }

  .video-area {

    padding: 10px;

  }

  .local-video-container {

    width: 115px;

    height: 85px;

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

    <nav class="nav-links">

      <a href="#">

        Home

      </a>

      <a href="#chat">

        Chat

      </a>

      <a href="#safety">

        Safety

      </a>

      <a href="#about">

        About

      </a>

    </nav>

    <div class="nav-actions">

      <button class="language">

        🌐 English

      </button>

      <button class="profile">

        👤

      </button>

    </div>

  </div>

</header>

<main>

<section class="hero container">

  <div>

    <h1>

      Talk to<br>

      someone

      <span class="gradient-text">

        new.

      </span>

    </h1>

    <p>

      Meet random people from around the world

      through text or video chat.

    </p>

    <div class="stats">

      <div class="stat">

        <span class="online-dot">

          ●

        </span>

        <span id="onlineCount">

          Online now

        </span>

      </div>

      <div class="stat">

        👥 Random conversations

      </div>

    </div>

    <div class="hero-buttons">

      <button

        class="primary-btn"

        onclick="scrollToChat()"

      >

        🚀 Start Chatting

      </button>

      <button

        class="secondary-btn"

        onclick="showInfo()"

      >

        ▶ How it works?

      </button>

    </div>

  </div>

  <div class="hero-visual">

    <div class="orbit"></div>

    <div class="person-card left">

      <div class="avatar">

        👨🏻

      </div>

      <div class="person-info">

        🇮🇳 India<br>

        Random User

      </div>

    </div>

    <div class="orbit-center">

      💬

    </div>

    <div class="person-card right">

      <div class="avatar">

        👩🏻

      </div>

      <div class="person-info">

        🌎 Worldwide<br>

        Random User

      </div>

    </div>

  </div>

</section>

<section

  class="container"

  id="chat"

>

<div class="chat-app">

  <div class="chat-tabs">

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

  <div class="chat-layout">

    <aside class="sidebar">

      <h3>

        ⚙️ Chat Preferences

      </h3>

      <div class="preference">

        <div class="preference-title">

          I want to chat with

        </div>

        <div class="preference-buttons">

          <button class="selected">

            Everyone

          </button>

          <button>

            Gender

          </button>

        </div>

      </div>

      <div class="preference">

        <div class="preference-title">

          Country

        </div>

        <select class="select-box">

          <option>

            Any country

          </option>

          <option>

            India 🇮🇳

          </option>

          <option>

            United States 🇺🇸

          </option>

          <option>

            United Kingdom 🇬🇧

          </option>

          <option>

            Canada 🇨🇦

          </option>

        </select>

      </div>

      <button class="save-btn">

        ✨ Save Preferences

      </button>

      <div

        class="tips"

        id="safety"

      >

        <h3>

          💡 Tips

        </h3>

        • Be respectful<br>

        • Don't share personal information<br>

        • Report inappropriate users<br>

        • Have fun and enjoy!

      </div>

    </aside>

    <section class="chat-panel">

      <div class="chat-header">

        <div>

          <div

            class="waiting"

            id="connectionStatus"

          >

            ● Ready

          </div>

          <small id="connectionText">

            Press Start Chatting to find someone

          </small>

        </div>

        <button

          class="report"

          onclick="reportUser()"

        >

          ⚠ Report

        </button>

      </div>

      <!-- VIDEO AREA -->

      <div

        class="video-area"

        id="videoArea"

      >

        <div class="video-main">

          <video

            id="remoteVideo"

            autoplay

            playsinline

          ></video>

          <div

            class="video-placeholder"

            id="remotePlaceholder"

          >

            <div class="video-icon">

              📹

            </div>

            <div>

              Waiting for stranger's video...

            </div>

          </div>

          <div class="remote-label">

            Stranger

          </div>

          <div class="local-video-container">

            <video

              id="localVideo"

              autoplay

              muted

              playsinline

            ></video>

            <div

              class="local-placeholder"

              id="localPlaceholder"

            >

              📷

            </div>

            <div class="local-label">

              You

            </div>

          </div>

        </div>

        <div class="video-controls">

          <button

            class="video-control-btn"

            id="cameraButton"

            onclick="toggleCamera()"

          >

            📷 Camera

          </button>

          <button

            class="video-control-btn"

            id="micButton"

            onclick="toggleMicrophone()"

          >

            🎤 Microphone

          </button>

        </div>

      </div>

      <!-- TEXT CHAT -->

      <div

        class="messages"

        id="messages"

      >

        <div class="message received">

          👋 Welcome to RandomTalk!

          <small>

            System

          </small>

        </div>

        <div class="message received">

          Press

          <b>Start Chatting</b>

          to find a random person.

          <small>

            System

          </small>

        </div>

      </div>

      <div class="message-input">

        <input

          id="messageInput"

          type="text"

          placeholder="Type a message..."

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

      <div class="chat-actions">

        <button

          class="end-btn"

          onclick="endChat()"

        >

          ⏹ End Chat

        </button>

        <button

          class="next-btn"

          id="startNextButton"

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

<footer

  class="footer"

  id="about"

>

  RandomTalk © 2026 · Talk safely. Meet someone new.

</footer>

<script>

let socket = null;

let connected = false;

let intentionallyClosed = false;

/*

 * VIDEO / WEBRTC

 */

let peerConnection = null;

let localStream = null;

let videoMode = false;

let cameraEnabled = true;

let microphoneEnabled = true;

/*

 * WEBRTC SERVERS

 */

const rtcConfiguration = {

  iceServers: [

    {

      urls: "stun:stun.l.google.com:19302"

    },

    {

      urls: "stun:stun1.l.google.com:19302"

    }

  ]

};

/*

 * CONNECT WEBSOCKET

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

  const protocol =

    location.protocol === "https:"

      ? "wss:"

      : "ws:";

  socket = new WebSocket(

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

        "Looking for a random person...",

        false

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

       * WAITING

       */

      if (data.type === "waiting") {

        connected = false;

        updateStatus(

          "● Searching...",

          "Waiting for another person...",

          false

        );

        setButton(

          "⏳ Searching..."

        );

        disableInput();

        return;

      }

      /*

       * MATCHED

       */

      if (data.type === "matched") {

        connected = true;

        updateStatus(

          "● Connected",

          "You are chatting with a random stranger",

          true

        );

        setButton("⏭ Next");

        enableInput();

        addSystemMessage(

          "🎉 You are connected! Say hello."

        );

        /*

         * IF VIDEO MODE,

         * START CAMERA

         */

        if (videoMode) {

          await startVideoCall(

            data.initiator

          );

        }

        return;

      }

      /*

       * CHAT MESSAGE

       */

      if (data.type === "chat") {

        addReceivedMessage(

          data.text

        );

        return;

      }

      /*

       * WEBRTC SIGNAL

       */

      if (data.type === "signal") {

        await handleWebRTCSignal(

          data.data

        );

        return;

      }

      /*

       * PARTNER LEFT

       */

      if (data.type === "partner_left") {

        connected = false;

        closePeerConnection();

        updateStatus(

          "● Stranger left",

          "Finding another person...",

          false

        );

        disableInput();

        setButton(

          "⏳ Searching..."

        );

        addSystemMessage(

          "👋 The stranger left. Looking for someone else..."

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

      if (!intentionallyClosed) {

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

        "Please try again.",

        false

      );

    }

  );

}

/*

 * START / NEXT

 */

async function startOrNext() {

  /*

   * CONNECT

   */

  if (

    !socket ||

    socket.readyState !== WebSocket.OPEN

  ) {

    intentionallyClosed = false;

    connectSocket();

    return;

  }

  /*

   * NEXT PERSON

   */

  if (connected) {

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

      "Finding another person...",

      false

    );

    disableInput();

    setButton(

      "⏳ Searching..."

    );

    return;

  }

  updateStatus(

    "● Searching...",

    "Finding someone...",

    false

  );

}

/*

 * SEND CHAT MESSAGE

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

    !connected

  ) {

    return;

  }

  if (

    !socket ||

    socket.readyState !== WebSocket.OPEN

  ) {

    return;

  }

  socket.send(

    JSON.stringify({

      type: "chat",

      text: text

    })

  );

  addSentMessage(text);

  input.value = "";

}

/*

 * ENTER KEY

 */

function handleEnter(event) {

  if (event.key === "Enter") {

    event.preventDefault();

    sendMessage();

  }

}

/*

 * END CHAT

 */

function endChat() {

  closePeerConnection();

  if (

    socket &&

    socket.readyState === WebSocket.OPEN

  ) {

    socket.send(

      JSON.stringify({

        type: "end"

      })

    );

    intentionallyClosed = true;

    socket.close();

  }

  connected = false;

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

 * =========================

 * VIDEO MODE

 * =========================

 */

async function selectVideo() {

  videoMode = true;

  document

    .getElementById("videoTab")

    .classList.add("active");

  document

    .getElementById("textTab")

    .classList.remove("active");

  document

    .getElementById("videoArea")

    .classList.add("active");

  /*

   * START LOCAL CAMERA

   */

  await startLocalMedia();

  /*

   * IF ALREADY CONNECTED,

   * CREATE WEBRTC CONNECTION

   */

  if (connected) {

    await startVideoCall(false);

  }

}

/*

 * TEXT MODE

 */

function selectText() {

  videoMode = false;

  document

    .getElementById("textTab")

    .classList.add("active");

  document

    .getElementById("videoTab")

    .classList.remove("active");

  document

    .getElementById("videoArea")

    .classList.remove("active");

}

/*

 * GET CAMERA + MICROPHONE

 */

async function startLocalMedia() {

  if (localStream) {

    showLocalVideo();

    return true;

  }

  if (

    !navigator.mediaDevices ||

    !navigator.mediaDevices.getUserMedia

  ) {

    alert(

      "Camera and microphone are not supported by this browser."

    );

    return false;

  }

  try {

    localStream =

      await navigator.mediaDevices.getUserMedia({

        video: true,

        audio: true

      });

    const localVideo =

      document.getElementById(

        "localVideo"

      );

    localVideo.srcObject =

      localStream;

    showLocalVideo();

    cameraEnabled = true;

    microphoneEnabled = true;

    updateVideoButtons();

    return true;

  } catch (error) {

    console.error(

      "Camera/microphone error:",

      error

    );

    alert(

      "Camera and microphone permission is required for video chat. Please allow access in your browser settings."

    );

    return false;

  }

}

/*

 * START WEBRTC

 */

async function startVideoCall(

  initiator

) {

  if (!videoMode) {

    return;

  }

  const mediaReady =

    await startLocalMedia();

  if (!mediaReady) {

    return;

  }

  createPeerConnection();

  /*

   * ONLY INITIATOR CREATES OFFER

   */

  if (initiator) {

    try {

      const offer =

        await peerConnection.createOffer();

      await peerConnection.setLocalDescription(

        offer

      );

      sendSignal({

        type: "offer",

        sdp: offer

      });

    } catch (error) {

      console.error(

        "Offer error:",

        error

      );

    }

  }

}

/*

 * CREATE PEER CONNECTION

 */

function createPeerConnection() {

  if (peerConnection) {

    return;

  }

  peerConnection =

    new RTCPeerConnection(

      rtcConfiguration

    );

  /*

   * ADD LOCAL CAMERA/MIC

   */

  if (localStream) {

    localStream

      .getTracks()

      .forEach(track => {

        peerConnection.addTrack(

          track,

          localStream

        );

      });

  }

  /*

   * RECEIVE REMOTE TRACK

   */

  peerConnection.ontrack =

    event => {

      const remoteVideo =

        document.getElementById(

          "remoteVideo"

        );

      if (

        event.streams &&

        event.streams[0]

      ) {

        remoteVideo.srcObject =

          event.streams[0];

        hideRemotePlaceholder();

        remoteVideo

          .play()

          .catch(() => {});

      }

    };

  /*

   * ICE CANDIDATES

   */

  peerConnection.onicecandidate =

    event => {

      if (

        event.candidate

      ) {

        sendSignal({

          type: "ice",

          candidate:

            event.candidate

        });

      }

    };

  peerConnection.onconnectionstatechange =

    () => {

      if (!peerConnection) {

        return;

      }

      const state =

        peerConnection.connectionState;

      if (

        state === "connected"

      ) {

        hideRemotePlaceholder();

      }

      if (

        state === "failed"

      ) {

        console.log(

          "WebRTC connection failed"

        );

      }

    };

}

/*

 * HANDLE WEBRTC SIGNAL

 */

async function handleWebRTCSignal(

  data

) {

  if (!videoMode) {

    return;

  }

  if (!peerConnection) {

    createPeerConnection();

  }

  try {

    /*

     * OFFER

     */

    if (

      data.type === "offer"

    ) {

      await peerConnection.setRemoteDescription(

        new RTCSessionDescription(

          data.sdp

        )

      );

      const answer =

        await peerConnection.createAnswer();

      await peerConnection.setLocalDescription(

        answer

      );

      sendSignal({

        type: "answer",

        sdp: answer

      });

    }

    /*

     * ANSWER

     */

    if (

      data.type === "answer"

    ) {

      await peerConnection.setRemoteDescription(

        new RTCSessionDescription(

          data.sdp

        )

      );

    }

    /*

     * ICE

     */

    if (

      data.type === "ice"

    ) {

      try {

        await peerConnection.addIceCandidate(

          new RTCIceCandidate(

            data.candidate

          )

        );

      } catch (error) {

        console.error(

          "ICE error:",

          error

        );

      }

    }

  } catch (error) {

    console.error(

      "WebRTC signaling error:",

      error

    );

  }

}

/*

 * SEND SIGNAL THROUGH WEBSOCKET

 */

function sendSignal(data) {

  if (

    !socket ||

    socket.readyState !== WebSocket.OPEN

  ) {

    return;

  }

  socket.send(

    JSON.stringify({

      type: "signal",

      data: data

    })

  );

}

/*

 * CLOSE WEBRTC

 */

function closePeerConnection() {

  if (peerConnection) {

    try {

      peerConnection.close();

    } catch {}

    peerConnection = null;

  }

  const remoteVideo =

    document.getElementById(

      "remoteVideo"

    );

  if (remoteVideo) {

    remoteVideo.srcObject =

      null;

  }

  showRemotePlaceholder();

}

/*

 * CAMERA ON/OFF

 */

function toggleCamera() {

  if (!localStream) {

    return;

  }

  const videoTracks =

    localStream.getVideoTracks();

  if (!videoTracks.length) {

    return;

  }

  cameraEnabled =

    !cameraEnabled;

  videoTracks.forEach(

    track => {

      track.enabled =

        cameraEnabled;

    }

  );

  updateVideoButtons();

}

/*

 * MICROPHONE ON/OFF

 */

function toggleMicrophone() {

  if (!localStream) {

    return;

  }

  const audioTracks =

    localStream.getAudioTracks();

  if (!audioTracks.length) {

    return;

  }

  microphoneEnabled =

    !microphoneEnabled;

  audioTracks.forEach(

    track => {

      track.enabled =

        microphoneEnabled;

    }

  );

  updateVideoButtons();

}

/*

 * VIDEO BUTTON UI

 */

function updateVideoButtons() {

  const cameraButton =

    document.getElementById(

      "cameraButton"

    );

  const micButton =

    document.getElementById(

      "micButton"

    );

  if (cameraButton) {

    cameraButton.textContent =

      cameraEnabled

        ? "📷 Camera On"

        : "🚫 Camera Off";

    cameraButton.classList.toggle(

      "off",

      !cameraEnabled

    );

  }

  if (micButton) {

    micButton.textContent =

      microphoneEnabled

        ? "🎤 Microphone On"

        : "🔇 Microphone Off";

    micButton.classList.toggle(

      "off",

      !microphoneEnabled

    );

  }

}

/*

 * SHOW LOCAL VIDEO

 */

function showLocalVideo() {

  const placeholder =

    document.getElementById(

      "localPlaceholder"

    );

  if (placeholder) {

    placeholder.classList.add(

      "hidden"

    );

  }

}

/*

 * SHOW REMOTE PLACEHOLDER

 */

function showRemotePlaceholder() {

  const placeholder =

    document.getElementById(

      "remotePlaceholder"

    );

  if (placeholder) {

    placeholder.classList.remove(

      "hidden"

    );

  }

}

/*

 * HIDE REMOTE PLACEHOLDER

 */

function hideRemotePlaceholder() {

  const placeholder =

    document.getElementById(

      "remotePlaceholder"

    );

  if (placeholder) {

    placeholder.classList.add(

      "hidden"

    );

  }

}

/*

 * UI HELPERS

 */

function updateStatus(

  title,

  text,

  isConnected

) {

  const status =

    document.getElementById(

      "connectionStatus"

    );

  const description =

    document.getElementById(

      "connectionText"

    );

  status.textContent =

    title;

  description.textContent =

    text;

  status.className =

    isConnected

      ? "connected"

      : "waiting";

}

function setButton(text) {

  document.getElementById(

    "startNextButton"

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

    .getElementById("messages")

    .appendChild(div);

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

    .getElementById("messages")

    .appendChild(div);

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

    .getElementById("messages")

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

/*

 * OTHER UI

 */

function scrollToChat() {

  document

    .getElementById("chat")

    .scrollIntoView({

      behavior: "smooth"

    });

}

function showInfo() {

  alert(

    "RandomTalk matches you with another available person for a random text or video conversation."

  );

}

function reportUser() {

  if (!connected) {

    alert(

      "You are not currently connected."

    );

    return;

  }

  alert(

    "Report system will be connected to the moderation database next."

  );

}

/*

 * PAGE LOAD

 */

window.addEventListener(

  "load",

  () => {

    /*

     * Do not connect automatically.

     * User starts the chat.

     */

    updateVideoButtons();

  }

);

</script>

</body>

</html>`, {

      headers: {

        "content-type":

          "text/html; charset=UTF-8"

      }

    });

  }

};
