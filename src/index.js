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

      /* JOIN */

      if (data.type === "join") {
        const mode = data.mode === "video" ? "video" : "text";

        this.removeFromWaiting(server);
        this.modes.set(server, mode);

        this.matchUser(server, mode);
        return;
      }

      /* CHAT */

      if (data.type === "chat") {
        const partner = this.partners.get(server);

        if (partner?.readyState === WebSocket.OPEN) {
          partner.send(JSON.stringify({
            type: "chat",
            text: String(data.text || "").slice(0, 2000)
          }));
        }

        return;
      }

      /* WEBRTC SIGNALING */

      if (data.type === "signal") {
        const partner = this.partners.get(server);

        if (partner?.readyState === WebSocket.OPEN) {
          partner.send(JSON.stringify({
            type: "signal",
            signal: data.signal
          }));
        }

        return;
      }

      /* NEXT */

      if (data.type === "next") {
        const mode = this.modes.get(server) || "text";
        const partner = this.partners.get(server);

        this.disconnectPair(server);

        if (partner?.readyState === WebSocket.OPEN) {
          const partnerMode = this.modes.get(partner) || mode;

          partner.send(JSON.stringify({
            type: "partner_left"
          }));

          this.waitForUser(partner, partnerMode);
        }

        this.waitForUser(server, mode);

        return;
      }

      /* END */

      if (data.type === "end") {
        const partner = this.partners.get(server);

        this.disconnectPair(server);

        if (partner?.readyState === WebSocket.OPEN) {
          partner.send(JSON.stringify({
            type: "partner_left"
          }));
        }

        this.removeUser(server);
        return;
      }
    });

    const cleanup = () => {
      this.removeFromWaiting(server);

      const partner = this.partners.get(server);

      if (partner) {
        const mode = this.modes.get(partner) || "text";

        this.partners.delete(server);
        this.partners.delete(partner);

        if (partner.readyState === WebSocket.OPEN) {
          partner.send(JSON.stringify({
            type: "partner_left"
          }));

          this.waitForUser(partner, mode);
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

  matchUser(socket, mode) {
    const other = this.waiting[mode];

    if (
      other &&
      other !== socket &&
      other.readyState === WebSocket.OPEN
    ) {
      this.waiting[mode] = null;

      this.partners.set(socket, other);
      this.partners.set(other, socket);

      this.modes.set(socket, mode);
      this.modes.set(other, mode);

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

  waitForUser(socket, mode) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.removeFromWaiting(socket);

    mode = mode === "video" ? "video" : "text";

    this.modes.set(socket, mode);

    this.matchUser(socket, mode);
  }

  disconnectPair(socket) {
    const partner = this.partners.get(socket);

    if (!partner) {
      return null;
    }

    this.partners.delete(socket);
    this.partners.delete(partner);

    return partner;
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

    /* =========================
       WEBSOCKET
    ========================= */

    if (url.pathname === "/ws") {

      const id =
        env.CHAT.idFromName("global-chat-room");

      const room =
        env.CHAT.get(id);

      return room.fetch(request);
    }


    /* =========================
       WEBSITE
    ========================= */

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

body {
  margin: 0;
  background:
    radial-gradient(
      circle at 80% 20%,
      rgba(124,58,237,.18),
      transparent 30%
    ),
    #050816;

  color: white;

  font-family:
    Arial,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

button,
input {
  font: inherit;
}

button {
  cursor: pointer;
}

.container {
  width: min(1000px, calc(100% - 24px));
  margin: auto;
}


/* HEADER */

header {
  height: 70px;

  border-bottom:
    1px solid #202b42;

  display: flex;
  align-items: center;
}

.header-inner {
  width: min(1000px, calc(100% - 24px));
  margin: auto;

  display: flex;
  justify-content: space-between;
  align-items: center;
}

.logo {
  font-size: 25px;
  font-weight: 800;
}

.logo span {
  color: #a855f7;
}


/* HERO */

.hero {
  padding: 70px 0 40px;
  text-align: center;
}

.hero h1 {
  font-size: clamp(45px, 8vw, 75px);
  margin: 0;
}

.hero h1 span {
  color: #a855f7;
}

.hero p {
  color: #94a3b8;
  font-size: 19px;
  line-height: 1.6;
}

.hero-button {
  border: 0;
  border-radius: 14px;
  padding: 16px 25px;

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
  border:
    1px solid #26324b;

  background:
    rgba(8,15,32,.95);

  border-radius: 22px;
  overflow: hidden;

  margin-bottom: 60px;
}


/* TABS */

.tabs {
  display: flex;
  gap: 10px;
  padding: 15px;

  border-bottom:
    1px solid #202b42;
}

.tab {
  flex: 1;

  padding: 15px;

  border-radius: 13px;

  border:
    1px solid #293650;

  background:
    transparent;

  color: #94a3b8;

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


/* STATUS */

.status {
  padding: 20px;

  border-bottom:
    1px solid #202b42;

  display: flex;
  justify-content: space-between;
  align-items: center;
}

.status-title {
  font-weight: 800;
  font-size: 20px;
}

.status-description {
  color: #94a3b8;
  margin-top: 5px;
}

.status.waiting .status-title {
  color: #fbbf24;
}

.status.connected .status-title {
  color: #4ade80;
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

  height: 500px;

  border-radius: 18px;

  overflow: hidden;

  background: #020617;

  border:
    1px solid #293650;
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

  width: 160px;
  height: 120px;

  object-fit: cover;

  border-radius: 14px;

  border:
    2px solid #7c3aed;

  background: #020617;

  z-index: 5;
}

.placeholder {
  position: absolute;

  inset: 0;

  display: grid;

  place-items: center;

  text-align: center;

  color: #94a3b8;

  font-size: 19px;
}

.placeholder-icon {
  font-size: 60px;
}


/* VIDEO CONTROLS */

.video-controls {
  display: none;

  gap: 10px;

  padding: 15px;
}

.video-controls.show {
  display: flex;
}

.video-control {
  flex: 1;

  padding: 13px;

  border-radius: 12px;

  border:
    1px solid #293650;

  background:
    #111a2d;

  color: white;

  font-weight: 700;
}


/* MESSAGES */

.messages {
  min-height: 250px;
  max-height: 400px;

  padding: 20px;

  overflow-y: auto;

  display: flex;

  flex-direction: column;

  gap: 12px;
}

.message {
  max-width: 75%;

  padding: 13px 16px;

  border-radius: 16px;

  line-height: 1.4;
}

.received {
  align-self: flex-start;

  background:
    #182238;
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


/* INPUT */

.input-area {
  display: flex;

  gap: 10px;

  padding: 15px;
}

#messageInput {
  flex: 1;

  min-width: 0;

  padding: 15px;

  border-radius: 25px;

  border:
    1px solid #34415d;

  background:
    #0c1426;

  color: white;

  outline: none;
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


/* ACTIONS */

.actions {
  display: grid;

  grid-template-columns:
    1fr 2fr;

  gap: 10px;

  padding: 15px;

  border-top:
    1px solid #202b42;
}

.action {
  padding: 15px;

  border-radius: 13px;

  font-weight: 800;
}

.end {
  color: #fb7185;

  background:
    #0b1222;

  border:
    1px solid #293650;
}

.start {
  color: white;

  border: 0;

  background:
    linear-gradient(
      90deg,
      #d946ef,
      #7c3aed
    );
}


/* REPORT */

.report {
  padding: 10px 15px;

  border-radius: 20px;

  border:
    1px solid #6b2737;

  background:
    transparent;

  color: #fb7185;
}


/* MOBILE */

@media(max-width:700px) {

  .hero {
    padding-top: 45px;
  }

  .video-box {
    height: 430px;
  }

  #localVideo {
    width: 125px;
    height: 150px;
  }

  .actions {
    grid-template-columns: 1fr;
  }

  .message {
    max-width: 85%;
  }
}

</style>

</head>


<body>


<header>

<div class="header-inner">

<div class="logo">
💬 Random<span>Talk</span>
</div>

<div>
🌐
</div>

</div>

</header>


<main>


<section class="hero container">

<h1>
Talk to someone
<span>new.</span>
</h1>

<p>
Meet random people through text or video chat.
</p>

<button
class="hero-button"
id="heroStart"
>
🚀 Start Chatting
</button>

</section>


<section
class="container"
id="chat"
>

<div class="app">


<div class="tabs">

<button
class="tab active"
id="textTab"
>
💬 Text Chat
</button>

<button
class="tab"
id="videoTab"
>
🎥 Video Chat
</button>

</div>


<div
class="status waiting"
id="status"
>

<div>

<div
class="status-title"
id="statusTitle"
>
● Ready
</div>

<div
class="status-description"
id="statusDescription"
>
Press Start Chatting to find someone
</div>

</div>


<button
class="report"
id="reportButton"
>
⚠ Report
</button>

</div>


<!-- VIDEO -->

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
class="placeholder"
id="placeholder"
>

<div>

<div class="placeholder-icon">
🎥
</div>

<div id="placeholderText">
Waiting for stranger's video...
</div>

</div>

</div>

</div>

</div>


<div
class="video-controls"
id="videoControls"
>

<button
class="video-control"
id="cameraButton"
>
📷 Camera On
</button>

<button
class="video-control"
id="micButton"
>
🎤 Microphone On
</button>

</div>


<!-- MESSAGES -->

<div
class="messages"
id="messages"
>

<div class="message received">
👋 Welcome to RandomTalk!
</div>

<div class="message received">
Press Start Chatting to find a random person.
</div>

</div>


<!-- INPUT -->

<div class="input-area">

<input
id="messageInput"
type="text"
placeholder="Start a chat first..."
disabled
>

<button
class="send"
id="sendButton"
>
➤
</button>

</div>


<!-- ACTIONS -->

<div class="actions">

<button
class="action end"
id="endButton"
>
⏹ End Chat
</button>

<button
class="action start"
id="startButton"
>
🚀 Start Chatting
</button>

</div>


</div>

</section>

</main>


<script>

"use strict";


/* =========================
   VARIABLES
========================= */

let socket = null;

let connected = false;

let currentMode = "text";

let localStream = null;

let peerConnection = null;

let isInitiator = false;

let cameraEnabled = true;

let microphoneEnabled = true;

let pendingIce = [];


/* =========================
   WEBRTC
========================= */

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


/* =========================
   ELEMENTS
========================= */

const textTab =
  document.getElementById("textTab");

const videoTab =
  document.getElementById("videoTab");

const videoArea =
  document.getElementById("videoArea");

const videoControls =
  document.getElementById("videoControls");

const status =
  document.getElementById("status");

const statusTitle =
  document.getElementById("statusTitle");

const statusDescription =
  document.getElementById("statusDescription");

const startButton =
  document.getElementById("startButton");

const heroStart =
  document.getElementById("heroStart");

const endButton =
  document.getElementById("endButton");

const sendButton =
  document.getElementById("sendButton");

const messageInput =
  document.getElementById("messageInput");

const messages =
  document.getElementById("messages");

const remoteVideo =
  document.getElementById("remoteVideo");

const localVideo =
  document.getElementById("localVideo");

const placeholder =
  document.getElementById("placeholder");

const placeholderText =
  document.getElementById("placeholderText");

const cameraButton =
  document.getElementById("cameraButton");

const micButton =
  document.getElementById("micButton");

const reportButton =
  document.getElementById("reportButton");


/* =========================
   STATUS
========================= */

function setStatus(title, description, connectedState) {

  statusTitle.textContent = title;

  statusDescription.textContent =
    description;

  status.className =
    connectedState
      ? "status connected"
      : "status waiting";
}


/* =========================
   MODE
========================= */

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


/* =========================
   BUTTON EVENTS
========================= */

textTab.addEventListener(
  "click",
  selectText
);

videoTab.addEventListener(
  "click",
  selectVideo
);


heroStart.addEventListener(
  "click",
  () => {

    document
      .getElementById("chat")
      .scrollIntoView({
        behavior: "smooth"
      });

    startOrNext();

  }
);


startButton.addEventListener(
  "click",
  startOrNext
);


endButton.addEventListener(
  "click",
  endChat
);


sendButton.addEventListener(
  "click",
  sendMessage
);


messageInput.addEventListener(
  "keydown",
  event => {

    if (event.key === "Enter") {

      event.preventDefault();

      sendMessage();

    }

  }
);


cameraButton.addEventListener(
  "click",
  toggleCamera
);


micButton.addEventListener(
  "click",
  toggleMicrophone
);


reportButton.addEventListener(
  "click",
  () => {

    if (!connected) {

      alert(
        "You are not currently connected."
      );

      return;
    }

    alert(
      "Report system is not connected to a database yet."
    );

  }
);


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

      setStatus(
        "● Searching...",
        currentMode === "video"
          ? "Looking for another video user..."
          : "Looking for another person...",
        false
      );

      startButton.textContent =
        "⏳ Searching...";


      socket.send(
        JSON.stringify({
          type: "join",
          mode: currentMode
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


      /* WAITING */

      if (data.type === "waiting") {

        connected = false;

        setStatus(
          "● Searching...",
          data.mode === "video"
            ? "Waiting for another video user..."
            : "Waiting for another person...",
          false
        );

        disableInput();

        startButton.textContent =
          "⏳ Searching...";

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


        setStatus(
          "● Connected",
          currentMode === "video"
            ? "Starting video connection..."
            : "You are chatting with a random stranger",
          true
        );


        enableInput();

        startButton.textContent =
          "⏭ Next";


        addMessage(
          "🎉 You are connected! Say hello.",
          "received"
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

            console.error(error);

            addMessage(
              "⚠️ Camera or microphone permission failed.",
              "received"
            );

          }

        }

        return;
      }


      /* CHAT */

      if (data.type === "chat") {

        addMessage(
          data.text,
          "received"
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

        setStatus(
          "● Searching...",
          "The stranger left. Finding another person...",
          false
        );

        startButton.textContent =
          "⏳ Searching...";

        addMessage(
          "👋 The stranger left. Looking for someone else...",
          "received"
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

      disableInput();

      setStatus(
        "● Disconnected",
        "Press Start Chatting to try again.",
        false
      );

      startButton.textContent =
        "🚀 Start Chatting";

    }
  );


  socket.addEventListener(
    "error",
    () => {

      setStatus(
        "● Connection error",
        "Please try again.",
        false
      );

    }
  );
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

    socket.send(
      JSON.stringify({
        type: "next"
      })
    );

    connected = false;

    disableInput();

    setStatus(
      "● Searching...",
      "Finding another person...",
      false
    );

    startButton.textContent =
      "⏳ Searching...";

    return;
  }


  if (
    !socket ||
    socket.readyState === WebSocket.CLOSED
  ) {

    connectSocket();

  }

}


/* =========================
   CAMERA
========================= */

async function startLocalMedia() {

  if (localStream) {

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
    await navigator.mediaDevices.getUserMedia({

      video: {
        facingMode: "user"
      },

      audio: true

    });


  localVideo.srcObject =
    localStream;

  localVideo.muted = true;

  try {

    await localVideo.play();

  } catch {}


  cameraEnabled = true;

  microphoneEnabled = true;

  updateControls();


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
    new RTCPeerConnection(
      rtcConfig
    );


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


  peerConnection.addEventListener(
    "track",
    event => {

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
        .catch(() => {});


      placeholder.style.display =
        "none";


      setStatus(
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
    () => {

      if (!peerConnection) {

        return;

      }


      const state =
        peerConnection.connectionState;


      console.log(
        "WebRTC:",
        state
      );


      if (
        state === "connected"
      ) {

        placeholder.style.display =
          "none";

      }


      if (
        state === "failed"
      ) {

        placeholder.style.display =
          "grid";

        placeholderText.textContent =
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


/* =========================
   SIGNAL
========================= */

async function handleSignal(signal) {

  if (!signal) {

    return;

  }


  if (!peerConnection) {

    await startLocalMedia();

    await createPeerConnection();

  }


  /* OFFER */

  if (
    signal.type === "offer"
  ) {

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(
        signal.sdp
      )
    );


    await flushPendingIce();


    const answer =
      await peerConnection.createAnswer();


    await peerConnection.setLocalDescription(
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


  /* ANSWER */

  if (
    signal.type === "answer"
  ) {

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(
        signal.sdp
      )
    );


    await flushPendingIce();

    return;
  }


  /* ICE */

  if (
    signal.type === "ice" &&
    signal.candidate
  ) {

    if (
      peerConnection.remoteDescription
    ) {

      try {

        await peerConnection.addIceCandidate(
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

      pendingIce.push(
        signal.candidate
      );

    }

  }

}


/* =========================
   ICE
========================= */

async function flushPendingIce() {

  if (!peerConnection) {

    return;

  }


  const candidates =
    pendingIce;

  pendingIce = [];


  for (
    const candidate
    of candidates
  ) {

    try {

      await peerConnection.addIceCandidate(
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


/* =========================
   CLOSE VIDEO
========================= */

function closePeerConnection() {

  pendingIce = [];


  if (peerConnection) {

    try {

      peerConnection.close();

    } catch {}

    peerConnection = null;

  }


  if (remoteVideo) {

    remoteVideo.srcObject = null;

  }


  placeholder.style.display =
    "grid";

  placeholderText.textContent =
    "Waiting for stranger's video...";
}


/* =========================
   CAMERA BUTTON
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


  tracks.forEach(
    track => {
      track.enabled =
        cameraEnabled;
    }
  );


  updateControls();
}


/* =========================
   MICROPHONE BUTTON
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


  tracks.forEach(
    track => {
      track.enabled =
        microphoneEnabled;
    }
  );


  updateControls();
}


/* =========================
   CONTROL TEXT
========================= */

function updateControls() {

  cameraButton.textContent =
    cameraEnabled
      ? "📷 Camera On"
      : "📷 Camera Off";


  micButton.textContent =
    microphoneEnabled
      ? "🎤 Microphone On"
      : "🔇 Microphone Off";

}


/* =========================
   CHAT MESSAGE
========================= */

function sendMessage() {

  const text =
    messageInput.value.trim();


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

      type: "chat",

      text

    })
  );


  addMessage(
    text,
    "sent"
  );


  messageInput.value = "";

}


function addMessage(
  text,
  type
) {

  const div =
    document.createElement("div");


  div.className =
    "message " + type;


  div.textContent =
    text;


  messages.appendChild(div);


  messages.scrollTop =
    messages.scrollHeight;

}


function clearMessages() {

  messages.innerHTML = "";

}


/* =========================
   INPUT
========================= */

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


/* =========================
   END
========================= */

function endChat() {

  if (
    socket &&
    socket.readyState === WebSocket.OPEN
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

  setStatus(
    "● Offline",
    "Chat ended.",
    false
  );

  startButton.textContent =
    "🚀 Start Chatting";


  addMessage(
    "Chat ended.",
    "received"
  );

}


/* =========================
   INITIAL
========================= */

selectText();

updateControls();

disableInput();

console.log(
  "RandomTalk JavaScript loaded successfully."
);window.reportUser = function () {
  if (!connected) {
    alert("You are not currently connected.");
    return;
  }

  const reason = prompt(
    "Report reason:\n\n" +
    "1 - Nudity / sexual content\n" +
    "2 - Harassment / bullying\n" +
    "3 - Threats / violence\n" +
    "4 - Spam / scam\n" +
    "5 - Underage concern\n" +
    "6 - Other"
  );

  if (!reason) return;

  alert("Thank you. Your report has been received.");
};

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
