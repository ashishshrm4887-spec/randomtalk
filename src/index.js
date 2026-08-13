export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.waiting = {
      text: null,
      video: null
    };
    this.partners = new Map();
    this.modes = new Map();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("ChatRoom is running.");
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();

    server.addEventListener("message", event => {
      let data;

      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      if (data.type === "join") {
        const mode = data.mode === "video" ? "video" : "text";

        this.removeFromWaiting(server);
        this.modes.set(server, mode);

        const other = this.waiting[mode];

        if (
          other &&
          other !== server &&
          other.readyState === WebSocket.OPEN
        ) {
          this.waiting[mode] = null;

          this.partners.set(server, other);
          this.partners.set(other, server);

          server.send(JSON.stringify({
            type: "matched",
            mode,
            initiator: false
          }));

          other.send(JSON.stringify({
            type: "matched",
            mode,
            initiator: true
          }));
        } else {
          this.waiting[mode] = server;

          server.send(JSON.stringify({
            type: "waiting",
            mode
          }));
        }

        return;
      }

      if (data.type === "chat") {
        const partner = this.partners.get(server);

        if (partner && partner.readyState === WebSocket.OPEN) {
          partner.send(JSON.stringify({
            type: "chat",
            text: String(data.text || "").slice(0, 2000)
          }));
        }

        return;
      }

      if (data.type === "signal") {
        const partner = this.partners.get(server);

        if (partner && partner.readyState === WebSocket.OPEN) {
          partner.send(JSON.stringify({
            type: "signal",
            signal: data.signal
          }));
        }

        return;
      }

      if (data.type === "next") {
        const mode = this.modes.get(server) || "text";

        this.disconnectPair(server);
        this.waitForUser(server, mode);

        return;
      }

      if (data.type === "end") {
        this.disconnectPair(server);
        this.removeUser(server);
      }
    });

    const cleanup = () => {
      this.removeFromWaiting(server);

      const partner = this.partners.get(server);

      if (partner) {
        this.partners.delete(server);
        this.partners.delete(partner);

        if (partner.readyState === WebSocket.OPEN) {
          partner.send(JSON.stringify({
            type: "partner_left"
          }));

          const mode = this.modes.get(partner) || "text";

          this.waiting[mode] = partner;

          partner.send(JSON.stringify({
            type: "waiting",
            mode
          }));
        }
      }

      this.modes.delete(server);
    };

    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  waitForUser(socket, mode) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    mode = mode === "video" ? "video" : "text";

    this.removeFromWaiting(socket);
    this.modes.set(socket, mode);

    const other = this.waiting[mode];

    if (
      other &&
      other !== socket &&
      other.readyState === WebSocket.OPEN
    ) {
      this.waiting[mode] = null;

      this.partners.set(socket, other);
      this.partners.set(other, socket);

      socket.send(JSON.stringify({
        type: "matched",
        mode,
        initiator: false
      }));

      other.send(JSON.stringify({
        type: "matched",
        mode,
        initiator: true
      }));

      return;
    }

    this.waiting[mode] = socket;

    socket.send(JSON.stringify({
      type: "waiting",
      mode
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

  removeFromWaiting(socket) {
    if (this.waiting.text === socket) {
      this.waiting.text = null;
    }

    if (this.waiting.video === socket) {
      this.waiting.video = null;
    }
  }

  removeUser(socket) {
    this.removeFromWaiting(socket);
    this.partners.delete(socket);
    this.modes.delete(socket);
  }
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const id = env.CHAT.idFromName("global-chat-room");
      const room = env.CHAT.get(id);

      return room.fetch(request);
    }

    return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>RandomTalk</title>

<style>
* {
  box-sizing:border-box;
}

body {
  margin:0;
  background:
    radial-gradient(circle at 80% 20%,rgba(124,58,237,.18),transparent 30%),
    radial-gradient(circle at 20% 80%,rgba(217,70,239,.12),transparent 30%),
    #050816;
  color:#f8fafc;
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}

button,input,select {
  font:inherit;
}

button {
  cursor:pointer;
}

.container {
  width:min(1180px,calc(100% - 32px));
  margin:auto;
}

.navbar {
  height:82px;
  border-bottom:1px solid rgba(148,163,184,.12);
  display:flex;
  align-items:center;
}

.nav-inner {
  width:min(1180px,calc(100% - 32px));
  margin:auto;
  display:flex;
  align-items:center;
  justify-content:space-between;
}

.logo {
  display:flex;
  align-items:center;
  gap:10px;
  font-size:25px;
  font-weight:800;
}

.logo-icon {
  width:38px;
  height:38px;
  border-radius:13px;
  display:grid;
  place-items:center;
  background:linear-gradient(135deg,#a855f7,#6366f1);
}

.logo span {
  background:linear-gradient(90deg,#a855f7,#6366f1);
  -webkit-background-clip:text;
  color:transparent;
}

.nav-links {
  display:flex;
  gap:38px;
}

.nav-links a {
  color:#dbe3f1;
  text-decoration:none;
  font-weight:600;
}

.nav-actions {
  display:flex;
  gap:12px;
}

.language,.profile {
  border:1px solid #26324b;
  background:#0f172a;
  color:white;
}

.language {
  padding:11px 18px;
  border-radius:25px;
}

.profile {
  width:44px;
  height:44px;
  border-radius:50%;
}

.hero {
  padding:80px 0 55px;
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:55px;
  align-items:center;
}

.hero h1 {
  margin:0;
  font-size:clamp(48px,6vw,76px);
  line-height:1.02;
  letter-spacing:-3px;
}

.gradient-text {
  background:linear-gradient(90deg,#d946ef,#7c3aed,#6366f1);
  -webkit-background-clip:text;
  color:transparent;
}

.hero p {
  color:#aab5ca;
  font-size:21px;
  line-height:1.6;
  max-width:570px;
}

.stats {
  display:flex;
  gap:12px;
  flex-wrap:wrap;
  margin:25px 0;
}

.stat {
  background:#0f172acc;
  border:1px solid #1d2942;
  border-radius:12px;
  padding:11px 15px;
}

.online-dot {
  color:#4ade80;
}

.hero-buttons {
  display:flex;
  gap:14px;
  flex-wrap:wrap;
}

.primary-btn,.secondary-btn {
  padding:16px 25px;
  border-radius:14px;
  font-weight:800;
}

.primary-btn {
  color:white;
  border:0;
  background:linear-gradient(90deg,#d946ef,#7c3aed);
}

.secondary-btn {
  background:transparent;
  border:1px solid #34415d;
  color:white;
}

.hero-visual {
  min-height:380px;
  position:relative;
  display:flex;
  align-items:center;
  justify-content:center;
}

.orbit {
  width:250px;
  height:250px;
  border:1px dashed #8b5cf6;
  border-radius:50%;
  position:absolute;
}

.orbit-center {
  width:90px;
  height:90px;
  border-radius:50%;
  background:linear-gradient(135deg,#7c3aed,#c026d3);
  display:grid;
  place-items:center;
  font-size:38px;
}

.person-card {
  width:155px;
  padding:12px;
  border:1px solid #7652e8;
  background:#0f172aeb;
  border-radius:22px;
  position:absolute;
}

.person-card.left {
  left:5%;
  transform:rotate(-8deg);
}

.person-card.right {
  right:5%;
  transform:rotate(8deg);
}

.avatar {
  height:140px;
  border-radius:15px;
  background:linear-gradient(135deg,#312e81,#581c87);
  display:grid;
  place-items:center;
  font-size:65px;
}

.person-info {
  padding:10px 3px 3px;
  line-height:1.5;
}

.chat-app {
  border:1px solid #25304a;
  background:#080f20e8;
  border-radius:25px;
  overflow:hidden;
  margin-bottom:80px;
}

.chat-tabs {
  padding:18px;
  border-bottom:1px solid #202b42;
  display:flex;
  gap:10px;
}

.tab {
  flex:1;
  padding:15px;
  border-radius:14px;
  border:1px solid #26324b;
  background:transparent;
  color:#aeb9ce;
  font-weight:800;
}

.tab.active {
  color:white;
  background:linear-gradient(90deg,#a855f7,#6366f1);
  border-color:transparent;
}

.chat-layout {
  display:grid;
  grid-template-columns:270px 1fr;
}

.sidebar {
  padding:22px;
  border-right:1px solid #202b42;
}

.preference {
  margin:20px 0;
}

.preference-title {
  color:#aab5ca;
  margin-bottom:10px;
}

.preference-buttons {
  display:flex;
}

.preference-buttons button {
  flex:1;
  padding:11px;
  background:#111a2d;
  border:1px solid #27334d;
  color:white;
}

.preference-buttons .selected {
  background:#7c3aed;
}

.select-box {
  width:100%;
  padding:13px;
  border-radius:10px;
  background:#111a2d;
  border:1px solid #27334d;
  color:white;
}

.save-btn {
  width:100%;
  margin-top:10px;
  padding:13px;
  border:0;
  border-radius:11px;
  color:white;
  font-weight:800;
  background:linear-gradient(90deg,#c026d3,#7c3aed);
}

.tips {
  margin-top:35px;
  color:#aab5ca;
  line-height:1.9;
}

.chat-panel {
  min-height:620px;
  display:flex;
  flex-direction:column;
}

.chat-header {
  padding:20px 25px;
  border-bottom:1px solid #202b42;
  display:flex;
  align-items:center;
  justify-content:space-between;
}

.connected {
  color:#4ade80;
  font-weight:800;
}

.waiting {
  color:#fbbf24;
  font-weight:800;
}

.report {
  border:1px solid #6b2737;
  background:transparent;
  color:#fb7185;
  padding:9px 15px;
  border-radius:20px;
}

.video-area {
  display:none;
  padding:22px;
}

.video-area.show {
  display:block;
}

.video-box {
  position:relative;
  height:520px;
  border-radius:22px;
  overflow:hidden;
  background:#030712;
  border:1px solid #27334d;
}

#remoteVideo {
  width:100%;
  height:100%;
  object-fit:cover;
  background:#030712;
}

#localVideo {
  position:absolute;
  right:20px;
  bottom:20px;
  width:190px;
  height:135px;
  object-fit:cover;
  border-radius:16px;
  border:2px solid #7c3aed;
  background:#030712;
  z-index:5;
}

.video-placeholder {
  position:absolute;
  inset:0;
  display:grid;
  place-items:center;
  text-align:center;
  color:#94a3b8;
  font-size:20px;
}

.video-label {
  position:absolute;
  bottom:20px;
  left:20px;
  background:#000b;
  padding:10px 15px;
  border-radius:20px;
  z-index:6;
}

.video-controls {
  display:none;
  gap:10px;
  padding:15px 20px;
}

.video-controls.show {
  display:flex;
}

.control-btn {
  flex:1;
  padding:13px;
  border-radius:12px;
  background:#111a2d;
  border:1px solid #27334d;
  color:white;
  font-weight:700;
}

.messages {
  flex:1;
  padding:25px;
  display:flex;
  flex-direction:column;
  gap:16px;
  overflow-y:auto;
  max-height:430px;
}

.message {
  max-width:70%;
  padding:13px 17px;
  border-radius:17px;
  line-height:1.45;
}

.received {
  align-self:flex-start;
  background:#182238;
}

.sent {
  align-self:flex-end;
  background:linear-gradient(135deg,#6d28d9,#4f46e5);
}

.message small {
  display:block;
  opacity:.6;
  margin-top:4px;
  font-size:11px;
}

.message-input {
  margin:0 25px 20px;
  display:flex;
  gap:10px;
}

.message-input input {
  flex:1;
  padding:16px;
  border-radius:28px;
  background:#0c1426;
  border:1px solid #34415d;
  color:white;
  outline:none;
}

.send-btn {
  width:55px;
  height:55px;
  border-radius:50%;
  border:0;
  color:white;
  background:linear-gradient(135deg,#d946ef,#7c3aed);
}

.chat-actions {
  padding:20px;
  border-top:1px solid #202b42;
  display:grid;
  grid-template-columns:1fr 2fr;
  gap:15px;
}

.end-btn,.next-btn {
  padding:16px;
  border-radius:13px;
  font-weight:800;
}

.end-btn {
  color:#fb7185;
  background:#0b1222;
  border:1px solid #202b42;
}

.next-btn {
  color:white;
  border:0;
  background:linear-gradient(90deg,#d946ef,#7c3aed);
}

.footer {
  text-align:center;
  color:#64748b;
  padding:20px 0 50px;
}

@media(max-width:800px) {
  .nav-links {
    display:none;
  }

  .language {
    display:none;
  }

  .hero {
    grid-template-columns:1fr;
    padding-top:55px;
  }

  .hero h1 {
    font-size:50px;
  }

  .hero p {
    font-size:18px;
  }

  .hero-visual {
    min-height:330px;
    transform:scale(.85);
  }

  .chat-layout {
    grid-template-columns:1fr;
  }

  .sidebar {
    display:none;
  }

  .chat-actions {
    grid-template-columns:1fr;
  }

  .message {
    max-width:82%;
  }

  .video-box {
    height:430px;
  }

  #localVideo {
    width:125px;
    height:170px;
    right:12px;
    bottom:12px;
  }
}
</style>
</head>

<body>

<header class="navbar">
<div class="nav-inner">

<div class="logo">
<div class="logo-icon">💬</div>
Random<span>Talk</span>
</div>

<nav class="nav-links">
<a href="#">Home</a>
<a href="#chat">Chat</a>
<a href="#safety">Safety</a>
<a href="#about">About</a>
</nav>

<div class="nav-actions">
<button class="language">🌐 English</button>
<button class="profile">👤</button>
</div>

</div>
</header>

<main>

<section class="hero container">

<div>

<h1>
Talk to<br>
someone <span class="gradient-text">new.</span>
</h1>

<p>
Meet random people from around the world
through text or video chat.
</p>

<div class="stats">
<div class="stat">
<span class="online-dot">●</span>
Online now
</div>

<div class="stat">
👥 Random conversations
</div>
</div>

<div class="hero-buttons">
<button class="primary-btn" onclick="scrollToChat()">
🚀 Start Chatting
</button>

<button class="secondary-btn" onclick="showInfo()">
▶ How it works?
</button>
</div>

</div>

<div class="hero-visual">

<div class="orbit"></div>

<div class="person-card left">
<div class="avatar">👨🏻</div>
<div class="person-info">
🇮🇳 India<br>
Random User
</div>
</div>

<div class="orbit-center">💬</div>

<div class="person-card right">
<div class="avatar">👩🏻</div>
<div class="person-info">
🌎 Worldwide<br>
Random User
</div>
</div>

</div>
</section>


<section class="container" id="chat">

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

<h3>⚙️ Chat Preferences</h3>

<div class="preference">

<div class="preference-title">
I want to chat with
</div>

<div class="preference-buttons">
<button class="selected">Everyone</button>
<button>Gender</button>
</div>

</div>

<div class="preference">

<div class="preference-title">
Country
</div>

<select class="select-box">
<option>Any country</option>
<option>India 🇮🇳</option>
<option>United States 🇺🇸</option>
<option>United Kingdom 🇬🇧</option>
<option>Canada 🇨🇦</option>
</select>

</div>

<button class="save-btn">
✨ Save Preferences
</button>

<div class="tips" id="safety">

<h3>💡 Tips</h3>

• Be respectful<br>
• Don't share personal information<br>
• Report inappropriate users<br>
• Have fun and enjoy!

</div>

</aside>


<section class="chat-panel">

<div class="chat-header">

<div>

<div class="waiting" id="connectionStatus">
● Ready
</div>

<small id="connectionText">
Press Start Chatting to find someone
</small>

</div>

<button class="report" onclick="reportUser()">
⚠ Report
</button>

</div>


<div class="video-area" id="videoArea">

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

<div class="video-placeholder" id="videoPlaceholder">

<div>

<div style="font-size:60px;">
🎥
</div>

<div id="videoPlaceholderText">
Press Start Chatting to find a stranger's video...
</div>

</div>

</div>

<div class="video-label">
Stranger
</div>

</div>

</div>


<div class="video-controls" id="videoControls">

<button class="control-btn" onclick="toggleCamera()">
📷 Camera On
</button>

<button class="control-btn" onclick="toggleMicrophone()">
🎤 Microphone On
</button>

</div>


<div class="messages" id="messages">

<div class="message received">
👋 Welcome to RandomTalk!
<small>System</small>
</div>

<div class="message received">
Press <b>Start Chatting</b> to find a random person.
<small>System</small>
</div>

</div>


<div class="message-input">

<input
id="messageInput"
type="text"
placeholder="Start a chat first..."
disabled
onkeydown="handleEnter(event)"
>

<button class="send-btn" onclick="sendMessage()">
➤
</button>

</div>


<div class="chat-actions">

<button class="end-btn" onclick="endChat()">
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


<footer class="footer" id="about">
RandomTalk © 2026 · Talk safely. Meet someone new.
</footer>


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


/* =========================
   MODE
========================= */

function selectText() {
  currentMode = "text";

  document.getElementById("textTab")
    .classList.add("active");

  document.getElementById("videoTab")
    .classList.remove("active");

  document.getElementById("videoArea")
    .classList.remove("show");

  document.getElementById("videoControls")
    .classList.remove("show");
}


function selectVideo() {
  currentMode = "video";

  document.getElementById("videoTab")
    .classList.add("active");

  document.getElementById("textTab")
    .classList.remove("active");

  document.getElementById("videoArea")
    .classList.add("show");

  document.getElementById("videoControls")
    .classList.add("show");
}


/* =========================
   SOCKET
========================= */

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

  socket = new WebSocket(
    protocol + "//" + location.host + "/ws"
  );


  socket.addEventListener("open", () => {

    updateStatus(
      "● Searching...",
      currentMode === "video"
        ? "Looking for another video user..."
        : "Looking for a random person...",
      false
    );

    socket.send(JSON.stringify({
      type: "join",
      mode: currentMode
    }));

  });


  socket.addEventListener("message", async event => {

    let data;

    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }


    if (data.type === "waiting") {

      connected = false;

      updateStatus(
        "● Searching...",
        data.mode === "video"
          ? "Waiting for another video user..."
          : "Waiting for another person...",
        false
      );

      disableInput();
      setButton("⏳ Searching...");

      return;
    }


    if (data.type === "matched") {

      connected = true;

      isInitiator = data.initiator === true;

      currentMode =
        data.mode === "video"
          ? "video"
          : "text";

      updateStatus(
        "● Connected",
        currentMode === "video"
          ? "Video connection starting..."
          : "You are chatting with a random stranger",
        true
      );

      enableInput();
      setButton("⏭ Next");

      addSystemMessage(
        "🎉 You are connected! Say hello."
      );


      if (currentMode === "video") {

        selectVideo();

        try {

          await startLocalMedia();

          await createPeerConnection();

          if (isInitiator) {
            await createOffer();
          }

        } catch (error) {

          console.error(error);

          addSystemMessage(
            "⚠️ Camera/microphone could not be started. Check browser permissions."
          );

        }

      }

      return;
    }


    if (data.type === "chat") {

      addReceivedMessage(data.text);
      return;
    }


    if (data.type === "signal") {

      try {
        await handleSignal(data.signal);
      } catch (error) {
        console.error("Signal error:", error);
      }

      return;
    }


    if (data.type === "partner_left") {

      connected = false;

      closePeerConnection();

      updateStatus(
        "● Stranger left",
        "Searching for another person...",
        false
      );

      disableInput();
      setButton("⏳ Searching...");

      showVideoWaiting();

      addSystemMessage(
        "👋 The stranger left. Looking for someone else..."
      );

      return;
    }

  });


  socket.addEventListener("close", () => {

    connected = false;

    closePeerConnection();

    if (!intentionallyClosed) {

      updateStatus(
        "● Disconnected",
        "Connection lost. Press Start Chatting.",
        false
      );

      disableInput();
      setButton("🚀 Start Chatting");
    }

  });


  socket.addEventListener("error", () => {

    updateStatus(
      "● Connection error",
      "Please try again.",
      false
    );

  });
}


/* =========================
   CAMERA + MIC
========================= */

async function startLocalMedia() {

  if (localStream) {
    return localStream;
  }

  if (
    !navigator.mediaDevices ||
    !navigator.mediaDevices.getUserMedia
  ) {
    throw new Error("getUserMedia unavailable");
  }

  localStream =
    await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user"
      },
      audio: true
    });

  const localVideo =
    document.getElementById("localVideo");

  localVideo.srcObject = localStream;

  localVideo.muted = true;

  await localVideo.play().catch(() => {});

  cameraEnabled = true;
  microphoneEnabled = true;

  updateVideoButtons();

  return localStream;
}


/* =========================
   PEER CONNECTION
========================= */

async function createPeerConnection() {

  if (peerConnection) {
    return peerConnection;
  }

  peerConnection =
    new RTCPeerConnection(rtcConfig);


  if (localStream) {

    localStream.getTracks().forEach(track => {

      peerConnection.addTrack(
        track,
        localStream
      );

    });

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
        document.getElementById("remoteVideo");

      remoteVideo.srcObject =
        event.streams[0];

      remoteVideo.play().catch(() => {});

      document.getElementById(
        "videoPlaceholder"
      ).style.display = "none";

      document.getElementById(
        "videoPlaceholderText"
      ).textContent = "Video connected";

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

      socket.send(JSON.stringify({
        type: "signal",
        signal: {
          type: "ice",
          candidate: event.candidate
        }
      }));

    }
  );


  peerConnection.addEventListener(
    "connectionstatechange",
    () => {

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

        document.getElementById(
          "videoPlaceholder"
        ).style.display = "none";

        updateStatus(
          "● Connected",
          "You are on a video call with a stranger",
          true
        );

      }

      if (state === "failed") {

        document.getElementById(
          "videoPlaceholder"
        ).style.display = "grid";

        document.getElementById(
          "videoPlaceholderText"
        ).textContent =
          "Video connection failed. Try Next.";

      }

    }
  );

  return peerConnection;
}


/* =========================
   OFFER
========================= */

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
    socket.readyState === WebSocket.OPEN
  ) {

    socket.send(JSON.stringify({
      type: "signal",
      signal: {
        type: "offer",
        sdp: offer
      }
    }));

  }
}


/* =========================
   SIGNAL HANDLING
========================= */

async function handleSignal(signal) {

  if (!signal) {
    return;
  }


  if (!peerConnection) {

    await startLocalMedia();

    await createPeerConnection();

  }


  if (signal.type === "offer") {

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(signal.sdp)
    );

    await flushPendingIce();

    const answer =
      await peerConnection.createAnswer();

    await peerConnection.setLocalDescription(
      answer
    );

    socket.send(JSON.stringify({
      type: "signal",
      signal: {
        type: "answer",
        sdp: answer
      }
    }));

    return;
  }


  if (signal.type === "answer") {

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(signal.sdp)
    );

    await flushPendingIce();

    return;
  }


  if (
    signal.type === "ice" &&
    signal.candidate
  ) {

    if (
      peerConnection.remoteDescription &&
      peerConnection.remoteDescription.type
    ) {

      try {

        await peerConnection.addIceCandidate(
          new RTCIceCandidate(signal.candidate)
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


/* =========================
   ICE QUEUE
========================= */

async function flushPendingIce() {

  if (!peerConnection) {
    return;
  }

  const candidates =
    pendingIceCandidates;

  pendingIceCandidates = [];

  for (const candidate of candidates) {

    try {

      await peerConnection.addIceCandidate(
        new RTCIceCandidate(candidate)
      );

    } catch (error) {

      console.error(
        "Queued ICE error:",
        error
      );

    }

  }
}


/* =========================
   CLOSE VIDEO
========================= */

function closePeerConnection() {

  pendingIceCandidates = [];

  if (peerConnection) {

    try {
      peerConnection.close();
    } catch {}

    peerConnection = null;
  }

  const remoteVideo =
    document.getElementById("remoteVideo");

  if (remoteVideo) {
    remoteVideo.srcObject = null;
  }

  showVideoWaiting();
}


function showVideoWaiting() {

  const placeholder =
    document.getElementById("videoPlaceholder");

  const text =
    document.getElementById("videoPlaceholderText");

  if (placeholder) {
    placeholder.style.display = "grid";
  }

  if (text) {
    text.textContent =
      "Waiting for stranger's video...";
  }
}


/* =========================
   CAMERA
========================= */

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

  tracks.forEach(track => {
    track.enabled =
      cameraEnabled;
  });

  updateVideoButtons();
}


/* =========================
   MICROPHONE
========================= */

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

  tracks.forEach(track => {
    track.enabled =
      microphoneEnabled;
  });

  updateVideoButtons();
}


function updateVideoButtons() {

  const buttons =
    document.querySelectorAll(".control-btn");

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


/* =========================
   START / NEXT
========================= */

function startOrNext() {

  if (
    socket &&
    socket.readyState === WebSocket.OPEN &&
    connected
  ) {

    closePeerConnection();

    clearMessages();

    socket.send(JSON.stringify({
      type: "next"
    }));

    connected = false;

    updateStatus(
      "● Searching...",
      "Finding another person...",
      false
    );

    disableInput();

    setButton("⏳ Searching...");

    return;
  }


  intentionallyClosed = false;

  if (
    !socket ||
    socket.readyState !== WebSocket.OPEN
  ) {

    connectSocket();

  }

}


/* =========================
   CHAT
========================= */

function sendMessage() {

  const input =
    document.getElementById("messageInput");

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

  socket.send(JSON.stringify({
    type: "chat",
    text
  }));

  addSentMessage(text);

  input.value = "";
}


function handleEnter(event) {

  if (event.key === "Enter") {

    event.preventDefault();

    sendMessage();

  }
}


/* =========================
   END
========================= */

function endChat() {

  if (
    socket &&
    socket.readyState === WebSocket.OPEN
  ) {

    socket.send(JSON.stringify({
      type: "end"
    }));

    intentionallyClosed = true;

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

  setButton("🚀 Start Chatting");

  addSystemMessage("Chat ended.");
}


/* =========================
   UI
========================= */

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

  status.textContent = title;
  description.textContent = text;

  status.className =
    isConnected
      ? "connected"
      : "waiting";
}


function setButton(text) {

  document.getElementById(
    "startNextButton"
  ).textContent = text;
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
    document.createElement("div");

  div.className =
    "message received";

  div.textContent = text;

  document
    .getElementById("messages")
    .appendChild(div);

  scrollMessages();
}


function addReceivedMessage(text) {

  const div =
    document.createElement("div");

  div.className =
    "message received";

  div.textContent = text;

  document
    .getElementById("messages")
    .appendChild(div);

  scrollMessages();
}


function addSentMessage(text) {

  const div =
    document.createElement("div");

  div.className =
    "message sent";

  div.textContent = text;

  document
    .getElementById("messages")
    .appendChild(div);

  scrollMessages();
}


function scrollMessages() {

  const box =
    document.getElementById("messages");

  box.scrollTop =
    box.scrollHeight;
}


function scrollToChat() {

  document
    .getElementById("chat")
    .scrollIntoView({
      behavior:"smooth"
    });
}


function showInfo() {

  alert(
    "RandomTalk matches you with another available person for text or video chat."
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
    "Report system will be connected to the moderation database."
  );
}


window.addEventListener("load", () => {
  selectText();
});

</script>

</body>
</html>`, {
      headers: {
        "content-type": "text/html; charset=UTF-8"
      }
    });
  }
};
