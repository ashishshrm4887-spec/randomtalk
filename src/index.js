export default {
  async fetch(request, env) {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RandomTalk</title>

  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: Arial, sans-serif;
      background: #0b1020;
      color: white;
      min-height: 100vh;
    }

    .app {
      max-width: 900px;
      margin: auto;
      min-height: 100vh;
      padding: 20px;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 0 25px;
    }

    .logo {
      font-size: 28px;
      font-weight: 800;
    }

    .status {
      font-size: 13px;
      padding: 8px 12px;
      border-radius: 20px;
      background: #172033;
      color: #8df5b2;
    }

    .hero {
      text-align: center;
      padding: 35px 10px 25px;
    }

    .hero h1 {
      font-size: clamp(35px, 8vw, 65px);
      margin-bottom: 12px;
    }

    .hero p {
      color: #aeb8cc;
      font-size: 17px;
    }

    .card {
      background: #121a2d;
      border: 1px solid #25304a;
      border-radius: 24px;
      padding: 22px;
      margin-top: 25px;
    }

    .mode-buttons {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 20px;
    }

    button {
      border: none;
      cursor: pointer;
      color: white;
      font-size: 16px;
      font-weight: 700;
      border-radius: 14px;
      padding: 15px;
    }

    .mode {
      background: #1a243b;
      border: 1px solid #303c58;
    }

    .mode.active {
      background: #5b5cf0;
      border-color: #6b6cf5;
    }

    .video-area {
      height: 360px;
      background: #080c16;
      border-radius: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      overflow: hidden;
      position: relative;
    }

    .video-placeholder {
      color: #77829a;
    }

    .video-icon {
      font-size: 55px;
      margin-bottom: 12px;
    }

    .chat-area {
      display: none;
    }

    .chat-messages {
      height: 300px;
      overflow-y: auto;
      background: #080c16;
      border-radius: 18px;
      padding: 15px;
      margin-bottom: 12px;
    }

    .message {
      background: #1b2740;
      padding: 10px 13px;
      border-radius: 14px;
      margin-bottom: 9px;
      width: fit-content;
      max-width: 85%;
    }

    .message.you {
      background: #5b5cf0;
      margin-left: auto;
    }

    .message-input {
      display: flex;
      gap: 10px;
    }

    input {
      flex: 1;
      min-width: 0;
      background: #080c16;
      border: 1px solid #303c58;
      color: white;
      border-radius: 14px;
      padding: 15px;
      font-size: 16px;
      outline: none;
    }

    .send {
      background: #5b5cf0;
    }

    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 18px;
    }

    .start {
      background: #18b96b;
    }

    .next {
      background: #e05252;
    }

    .info {
      text-align: center;
      color: #7f8ba3;
      font-size: 13px;
      margin-top: 20px;
    }

    footer {
      text-align: center;
      color: #647089;
      padding: 30px 0;
      font-size: 13px;
    }

    @media (max-width: 600px) {
      .app {
        padding: 15px;
      }

      .video-area {
        height: 300px;
      }

      .actions {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>

<body>
  <div class="app">

    <header>
      <div class="logo">RandomTalk</div>
      <div class="status" id="status">● Online</div>
    </header>

    <section class="hero">
      <h1>Talk to someone new.</h1>
      <p>Meet random people through text or video chat.</p>
    </section>

    <section class="card">

      <div class="mode-buttons">
        <button class="mode active" id="textMode">
          💬 Text Chat
        </button>

        <button class="mode" id="videoMode">
          🎥 Video Chat
        </button>
      </div>

      <div class="video-area" id="videoArea">
        <div class="video-placeholder">
          <div class="video-icon">🎥</div>
          <div>Video chat will appear here</div>
          <small>Camera access will be added next.</small>
        </div>
      </div>

      <div class="chat-area" id="chatArea">
        <div class="chat-messages" id="messages">
          <div class="message">
            👋 Welcome to RandomTalk!
          </div>

          <div class="message">
            Press <b>Start Chat</b> to find someone.
          </div>
        </div>

        <div class="message-input">
          <input
            id="messageInput"
            type="text"
            placeholder="Type a message..."
          >

          <button class="send" id="sendButton">
            Send
          </button>
        </div>
      </div>

      <div class="actions">
        <button class="start" id="startButton">
          🚀 Start Chat
        </button>

        <button class="next" id="nextButton">
          ⏭ Next
        </button>
      </div>

      <div class="info" id="info">
        You're not connected to anyone yet.
      </div>

    </section>

    <footer>
      RandomTalk © 2026
    </footer>

  </div>

  <script>
    const textMode = document.getElementById("textMode");
    const videoMode = document.getElementById("videoMode");
    const videoArea = document.getElementById("videoArea");
    const chatArea = document.getElementById("chatArea");

    const startButton = document.getElementById("startButton");
    const nextButton = document.getElementById("nextButton");

    const status = document.getElementById("status");
    const info = document.getElementById("info");

    const messages = document.getElementById("messages");
    const messageInput = document.getElementById("messageInput");
    const sendButton = document.getElementById("sendButton");

    let connected = false;

    textMode.addEventListener("click", () => {
      textMode.classList.add("active");
      videoMode.classList.remove("active");

      videoArea.style.display = "none";
      chatArea.style.display = "block";
    });

    videoMode.addEventListener("click", () => {
      videoMode.classList.add("active");
      textMode.classList.remove("active");

      videoArea.style.display = "flex";
      chatArea.style.display = "none";
    });

    startButton.addEventListener("click", () => {
      connected = true;

      status.textContent = "● Searching...";
      status.style.color = "#ffd166";

      info.textContent = "Looking for a random person...";

      startButton.textContent = "🔎 Searching...";

      setTimeout(() => {
        status.textContent = "● Connected";
        status.style.color = "#8df5b2";

        info.textContent = "You are connected to a random person.";

        startButton.textContent = "🟢 Connected";

        if (textMode.classList.contains("active")) {
          addMessage("🎉 Stranger connected! Say hello.");
        }
      }, 1500);
    });

    nextButton.addEventListener("click", () => {
      connected = false;

      status.textContent = "● Online";
      status.style.color = "#8df5b2";

      info.textContent = "Finding another person...";

      startButton.textContent = "🔎 Searching...";

      setTimeout(() => {
        connected = true;

        status.textContent = "● Connected";
        info.textContent = "You are connected to a new random person.";
        startButton.textContent = "🟢 Connected";

        addMessage("👋 You found someone new!");
      }, 1200);
    });

    function addMessage(text, you = false) {
      const message = document.createElement("div");

      message.className = "message" + (you ? " you" : "");
      message.textContent = text;

      messages.appendChild(message);
      messages.scrollTop = messages.scrollHeight;
    }

    function sendMessage() {
      const text = messageInput.value.trim();

      if (!text) return;

      addMessage(text, true);
      messageInput.value = "";

      if (!connected) {
        addMessage("⚠️ Start a chat first.");
        return;
      }

      setTimeout(() => {
        addMessage("👤 Stranger received your message.");
      }, 600);
    }

    sendButton.addEventListener("click", sendMessage);

    messageInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        sendMessage();
      }
    });
  </script>

</body>
</html>`;

    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=UTF-8"
      }
    });
  }
};
