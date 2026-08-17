import { DurableObject } from "cloudflare:workers";

/* =========================================================
   RANDOMTALK
   VIDEO CHAT ONLY
   + In-video text messaging
   + Gender matching
   + Country matching
   + Report
   + WebRTC recovery
========================================================= */


/* =========================================================
   DURABLE OBJECT
========================================================= */

export class ChatRoom extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);

    this.ctx = ctx;
    this.env = env;
  }


  /* =======================================================
     HELPERS
  ======================================================= */

  send(ws, data) {

    if (
      !ws ||
      ws.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    try {
      ws.send(JSON.stringify(data));
    } catch (error) {
      console.error("Send error:", error);
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
      console.error(
        "Attachment error:",
        error
      );
    }
  }


  getSockets() {
    return this.ctx.getWebSockets();
  }


  findById(id) {

    if (!id) {
      return null;
    }

    for (
      const ws of this.getSockets()
    ) {

      const info =
        this.getInfo(ws);

      if (info.id === id) {
        return ws;
      }
    }

    return null;
  }


  /* =======================================================
     MATCHING
  ======================================================= */

  canMatch(a, b) {

    if (!a || !b) {
      return false;
    }


    if (
      a.status !== "waiting" ||
      b.status !== "waiting"
    ) {
      return false;
    }


    /*
      Video users only.
    */

    if (
      a.mode !== "video" ||
      b.mode !== "video"
    ) {
      return false;
    }


    /*
      Country.
    */

    const countryA =
      String(a.country || "any")
        .toLowerCase();

    const countryB =
      String(b.country || "any")
        .toLowerCase();


    const countryOK =
      countryA === "any" ||
      countryB === "any" ||
      countryA === countryB;


    if (!countryOK) {
      return false;
    }


    /*
      Gender preference.
    */

    const genderA =
      a.gender || "other";

    const genderB =
      b.gender || "other";


    const wantsA =
      a.preferredGender || "any";

    const wantsB =
      b.preferredGender || "any";


    const genderAOK =
      wantsA === "any" ||
      wantsA === genderB;


    const genderBOK =
      wantsB === "any" ||
      wantsB === genderA;


    return (
      genderAOK &&
      genderBOK
    );
  }


  findMatch(ws) {

    const user =
      this.getInfo(ws);


    for (
      const other of this.getSockets()
    ) {

      if (other === ws) {
        continue;
      }


      if (
        other.readyState !==
        WebSocket.OPEN
      ) {
        continue;
      }


      const otherInfo =
        this.getInfo(other);


      if (
        this.canMatch(
          user,
          otherInfo
        )
      ) {
        return other;
      }
    }


    return null;
  }




  /* =======================================================
     ADMIN DATA
  ======================================================= */

  async adminStats() {
    const users = [];
    let sockets = [];

    try {
      sockets = this.getSockets() || [];
    } catch (e) {
      console.error("adminStats getSockets error:", e);
      sockets = [];
    }

    for (const ws of sockets) {
      try {
        // Count OPEN sockets. Hibernated sockets also report as OPEN in DO API.
        if (ws.readyState !== WebSocket.OPEN && ws.readyState !== 1) continue;

        const info = this.getInfo(ws) || {};

        users.push({
          id: info.id || "unknown",
          status: info.status || "idle",
          mode: info.mode || "video",
          gender: info.gender || "other",
          country: info.country || "any",
          partnerId: info.partnerId || null,
          joinedAt: info.joinedAt || null
        });
      } catch (e) {
        console.error("adminStats user read error:", e);
      }
    }

    return {
      online: users.length,
      waiting: users.filter(u => u.status === "waiting").length,
      matched: users.filter(u => u.status === "matched").length,
      idle: users.filter(u => u.status === "idle").length,
      users,
      serverTime: new Date().toISOString(),
      socketCount: sockets.length
    };
  }

  async adminListReports() {
    const result = await this.ctx.storage.list({ prefix: "report:" });
    const reports = [];

    for (const value of result.values()) {
      if (value && typeof value === "object") {
        reports.push({
          ...value,
          status: value.status || "pending"
        });
      }
    }

    reports.sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
    );

    return reports;
  }

  async adminUpdateReport(id, status) {
    if (!id || !["pending", "reviewed", "resolved"].includes(status)) {
      return false;
    }

    const key = "report:" + id;
    const report = await this.ctx.storage.get(key);

    if (!report) return false;

    await this.ctx.storage.put(key, {
      ...report,
      status,
      updatedAt: new Date().toISOString()
    });

    return true;
  }

  async adminDeleteReport(id) {
    if (!id) return false;

    const key = "report:" + id;
    const report = await this.ctx.storage.get(key);

    if (!report) return false;

    await this.ctx.storage.delete(key);
    return true;
  }

  /* =======================================================
     CONNECTION
  ======================================================= */

  async fetch(request) {

    const url = new URL(request.url);

    if (request.headers.get("x-randomtalk-admin-action") === "1") {
      if (url.pathname === "/_admin/stats") {
        return Response.json(await this.adminStats());
      }

      if (url.pathname === "/_admin/reports") {
        return Response.json(await this.adminListReports());
      }

      if (url.pathname === "/_admin/report/status" && request.method === "POST") {
        let body;
        try {
          body = await request.json();
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
        }

        const ok = await this.adminUpdateReport(body.id, body.status);
        return Response.json({ ok }, { status: ok ? 200 : 404 });
      }

      if (url.pathname === "/_admin/report/delete" && request.method === "POST") {
        let body;
        try {
          body = await request.json();
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
        }

        const ok = await this.adminDeleteReport(body.id);
        return Response.json({ ok }, { status: ok ? 200 : 404 });
      }

      return Response.json({ ok: false, error: "Not found." }, { status: 404 });
    }

    if (
      request.headers.get("Upgrade")
        ?.toLowerCase() !== "websocket"
    ) {

      return new Response(
        "RandomTalk Video ChatRoom is running.",
        {
          status: 200
        }
      );
    }


    const pair =
      new WebSocketPair();


    const client =
      pair[0];

    const server =
      pair[1];


    this.ctx.acceptWebSocket(
      server
    );


    const id =
      crypto.randomUUID();


    this.setInfo(server, {

      id,

      mode: "video",

      status: "idle",

      gender: "other",

      preferredGender: "any",

      country: "any",

      partnerId: null,

      joinedAt: Date.now()

    });


    return new Response(
      null,
      {
        status: 101,
        webSocket: client
      }
    );
  }


  /* =======================================================
     MESSAGE
  ======================================================= */

  async webSocketMessage(
    ws,
    message
  ) {

    let data;


    try {

      if (
        typeof message ===
        "string"
      ) {

        data =
          JSON.parse(message);

      } else {

        data =
          JSON.parse(
            new TextDecoder()
              .decode(message)
          );
      }

    } catch {

      this.send(ws, {
        type: "error",
        message:
          "Invalid message."
      });

      return;
    }


    if (
      !data ||
      !data.type
    ) {
      return;
    }


    /* =====================================================
       JOIN
    ===================================================== */

    if (
      data.type === "join"
    ) {

      const oldInfo =
        this.getInfo(ws);


      const gender =
        [
          "male",
          "female",
          "other"
        ].includes(
          data.gender
        )
          ? data.gender
          : "other";


      const preferredGender =
        [
          "male",
          "female",
          "other",
          "any"
        ].includes(
          data.preferredGender
        )
          ? data.preferredGender
          : "any";


      const country =
        typeof data.country ===
        "string"
          ? data.country
              .trim()
              .slice(0, 40)
              .toLowerCase()
          : "any";


      const info = {

        ...oldInfo,

        mode: "video",

        status: "waiting",

        gender,

        preferredGender,

        country:
          country || "any",

        partnerId: null

      };


      this.setInfo(
        ws,
        info
      );


      const other =
        this.findMatch(ws);


      if (!other) {

        this.send(ws, {

          type: "waiting",

          message:
            "Looking for another person..."

        });

        return;
      }


      const otherInfo =
        this.getInfo(other);


      const thisId =
        info.id;

      const otherId =
        otherInfo.id;


      this.setInfo(
        ws,
        {
          ...info,
          status: "matched",
          partnerId: otherId
        }
      );


      this.setInfo(
        other,
        {
          ...otherInfo,
          status: "matched",
          partnerId: thisId
        }
      );


      /*
        Caller.
      */

      this.send(ws, {

        type: "matched",

        role: "caller",

        partnerId: otherId,

        mode: "video"

      });


      /*
        Callee.
      */

      this.send(other, {

        type: "matched",

        role: "callee",

        partnerId: thisId,

        mode: "video"

      });


      return;
    }


    /* =====================================================
       CHAT MESSAGE
    ===================================================== */

    if (
      data.type === "chat"
    ) {

      const info =
        this.getInfo(ws);


      if (
        info.status !==
        "matched" ||
        !info.partnerId
      ) {
        return;
      }


      const partner =
        this.findById(
          info.partnerId
        );


      if (!partner) {
        return;
      }


      const text =
        String(
          data.text || ""
        )
          .trim()
          .slice(0, 500);


      if (!text) {
        return;
      }


      this.send(
        partner,
        {

          type: "chat",

          text

        }
      );


      return;
    }


    /* =====================================================
       WEBRTC SIGNAL
    ===================================================== */

    if (
      data.type ===
      "signal"
    ) {

      const info =
        this.getInfo(ws);


      if (
        !info.partnerId
      ) {
        return;
      }


      const partner =
        this.findById(
          info.partnerId
        );


      if (!partner) {
        return;
      }


      this.send(
        partner,
        {

          type: "signal",

          signal:
            data.signal

        }
      );


      return;
    }


    /* =====================================================
       NEXT
    ===================================================== */

    if (
      data.type === "next"
    ) {

      const info =
        this.getInfo(ws);


      const partner =
        info.partnerId
          ? this.findById(
              info.partnerId
            )
          : null;


      /*
        Tell current partner.
      */

      if (partner) {

        const partnerInfo =
          this.getInfo(
            partner
          );


        this.setInfo(
          partner,
          {

            ...partnerInfo,

            status: "waiting",

            partnerId: null

          }
        );


        this.send(
          partner,
          {

            type:
              "partner_left",

            message:
              "Your partner moved to another person."

          }
        );


        /*
          Try to find another
          person for partner.
        */

        const newPartner =
          this.findMatch(
            partner
          );


        if (newPartner) {

          const newInfo =
            this.getInfo(
              newPartner
            );


          this.setInfo(
            partner,
            {

              ...partnerInfo,

              status:
                "matched",

              partnerId:
                newInfo.id

            }
          );


          this.setInfo(
            newPartner,
            {

              ...newInfo,

              status:
                "matched",

              partnerId:
                partnerInfo.id

            }
          );


          this.send(
            partner,
            {

              type:
                "matched",

              role:
                "caller",

              mode:
                "video",

              partnerId:
                newInfo.id

            }
          );


          this.send(
            newPartner,
            {

              type:
                "matched",

              role:
                "callee",

              mode:
                "video",

              partnerId:
                partnerInfo.id

            }
          );
        }
      }


      /*
        Current user becomes waiting.
      */

      this.setInfo(
        ws,
        {

          ...info,

          status:
            "waiting",

          partnerId:
            null

        }
      );


      const match =
        this.findMatch(ws);


      if (match) {

        const matchInfo =
          this.getInfo(
            match
          );


        this.setInfo(
          ws,
          {

            ...info,

            status:
              "matched",

            partnerId:
              matchInfo.id

          }
        );


        this.setInfo(
          match,
          {

            ...matchInfo,

            status:
              "matched",

            partnerId:
              info.id

          }
        );


        this.send(
          ws,
          {

            type:
              "matched",

            role:
              "caller",

            mode:
              "video",

            partnerId:
              matchInfo.id

          }
        );


        this.send(
          match,
          {

            type:
              "matched",

            role:
              "callee",

            mode:
              "video",

            partnerId:
              info.id

          }
        );


      } else {

        this.send(
          ws,
          {

            type:
              "waiting",

            message:
              "Looking for another person..."

          }
        );
      }


      return;
    }


    /* =====================================================
       END
    ===================================================== */

    if (
      data.type === "end"
    ) {

      const info =
        this.getInfo(ws);


      const partner =
        info.partnerId
          ? this.findById(
              info.partnerId
            )
          : null;


      if (partner) {

        const partnerInfo =
          this.getInfo(
            partner
          );


        this.setInfo(
          partner,
          {

            ...partnerInfo,

            status:
              "idle",

            partnerId:
              null

          }
        );


        this.send(
          partner,
          {

            type:
              "partner_left",

            message:
              "Chat ended."

          }
        );
      }


      this.setInfo(
        ws,
        {

          ...info,

          status:
            "idle",

          partnerId:
            null

        }
      );


      return;
    }


    /* =====================================================
       REPORT
    ===================================================== */

    if (
      data.type ===
      "report"
    ) {

      const info =
        this.getInfo(ws);


      const report = {

        id:
          crypto.randomUUID(),

        createdAt:
          new Date()
            .toISOString(),

        reason:
          String(
            data.reason ||
            "Other"
          )
            .trim()
            .slice(0, 100),

        details:
          String(
            data.details ||
            ""
          )
            .trim()
            .slice(0, 500),

        reporterId:
          info.id ||
          "unknown",

        reportedUserId:
          info.partnerId ||
          "unknown",

        mode:
          "video",

        country:
          info.country ||
          "unknown"

      };


      await this.ctx.storage.put(

        "report:" +
        report.id,

        report

      );


      this.send(
        ws,
        {

          type:
            "report_success",

          message:
            "Report submitted successfully."

        }
      );


      return;
    }


    /* =====================================================
       PING
    ===================================================== */

    if (
      data.type ===
      "ping"
    ) {

      this.send(
        ws,
        {
          type: "pong"
        }
      );
    }
  }


  /* =======================================================
     CLOSE
  ======================================================= */

  async webSocketClose(
    ws
  ) {

    const info =
      this.getInfo(ws);


    const partner =
      info.partnerId
        ? this.findById(
            info.partnerId
          )
        : null;


    if (partner) {

      const partnerInfo =
        this.getInfo(
          partner
        );


      this.setInfo(
        partner,
        {

          ...partnerInfo,

          status:
            "idle",

          partnerId:
            null

        }
      );


      this.send(
        partner,
        {

          type:
            "partner_left",

          message:
            "Your partner disconnected."

        }
      );
    }
  }


  /* =======================================================
     ERROR
  ======================================================= */

  async webSocketError(
    ws,
    error
  ) {

    console.error(
      "WebSocket error:",
      error
    );


    await this.webSocketClose(
      ws
    );
  }
}




/* =========================================================
   ADMIN AUTHENTICATION + DASHBOARD
========================================================= */

const ADMIN_COOKIE = "randomtalk_admin";
const ADMIN_SESSION_MAX_AGE = 60 * 60 * 8;

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function hmacSha256(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  ));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function verifyAdminPassword(password, expected) {
  const stored = String(expected ?? "").trim();
  const supplied = String(password ?? "").trim();

  if (!stored || !supplied) return false;

  const suppliedHash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(supplied)
    )
  );

  const storedHash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(stored)
    )
  );

  return constantTimeEqual(suppliedHash, storedHash);
}
async function createAdminSession(secret) {
  const expires = Math.floor(Date.now() / 1000) + ADMIN_SESSION_MAX_AGE;
  const payload = String(expires);
  const signature = base64UrlEncode(await hmacSha256(secret, payload));
  return `${payload}.${signature}`;
}

async function verifyAdminSession(request, secret) {
  if (!secret) return false;

  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)randomtalk_admin=([^;]+)/);
  if (!match) return false;

  const parts = match[1].split(".");
  if (parts.length !== 2) return false;

  const expires = Number(parts[0]);
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;

  try {
    const expected = await hmacSha256(secret, parts[0]);
    const actual = base64UrlDecode(parts[1]);
    return constantTimeEqual(expected, actual);
  } catch {
    return false;
  }
}

function makeAdminCookie(value, maxAge) {
  return `${ADMIN_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function callAdminDO(env, path, method = "GET", body = null) {
  const id = env.CHAT.idFromName("global-video-room");
  const room = env.CHAT.get(id);
  const headers = new Headers({
    "x-randomtalk-admin-action": "1"
  });

  if (body !== null) headers.set("content-type", "application/json");

  return room.fetch(new Request(`https://internal.randomtalk${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body)
  }));
}

function adminLoginPage(message = "") {
  const safe = String(message).replace(/[&<>"']/g, c => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#039;"
  }[c]));

  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>RandomTalk Admin</title><style>body{margin:0;min-height:100vh;background:#070b16;color:#fff;font-family:system-ui;display:grid;place-items:center}.box{width:min(420px,calc(100% - 32px));background:#101827;border:1px solid #26304a;border-radius:18px;padding:24px;box-sizing:border-box}h1{margin-top:0}input,button{width:100%;box-sizing:border-box;padding:13px;border-radius:10px;font:inherit}input{background:#0b1220;border:1px solid #303b59;color:#fff;margin:12px 0}button{border:0;background:#7c3aed;color:#fff;font-weight:800}.error{color:#fb7185;margin-bottom:10px}</style></head><body><div class="box"><h1>🔐 RandomTalk Admin</h1><p>Administrator access only.</p>${safe ? '<div class="error">' + safe + '</div>' : ""}<form method="post" action="/admin/login"><input type="password" name="password" autocomplete="current-password" placeholder="Admin password" required><button>Sign in</button></form></div></body></html>`;
}

const ADMIN_PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>RandomTalk Admin</title><style>
*{box-sizing:border-box}
body{margin:0;background:#070b16;color:#fff;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
header{padding:18px 20px;border-bottom:1px solid #26304a;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
header strong{font-size:20px}
main{max-width:1200px;margin:auto;padding:20px}
.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.actions button{width:auto}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
.stat{background:#101827;border:1px solid #26304a;border-radius:14px;padding:18px}
.label{color:#94a3b8;font-size:13px}
.number{display:block;margin-top:7px;font-size:30px;font-weight:900}
.card{background:#101827;border:1px solid #26304a;border-radius:16px;padding:16px;margin-bottom:20px}
.card h2{margin-top:0}
.table-wrap{width:100%;overflow-x:auto}
table{width:100%;border-collapse:collapse;min-width:800px}
th,td{text-align:left;padding:12px;border-bottom:1px solid #202b42;font-size:13px}
th{color:#94a3b8}
.badge{display:inline-block;padding:5px 8px;border-radius:8px;background:#182238;font-size:12px}
.reports{display:grid;gap:14px}
.report{background:#0b1220;border:1px solid #26304a;border-radius:14px;padding:16px}
.meta{color:#94a3b8;font-size:13px;line-height:1.7;margin-top:8px}
.details{margin:12px 0;white-space:pre-wrap;word-break:break-word}
.report-actions{display:flex;gap:8px;flex-wrap:wrap}
.report-actions button,.report-actions select,.actions button{border:1px solid #303b59;background:#182238;color:#fff;border-radius:9px;padding:9px 12px;font-weight:700;cursor:pointer}
.refresh{background:#7c3aed!important;border-color:#7c3aed!important}
.danger{background:#35131b!important;color:#fb7185!important}
.empty{color:#94a3b8;padding:25px 0}
.hint{color:#94a3b8;font-size:13px;margin:0 0 14px}
.updated{color:#64748b;font-size:12px}
@media(max-width:800px){.stats{grid-template-columns:1fr 1fr}main{padding:12px}}
</style></head><body>
<header>
  <strong>💬 RandomTalk Admin</strong>
  <div class="actions">
    <span class="updated" id="updated">—</span>
    <button class="refresh" type="button" onclick="loadAll()">↻ Refresh</button>
    <form method="post" action="/admin/logout"><button type="submit">Log out</button></form>
  </div>
</header>
<main>
  <p class="hint">Online = open WebSocket connections to the video room. Camera preview alone does not count — user must press <b>Start</b> and stay connected.</p>
  <div class="stats">
    <div class="stat"><span class="label">Online</span><span id="online" class="number">…</span></div>
    <div class="stat"><span class="label">Waiting</span><span id="waiting" class="number">…</span></div>
    <div class="stat"><span class="label">Active Chats</span><span id="matched" class="number">…</span></div>
    <div class="stat"><span class="label">Reports</span><span id="reportTotal" class="number">…</span></div>
  </div>
  <div class="card">
    <h2>👥 Live Users</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>User ID</th><th>Status</th><th>Mode</th><th>Gender</th><th>Country</th><th>Partner</th></tr></thead>
        <tbody id="users"><tr><td colspan="6" class="empty">Loading…</td></tr></tbody>
      </table>
    </div>
  </div>
  <div class="card">
    <h2>⚠ Reports</h2>
    <div id="reports" class="reports"><div class="empty">Loading reports…</div></div>
  </div>
</main>
<script>
"use strict";
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));

async function api(path, method = "GET", body = null) {
  const o = {
    method,
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Accept": "application/json" }
  };
  if (body !== null) {
    o.headers["content-type"] = "application/json";
    o.body = JSON.stringify(body);
  }
  const r = await fetch(path, o);
  if (r.status === 401) {
    location.reload();
    return null;
  }
  if (!r.ok) {
    let detail = "";
    try {
      const j = await r.json();
      detail = j.error || "";
    } catch (e1) {
      try { detail = await r.text(); } catch (e2) {}
    }
    throw new Error("Request failed (" + r.status + ")" + (detail ? ": " + detail : ""));
  }
  return r.json();
}

async function loadStats() {
  const d = await api("/admin/api/stats");
  if (!d) return;
  document.getElementById("online").textContent = d.online ?? 0;
  document.getElementById("waiting").textContent = d.waiting ?? 0;
  document.getElementById("matched").textContent = d.matched ?? 0;
  const root = document.getElementById("users");
  if (d.users && d.users.length) {
    root.innerHTML = d.users.map(u =>
      "<tr><td><code>" + esc(u.id) + "</code></td>" +
      "<td><span class=\\"badge\\">" + esc(u.status) + "</span></td>" +
      "<td>" + esc(u.mode) + "</td>" +
      "<td>" + esc(u.gender) + "</td>" +
      "<td>" + esc(u.country) + "</td>" +
      "<td><code>" + esc(u.partnerId || "-") + "</code></td></tr>"
    ).join("");
  } else {
    root.innerHTML = "<tr><td colspan=\\"6\\" class=\\"empty\\">No users online. Open the main site on a phone/PC, press <b>Start</b>, and keep the tab open.</td></tr>";
  }
  if (d.serverTime) {
    document.getElementById("updated").textContent = "Updated " + new Date(d.serverTime).toLocaleTimeString();
  } else {
    document.getElementById("updated").textContent = "Updated " + new Date().toLocaleTimeString();
  }
}

async function loadReports() {
  const d = await api("/admin/api/reports");
  if (!d) return;
  document.getElementById("reportTotal").textContent = Array.isArray(d) ? d.length : 0;
  const root = document.getElementById("reports");
  if (Array.isArray(d) && d.length) {
    root.innerHTML = d.map(r => {
      const st = r.status || "pending";
      return "<article class=\\"report\\"><div><b>" + esc(r.reason) + "</b> — <span class=\\"badge\\">" + esc(st) + "</span></div>" +
        "<div class=\\"meta\\">Created: " + esc(r.createdAt) + "<br>Reporter: <code>" + esc(r.reporterId) + "</code><br>Reported user: <code>" + esc(r.reportedUserId) + "</code><br>Country: " + esc(r.country) + "</div>" +
        "<div class=\\"details\\">" + esc(r.details || "No details") + "</div>" +
        "<div class=\\"report-actions\\"><select onchange=\\"setStatus('" + esc(r.id) + "',this.value)\\">" +
        "<option value=\\"pending\\" " + (st === "pending" ? "selected" : "") + ">Pending</option>" +
        "<option value=\\"reviewed\\" " + (st === "reviewed" ? "selected" : "") + ">Reviewed</option>" +
        "<option value=\\"resolved\\" " + (st === "resolved" ? "selected" : "") + ">Resolved</option>" +
        "</select><button class=\\"danger\\" type=\\"button\\" onclick=\\"removeReport('" + esc(r.id) + "')\\">Delete</button></div></article>";
    }).join("");
  } else {
    root.innerHTML = "<div class=\\"empty\\">No reports yet.</div>";
  }
}

async function loadAll() {
  try {
    document.getElementById("users").innerHTML = '<tr><td colspan="6" class="empty">Loading…</td></tr>';
    await Promise.all([loadStats(), loadReports()]);
  } catch (e) {
    console.error(e);
    const msg = esc(e.message || String(e));
    document.getElementById("online").textContent = "?";
    document.getElementById("waiting").textContent = "?";
    document.getElementById("matched").textContent = "?";
    document.getElementById("reportTotal").textContent = "?";
    document.getElementById("users").innerHTML = '<tr><td colspan="6" class="empty" style="color:#fb7185">Error: ' + msg + '</td></tr>';
    document.getElementById("reports").innerHTML = '<div class="empty" style="color:#fb7185">Error: ' + msg + "</div>";
    document.getElementById("updated").textContent = "Failed";
  }
}

async function setStatus(id, status) {
  await api("/admin/api/report/status", "POST", { id, status });
  await loadReports();
}

async function removeReport(id) {
  if (!confirm("Delete this report permanently?")) return;
  await api("/admin/api/report/delete", "POST", { id });
  await loadReports();
}

loadAll();
setInterval(loadAll, 5000);
</script>
</body></html>`;


/* =========================================================
   MAIN WORKER
========================================================= */

export default {

  async fetch(
    request,
    env
  ) {

    const url =
      new URL(
        request.url
      );

    /* Supports both a classic plaintext/Secret binding (a string)
       AND a Secrets Store binding (an object with an async .get()
       method). Whichever type ADMIN_PASSWORD turns out to be, this
       resolves it to a plain string. */
    let adminPassword = env.ADMIN_PASSWORD;
    if (adminPassword && typeof adminPassword.get === "function") {
      try {
        adminPassword = await adminPassword.get();
      } catch (error) {
        console.error("Secrets Store read error:", error);
        adminPassword = undefined;
      }
    }
    const adminSessionSecret = env.ADMIN_SESSION_SECRET || adminPassword;

    /* =========================
       ADMIN LOGIN / DASHBOARD
    ========================= */

    if (url.pathname === "/admin/login" && request.method === "POST") {
      if (!sameOrigin(request)) {
        return new Response("Forbidden", { status: 403 });
      }

      const form = await request.formData();
      const password = String(form.get("password") ?? "");

      if (!String(adminPassword ?? "").trim()) {
        return new Response(adminLoginPage("ADMIN_PASSWORD is not configured on this deployed Worker."), {
          status: 500,
          headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "no-store" }
        });
      }

      if (!(await verifyAdminPassword(password, adminPassword))) {
        return new Response(adminLoginPage("Incorrect password."), {
          status: 401,
          headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "no-store" }
        });
      }

      const token = await createAdminSession(adminSessionSecret);
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/admin",
          "Set-Cookie": makeAdminCookie(token, ADMIN_SESSION_MAX_AGE)
        }
      });
    }

    if (url.pathname === "/admin/logout" && request.method === "POST") {
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/admin",
          "Set-Cookie": makeAdminCookie("", 0)
        }
      });
    }

    if (url.pathname === "/admin") {
      if (!(await verifyAdminSession(request, adminSessionSecret))) {
        return new Response(adminLoginPage(), {
          headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "no-store" }
        });
      }

      return new Response(ADMIN_PAGE, {
        headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "no-store" }
      });
    }

    if (url.pathname.startsWith("/admin/api/")) {
      if (!(await verifyAdminSession(request, adminSessionSecret))) {
        return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
      }

      if (!sameOrigin(request)) {
        return Response.json({ ok: false, error: "Forbidden." }, { status: 403 });
      }

      let body = null;
      if (request.method === "POST") {
        try { body = await request.json(); } catch { return Response.json({ ok: false, error: "Invalid JSON." }, { status: 400 }); }
      }

      const path = url.pathname.replace("/admin/api", "/_admin");
      const response = await callAdminDO(env, path, request.method, body);
      const headers = new Headers(response.headers);
      headers.set("content-type", "application/json");
      headers.set("cache-control", "no-store");
      return new Response(response.body, { status: response.status, headers });
    }


    /* =========================
       WEBSOCKET
    ========================= */

    if (
      url.pathname ===
      "/ws"
    ) {

      if (
        request.headers.get(
          "Upgrade"
        )?.toLowerCase() !==
        "websocket"
      ) {

        return new Response(
          "WebSocket upgrade required.",
          {
            status: 426
          }
        );
      }


      /*
        IMPORTANT:
        This uses the existing
        CHAT Durable Object
        binding.
      */

      const id =
        env.CHAT.idFromName(
          "global-video-room"
        );


      const room =
        env.CHAT.get(id);


      return room.fetch(
        request
      );
    }


    /* =========================
       HEALTH
    ========================= */

    if (
      url.pathname ===
      "/health"
    ) {

      return new Response(
        JSON.stringify({

          ok: true,

          service:
            "RandomTalk Video",

          time:
            new Date()
              .toISOString()

        }),
        {

          headers: {

            "content-type":
              "application/json"

          }

        }
      );
    }


    /* =========================
       WEBSITE
    ========================= */

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
  content="width=device-width,initial-scale=1.0"
>

<meta
  name="theme-color"
  content="#060817"
>

<title>RandomTalk Video</title>

<style>

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {

  margin: 0;

  min-height: 100vh;

  background:

    radial-gradient(
      circle at 80% 10%,
      rgba(124,58,237,.25),
      transparent 32%
    ),

    radial-gradient(
      circle at 10% 90%,
      rgba(217,70,239,.15),
      transparent 30%
    ),

    #050816;

  color: white;

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
}

.container {

  width:
    min(
      1050px,
      calc(100% - 30px)
    );

  margin: auto;

}

.navbar {

  height: 72px;

  display: flex;

  align-items: center;

  border-bottom:
    1px solid
    rgba(148,163,184,.14);

}

.nav-inner {

  width:
    min(
      1050px,
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

.nav-right {

  color: #94a3b8;

  font-size: 14px;

}

.hero {

  padding:
    55px 0 25px;

}

.hero h1 {

  margin: 0;

  font-size:
    clamp(
      45px,
      8vw,
      76px
    );

  line-height: .95;

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

  color: #aab5ca;

  font-size: 18px;

  line-height: 1.6;

  max-width: 620px;

}

.card {

  margin-bottom: 20px;

  padding: 18px;

  border:
    1px solid #26304a;

  border-radius: 22px;

  background:
    rgba(8,15,32,.94);

}

.preferences {

  display: grid;

  grid-template-columns:
    1fr 1fr 1fr;

  gap: 12px;

}

.field label {

  display: block;

  margin-bottom: 7px;

  color: #94a3b8;

  font-size: 13px;

}

select {

  width: 100%;

  padding: 12px;

  border:
    1px solid #303b59;

  border-radius: 11px;

  color: white;

  background: #111a2d;

  outline: none;

}

.buttons {

  display: flex;

  flex-wrap: wrap;

  gap: 10px;

  margin-top: 15px;

}

.btn {

  padding:
    13px 18px;

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

.btn.secondary {

  background: #111a2d;

  border:
    1px solid #303b59;

}

.btn.danger {

  background: #29111a;

  color: #fb7185;

  border:
    1px solid #5b2533;

}

.btn:disabled {

  opacity: .45;

  cursor: not-allowed;

}

.status {

  margin-top: 15px;

  color: #fbbf24;

  font-weight: 700;

}

.status.connected {

  color: #4ade80;

}

.video-container {

  position: relative;

  width: 100%;

  aspect-ratio: 16 / 9;

  min-height: 430px;

  overflow: hidden;

  border-radius: 20px;

  background: #020617;

  border:
    1px solid #303b59;

}

#remoteVideo {

  width: 100%;

  height: 100%;

  object-fit: cover;

  background: #020617;

}

.local-video {

  position: absolute;

  right: 15px;

  bottom: 15px;

  width: 190px;

  height: 140px;

  object-fit: cover;

  border-radius: 14px;

  background: #020617;

  border:
    2px solid #8b5cf6;

  z-index: 4;

}

.video-placeholder {

  position: absolute;

  inset: 0;

  display: flex;

  flex-direction: column;

  align-items: center;

  justify-content: center;

  color: #94a3b8;

  text-align: center;

  z-index: 1;

}

.video-placeholder-icon {

  font-size: 60px;

  margin-bottom: 12px;

}

.video-placeholder.hidden {

  display: none;

}

.top-label {

  position: absolute;

  top: 15px;

  left: 15px;

  z-index: 6;

  padding:
    7px 11px;

  border-radius: 9px;

  background:
    rgba(0,0,0,.55);

  font-size: 13px;

}

.video-actions {

  display: grid;

  grid-template-columns:
    repeat(3,1fr);

  gap: 10px;

  margin-top: 12px;

}

.video-button {

  padding: 12px;

  border:
    1px solid #303b59;

  border-radius: 11px;

  color: white;

  background: #111a2d;

}

.video-button.off {

  color: #fb7185;

  border-color: #6b2737;

}



/* =====================================================
   SNAP-STYLE FILTER CAMERA
===================================================== */

.filter-page {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 200;
  background: #000;
  flex-direction: column;
}

.filter-page.show {
  display: flex;
}

.filter-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  background: #000;
  overflow: hidden;
}

#filterVideo {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scaleX(-1);
  opacity: 0;
  pointer-events: none;
}

#filterCanvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scaleX(-1);
}

.filter-top-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  padding-top: max(14px, env(safe-area-inset-top));
  background: linear-gradient(to bottom, rgba(0,0,0,.65), transparent);
}

.filter-top-bar button {
  border: 0;
  border-radius: 999px;
  padding: 10px 16px;
  font-weight: 800;
  font-size: 14px;
  cursor: pointer;
  color: #fff;
  background: rgba(255,255,255,.18);
  backdrop-filter: blur(8px);
}

.filter-top-bar .find-btn {
  background: linear-gradient(90deg, #d946ef, #7c3aed);
}

.filter-bottom {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 5;
  padding: 12px 0 max(20px, env(safe-area-inset-bottom));
  background: linear-gradient(to top, rgba(0,0,0,.75), transparent);
}

.filter-hint {
  text-align: center;
  color: rgba(255,255,255,.85);
  font-size: 13px;
  margin-bottom: 10px;
  font-weight: 600;
}

.filter-strip {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding: 4px 16px 8px;
  scroll-snap-type: x mandatory;
  -webkit-overflow-scrolling: touch;
}

.filter-strip::-webkit-scrollbar { display: none; }

.filter-item {
  flex: 0 0 auto;
  width: 72px;
  scroll-snap-align: center;
  border: 0;
  background: transparent;
  color: #fff;
  cursor: pointer;
  padding: 0;
  text-align: center;
}

.filter-item .preview {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: 3px solid rgba(255,255,255,.35);
  display: grid;
  place-items: center;
  font-size: 28px;
  margin: 0 auto 6px;
  background: rgba(255,255,255,.12);
  transition: border-color .15s, transform .15s;
}

.filter-item.active .preview {
  border-color: #d946ef;
  transform: scale(1.08);
  box-shadow: 0 0 0 2px rgba(217,70,239,.35);
}

.filter-item span.name {
  display: block;
  font-size: 11px;
  font-weight: 700;
  opacity: .9;
}

body.filter-open {
  overflow: hidden;
}

/* =====================================================
   MESSAGE OVERLAY
===================================================== */

.message-overlay {

  position: absolute;

  left: 15px;

  right: 15px;

  bottom: 15px;

  z-index: 8;

  pointer-events: none;

}

.message-list {

  max-height: 160px;

  overflow-y: auto;

  display: flex;

  flex-direction: column;

  gap: 6px;

  margin-bottom: 8px;

}

.overlay-message {

  width: fit-content;

  max-width: 80%;

  padding:
    7px 11px;

  border-radius: 12px;

  background:
    rgba(0,0,0,.68);

  backdrop-filter:
    blur(5px);

  font-size: 14px;

  line-height: 1.3;

}

.overlay-message.mine {

  align-self: flex-end;

  background:
    rgba(99,55,180,.88);

}

.message-compose {

  display: flex;

  gap: 7px;

  pointer-events: auto;

}

.message-compose input {

  flex: 1;

  min-width: 0;

  padding:
    11px 14px;

  border:
    1px solid
    rgba(255,255,255,.25);

  border-radius: 22px;

  outline: none;

  color: white;

  background:
    rgba(0,0,0,.72);

  backdrop-filter:
    blur(8px);

}

.message-compose button {

  width: 46px;

  height: 46px;

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


/* =====================================================
   MODAL
===================================================== */

.modal {

  position: fixed;

  inset: 0;

  z-index: 100;

  display: none;

  align-items: center;

  justify-content: center;

  padding: 20px;

  background:
    rgba(0,0,0,.78);

}

.modal.show {

  display: flex;

}

.modal-box {

  width:
    min(
      420px,
      100%
    );

  padding: 22px;

  border:
    1px solid #303b59;

  border-radius: 18px;

  background: #0b1222;

}

.modal-box h2 {

  margin-top: 0;

}

.modal-box textarea {

  width: 100%;

  padding: 12px;

  margin-top: 10px;

  resize: vertical;

  border:
    1px solid #303b59;

  border-radius: 10px;

  color: white;

  background: #111a2d;

  outline: none;

}

.modal-buttons {

  display: flex;

  gap: 10px;

  margin-top: 12px;

}

.modal-buttons button {

  flex: 1;

  padding: 12px;

  border: 0;

  border-radius: 10px;

  color: white;

}

.cancel {

  background: #182238;

}

.submit {

  background: #dc2626;

}


/* =====================================================
   MOBILE
===================================================== */

@media(max-width:700px) {

  .preferences {

    grid-template-columns: 1fr;

  }

  .hero {

    padding-top: 35px;

  }

  .hero h1 {

    letter-spacing: -2px;

  }

  .video-container {

    min-height: 430px;

    aspect-ratio: 9 / 16;

  }

  .local-video {

    width: 110px;

    height: 145px;

    right: 10px;

    top: 10px;

    bottom: auto;

  }

  .video-actions {

    grid-template-columns:
      1fr 1fr;

  }

  .video-actions
  button:last-child {

    grid-column:
      1 / -1;

  }

  .message-overlay {

    bottom: 10px;

    left: 10px;

    right: 10px;

  }

  .message-list {

    max-height: 130px;

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

<div class="nav-right">

Video Chat

</div>

</div>

</header>


<main class="container">


<section class="hero">

<h1>

Talk to<br>

someone

<span class="gradient">
new.
</span>

</h1>

<p>

Meet a random person through live video chat.
If your microphone is off, you can still type
messages directly on the video screen.

</p>

</section>


<!-- =====================================================
     PREFERENCES
===================================================== -->

<section class="card">

<div class="preferences">


<div class="field">

<label>
My gender
</label>

<select id="myGender">

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


<div class="field">

<label>
Chat with
</label>

<select id="preferredGender">

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


<div class="field">

<label>
Country
</label>

<select id="country">

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

<option value="germany">
Germany 🇩🇪
</option>

<option value="france">
France 🇫🇷
</option>

<option value="any">
Other / Any
</option>

</select>

</div>


</div>


<div class="buttons">

<button
id="startBtn"
class="btn"
>
🚀 Start Video Chat
</button>


<button
id="nextBtn"
class="btn secondary"
disabled
>
⏭ Next
</button>


<button
id="endBtn"
class="btn danger"
disabled
>
⏹ End
</button>


<button
id="reportBtn"
class="btn secondary"
disabled
>
⚠ Report
</button>

</div>


<div
id="status"
class="status"
>
● Ready — press Start Video Chat
</div>


</section>


<!-- =====================================================
     VIDEO
===================================================== -->

<section
id="videoCard"
class="card"
style="display:none"
>


<div class="video-container">


<div
id="topLabel"
class="top-label"
>
🎥 RandomTalk
</div>


<video
id="remoteVideo"
autoplay
playsinline
></video>


<video
id="localVideo"
class="local-video"
autoplay
muted
playsinline
></video>


<div
id="videoPlaceholder"
class="video-placeholder"
>

<div
class="video-placeholder-icon"
>
🎥
</div>

<div
id="placeholderText"
>
Waiting for another person...
</div>

</div>


<!-- =====================================================
     IN VIDEO MESSAGES
===================================================== -->

<div class="message-overlay">


<div
id="messageList"
class="message-list"
>
</div>


<div class="message-compose">

<input
id="messageInput"
maxlength="500"
placeholder="Type a message..."
>


<button
id="sendMessage"
>
➤
</button>

</div>


</div>


</div>


<div class="video-actions">


<button
id="cameraBtn"
class="video-button"
>
📷 Camera On
</button>


<button
id="micBtn"
class="video-button"
>
🎤 Microphone On
</button>


<button
id="reconnectBtn"
class="video-button"
>
🔄 Reconnect Video
</button>


</div>


</section>


<section class="card">

<div style="
color:#94a3b8;
line-height:1.7;
font-size:13px;
">

<b style="color:white">
Safety
</b>

<br>

• Be respectful.

<br>

• Do not share passwords or financial information.

<br>

• Do not share your exact home address.

<br>

• Use Report if someone behaves inappropriately.

</div>

</section>


</main>



<!-- =====================================================
     SNAP-STYLE FILTER CAMERA PAGE
===================================================== -->

<div id="filterPage" class="filter-page" aria-hidden="true">
  <div class="filter-stage">
    <video id="filterVideo" playsinline muted autoplay></video>
    <canvas id="filterCanvas"></canvas>

    <div class="filter-top-bar">
      <button type="button" id="closeFilterBtn" aria-label="Close">✕ Close</button>
      <button type="button" id="findStrangerBtn" class="find-btn">🚀 Find Stranger</button>
    </div>

    <div class="filter-bottom">
      <div class="filter-hint">Pick a fun filter, then find someone to chat</div>
      <div class="filter-strip" id="filterStrip"></div>
    </div>
  </div>
</div>

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
id="cancelReport"
class="cancel"
>
Cancel
</button>


<button
id="submitReport"
class="submit"
>
Submit
</button>

</div>

</div>

</div>


<script>

"use strict";


/* =========================================================
   STATE
========================================================= */

let socket = null;

let currentMode = "video";

let connected = false;

let isInitiator = false;

let localStream = null;

let peerConnection = null;

let pendingIce = [];

let cameraEnabled = true;

let microphoneEnabled = true;

let manualClose = false;


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
    },

    {
      urls:
        "stun:stun2.l.google.com:19302"
    }

  ],

  iceCandidatePoolSize: 10

};


/* =========================================================
   ELEMENTS
========================================================= */

const startBtn =
  document.getElementById(
    "startBtn"
  );

const nextBtn =
  document.getElementById(
    "nextBtn"
  );

const endBtn =
  document.getElementById(
    "endBtn"
  );

const reportBtn =
  document.getElementById(
    "reportBtn"
  );

const videoCard =
  document.getElementById(
    "videoCard"
  );

const remoteVideo =
  document.getElementById(
    "remoteVideo"
  );

const localVideo =
  document.getElementById(
    "localVideo"
  );

const videoPlaceholder =
  document.getElementById(
    "videoPlaceholder"
  );

const placeholderText =
  document.getElementById(
    "placeholderText"
  );

const statusEl =
  document.getElementById(
    "status"
  );

const messageInput =
  document.getElementById(
    "messageInput"
  );

const messageList =
  document.getElementById(
    "messageList"
  );


/* =========================================================
   STATUS
========================================================= */

function setStatus(
  text,
  good = false
) {

  statusEl.textContent =
    "● " + text;

  if (good) {

    statusEl.classList.add(
      "connected"
    );

  } else {

    statusEl.classList.remove(
      "connected"
    );
  }
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
    location.protocol ===
    "https:"
      ? "wss:"
      : "ws:";


  socket =
    new WebSocket(

      protocol +
      "//" +
      location.host +
      "/ws"

    );


  socket.onopen =
    () => {

      setStatus(
        "Connected. Looking for a stranger..."
      );

      joinRoom();

    };


  socket.onmessage =
    async event => {

      let data;


      try {

        data =
          JSON.parse(
            event.data
          );

      } catch {

        return;
      }


      await handleMessage(
        data
      );
    };


  socket.onerror =
    () => {

      setStatus(
        "Connection error."
      );
    };


  socket.onclose =
    () => {

      connected = false;

      closePeerConnection();

      if (!manualClose) {

        setStatus(
          "Disconnected. Press Start to reconnect."
        );

      }

      updateButtons();

    };
}


/* =========================================================
   JOIN
========================================================= */

function joinRoom() {

  if (
    !socket ||
    socket.readyState !==
    WebSocket.OPEN
  ) {

    return;
  }


  const gender =
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


  socket.send(

    JSON.stringify({

      type:
        "join",

      mode:
        "video",

      gender,

      preferredGender,

      country

    })

  );
}


/* =========================================================
   SERVER MESSAGE
========================================================= */

async function handleMessage(
  data
) {


  /* =========================
     WAITING
  ========================= */

  if (
    data.type ===
    "waiting"
  ) {

    connected = false;

    setStatus(
      "Looking for another person..."
    );

    placeholderText.textContent =
      "Waiting for another person...";

    updateButtons();

    return;
  }


  /* =========================
     MATCHED
  ========================= */

  if (
    data.type ===
    "matched"
  ) {

    connected = true;

    isInitiator =
      data.role ===
      "caller";


    clearMessages();


    videoCard.style.display =
      "block";


    placeholderText.textContent =
      "Connecting video...";


    videoPlaceholder.classList
      .remove("hidden");


    setStatus(
      "Stranger found — starting video...",
      true
    );


    updateButtons();


    try {

      await startVideo();


    } catch (error) {

      console.error(
        "Video start error:",
        error
      );


      setStatus(
        "Camera or microphone permission failed."
      );

      placeholderText.textContent =
        "Camera/microphone permission is required.";
    }


    return;
  }


  /* =========================
     CHAT MESSAGE
  ========================= */

  if (
    data.type ===
    "chat"
  ) {

    addMessage(
      data.text,
      false
    );

    return;
  }


  /* =========================
     SIGNAL
  ========================= */

  if (
    data.type ===
    "signal"
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


  /* =========================
     PARTNER LEFT
  ========================= */

  if (
    data.type ===
    "partner_left"
  ) {

    connected = false;

    closePeerConnection();

    clearMessages();

    placeholderText.textContent =
      "Your partner left. Press Next.";


    videoPlaceholder.classList
      .remove("hidden");


    setStatus(
      "Stranger left."
    );


    updateButtons();

    return;
  }


  /* =========================
     REPORT
  ========================= */

  if (
    data.type ===
    "report_success"
  ) {

    closeReport();

    alert(
      "Report submitted successfully."
    );

    return;
  }


  /* =========================
     ERROR
  ========================= */

  if (
    data.type ===
    "error"
  ) {

    setStatus(
      data.message ||
      "Something went wrong."
    );
  }
}


/* =========================================================
   START
========================================================= */

function startChat() {
  /* Open Snap-style filter camera first; matching starts from Find Stranger */
  openFilterCamera();
}

async function beginMatching() {
  manualClose = false;

  try {
    await ensureFilteredStream();
  } catch (e) {
    setStatus("Camera error: " + (e.message || e));
    return;
  }

  /* Prefer filtered stream for WebRTC */
  if (filteredStream) {
    localStream = filteredStream;
    if (localVideo) {
      localVideo.srcObject = filteredStream;
    }
  }

  if (
    !socket ||
    socket.readyState !==
    WebSocket.OPEN
  ) {
    connectSocket();
    return;
  }

  joinRoom();
}


/* =========================================================
   NEXT
========================================================= */

function nextChat() {

  if (
    !socket ||
    socket.readyState !==
    WebSocket.OPEN
  ) {

    return;
  }


  connected = false;


  closePeerConnection();

  clearMessages();


  placeholderText.textContent =
    "Looking for another person...";


  videoPlaceholder.classList
    .remove("hidden");


  setStatus(
    "Looking for another person..."
  );


  socket.send(

    JSON.stringify({

      type:
        "next"

    })

  );


  updateButtons();
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

        type:
          "end"

      })

    );
  }


  connected = false;


  closePeerConnection();

  clearMessages();


  videoPlaceholder.classList
    .remove("hidden");


  placeholderText.textContent =
    "Chat ended.";


  setStatus(
    "Chat ended."
  );


  updateButtons();
}


/* =========================================================
   BUTTON STATE
========================================================= */

function updateButtons() {

  startBtn.disabled =
    connected;


  nextBtn.disabled =
    !connected;


  endBtn.disabled =
    !connected;


  reportBtn.disabled =
    !connected;
}


/* =========================================================
   CAMERA + MICROPHONE
========================================================= */

async function getLocalMedia() {

  if (rawVideoStream && rawVideoStream.getTracks().some(t => t.readyState === "live")) {
    if (!localStream) localStream = rawVideoStream;
    return localStream;
  }

  if (localStream && localStream.getTracks().some(t => t.readyState === "live")) {
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

          facingMode:
            "user",

          width: {
            ideal: 1280
          },

          height: {
            ideal: 720
          },

          frameRate: {
            ideal: 30
          }

        },

        audio: {

          echoCancellation:
            true,

          noiseSuppression:
            true,

          autoGainControl:
            true

        }

      });

  rawVideoStream = localStream;


  localVideo.srcObject =
    localStream;


  localVideo.muted =
    true;


  await localVideo
    .play()
    .catch(
      () => {}
    );

  const fv = document.getElementById("filterVideo");
  if (fv) {
    fv.srcObject = localStream;
    fv.muted = true;
    await fv.play().catch(() => {});
  }

  cameraEnabled =
    true;

  microphoneEnabled =
    true;


  updateMediaButtons();


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


  /*
    Add local tracks.
  */

  if (localStream) {

    for (
      const track
      of localStream.getTracks()
    ) {

      peerConnection.addTrack(
        track,
        localStream
      );
    }
  }


  /*
    Remote video.
  */

  peerConnection.ontrack =
    event => {

      const stream =
        event.streams &&
        event.streams[0];


      if (!stream) {
        return;
      }


      remoteVideo.srcObject =
        stream;


      remoteVideo
        .play()
        .catch(
          () => {}
        );


      videoPlaceholder.classList
        .add("hidden");


      setStatus(
        "Video connected.",
        true
      );
    };


  /*
    ICE candidates.
  */

  peerConnection.onicecandidate =
    event => {

      if (
        !event.candidate
      ) {

        return;
      }


      sendSignal({

        type:
          "ice",

        candidate:
          event.candidate

      });
    };


  /*
    Connection state.
  */

  peerConnection
    .onconnectionstatechange =
    () => {

      if (!peerConnection) {
        return;
      }


      const state =
        peerConnection
          .connectionState;


      if (
        state ===
        "connected"
      ) {

        setStatus(
          "Video connected.",
          true
        );

        videoPlaceholder
          .classList
          .add("hidden");
      }


      if (
        state ===
        "connecting"
      ) {

        setStatus(
          "Connecting video..."
        );
      }


      if (
        state ===
        "disconnected"
      ) {

        setStatus(
          "Video connection unstable. Reconnecting..."
        );

        setTimeout(
          restartVideo,
          1000
        );
      }


      if (
        state ===
        "failed"
      ) {

        setStatus(
          "Video connection failed. Reconnecting..."
        );

        setTimeout(
          restartVideo,
          300
        );
      }
    };


  /*
    ICE state.
  */

  peerConnection
    .oniceconnectionstatechange =
    () => {

      if (
        !peerConnection
      ) {

        return;
      }


      const state =
        peerConnection
          .iceConnectionState;


      if (
        state ===
        "failed"
      ) {

        restartVideo();
      }
    };


  return peerConnection;
}


/* =========================================================
   START VIDEO
========================================================= */

async function startVideo() {

  await getLocalMedia();
  try {
    await ensureFilteredStream();
    if (filteredStream) {
      localStream = filteredStream;
      if (localVideo) localVideo.srcObject = filteredStream;
    }
  } catch (e) {
    console.warn("filter stream fallback", e);
  }


  await createPeerConnection();


  if (isInitiator) {

    const offer =
      await peerConnection
        .createOffer();


    await peerConnection
      .setLocalDescription(
        offer
      );


    sendSignal({

      type:
        "offer",

      sdp:
        peerConnection
          .localDescription

    });
  }
}


/* =========================================================
   SIGNAL
========================================================= */

function sendSignal(
  signal
) {

  if (
    !socket ||
    socket.readyState !==
    WebSocket.OPEN ||
    !connected
  ) {

    return;
  }


  socket.send(

    JSON.stringify({

      type:
        "signal",

      signal

    })

  );
}


async function handleSignal(
  signal
) {

  if (!signal) {
    return;
  }


  /*
    Make sure local media
    exists before answering.
  */

  if (
    !peerConnection
  ) {

    await getLocalMedia();

    await createPeerConnection();
  }


  /* =========================
     OFFER
  ========================= */

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


    await flushIce();


    const answer =
      await peerConnection
        .createAnswer();


    await peerConnection
      .setLocalDescription(
        answer
      );


    sendSignal({

      type:
        "answer",

      sdp:
        peerConnection
          .localDescription

    });


    return;
  }


  /* =========================
     ANSWER
  ========================= */

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


    await flushIce();


    return;
  }


  /* =========================
     ICE
  ========================= */

  if (
    signal.type ===
    "ice"
  ) {

    const candidate =
      signal.candidate;


    if (!candidate) {
      return;
    }


    if (
      peerConnection
        .remoteDescription
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
          "ICE error:",
          error
        );
      }


    } else {

      pendingIce.push(
        candidate
      );
    }
  }
}


/* =========================================================
   FLUSH ICE
========================================================= */

async function flushIce() {

  if (
    !peerConnection
  ) {

    return;
  }


  const list =
    pendingIce;


  pendingIce = [];


  for (
    const candidate
    of list
  ) {

    try {

      await peerConnection
        .addIceCandidate(

          new RTCIceCandidate(
            candidate
          )

        );

    } catch {}
  }
}


/* =========================================================
   RESTART VIDEO
========================================================= */

async function restartVideo() {

  if (!connected) {
    return;
  }


  try {

    if (!localStream) {

      await getLocalMedia();
    }


    if (!peerConnection) {

      await createPeerConnection();
    }


    /*
      Only caller creates
      the ICE restart offer.
    */

    if (isInitiator) {

      const offer =
        await peerConnection
          .createOffer({

            iceRestart:
              true

          });


      await peerConnection
        .setLocalDescription(
          offer
        );


      sendSignal({

        type:
          "offer",

        sdp:
          peerConnection
            .localDescription

      });
    }

  } catch (error) {

    console.error(
      "Restart video error:",
      error
    );
  }
}


/* =========================================================
   CLOSE PEER
========================================================= */

function closePeerConnection() {

  pendingIce = [];


  if (
    peerConnection
  ) {

    try {

      peerConnection
        .ontrack = null;

      peerConnection
        .onicecandidate = null;

      peerConnection
        .close();

    } catch {}

    peerConnection =
      null;
  }


  remoteVideo.srcObject =
    null;


  if (
    localStream
  ) {

    try {

      for (
        const track
        of localStream.getTracks()
      ) {

        track.stop();
      }

    } catch {}


    localStream =
      null;
  }


  localVideo.srcObject =
    null;


  cameraEnabled =
    true;

  microphoneEnabled =
    true;


  updateMediaButtons();
}


/* =========================================================
   CAMERA
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


  for (
    const track
    of tracks
  ) {

    track.enabled =
      cameraEnabled;
  }


  updateMediaButtons();
}


/* =========================================================
   MICROPHONE
========================================================= */

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


  for (
    const track
    of tracks
  ) {

    track.enabled =
      microphoneEnabled;
  }


  updateMediaButtons();
}


/* =========================================================
   MEDIA BUTTONS
========================================================= */

function updateMediaButtons() {

  const cameraBtn =
    document.getElementById(
      "cameraBtn"
    );


  const micBtn =
    document.getElementById(
      "micBtn"
    );


  if (
    cameraEnabled
  ) {

    cameraBtn.textContent =
      "📷 Camera On";

    cameraBtn.classList
      .remove("off");

  } else {

    cameraBtn.textContent =
      "📷 Camera Off";

    cameraBtn.classList
      .add("off");
  }


  if (
    microphoneEnabled
  ) {

    micBtn.textContent =
      "🎤 Microphone On";

    micBtn.classList
      .remove("off");

  } else {

    micBtn.textContent =
      "🔇 Microphone Off";

    micBtn.classList
      .add("off");
  }
}


/* =========================================================
   MESSAGE
========================================================= */

function clearMessages() {

  messageList.innerHTML =
    "";
}


function addMessage(
  text,
  mine
) {

  const div =
    document.createElement(
      "div"
    );


  div.className =
    "overlay-message" +
    (
      mine
        ? " mine"
        : ""
    );


  div.textContent =
    text;


  messageList.appendChild(
    div
  );


  messageList.scrollTop =
    messageList.scrollHeight;
}


function sendChatMessage() {

  const text =
    messageInput.value
      .trim();


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

      type:
        "chat",

      text

    })

  );


  addMessage(
    text,
    true
  );


  messageInput.value =
    "";
}


/* =========================================================
   REPORT
========================================================= */

function openReport() {

  if (!connected) {

    alert(
      "You are not connected."
    );

    return;
  }


  document
    .getElementById(
      "reportModal"
    )
    .classList
    .add("show");
}


function closeReport() {

  document
    .getElementById(
      "reportModal"
    )
    .classList
    .remove("show");
}


function submitReport() {

  if (
    !connected ||
    !socket ||
    socket.readyState !==
      WebSocket.OPEN
  ) {

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

      type:
        "report",

      reason,

      details

    })

  );


  closeReport();
}



/* =========================================================
   SNAP-STYLE FILTER CAMERA
========================================================= */

const FILTERS = [
  { id: "normal", name: "Normal", emoji: "😊" },
  { id: "smooth", name: "Smooth", emoji: "✨" },
  { id: "warm", name: "Warm", emoji: "🌅" },
  { id: "cool", name: "Cool", emoji: "❄️" },
  { id: "vivid", name: "Vivid", emoji: "🌈" },
  { id: "glow", name: "Glow", emoji: "🌟" },
  { id: "mono", name: "B&W", emoji: "⬛" },
  { id: "film", name: "Film", emoji: "📷" },
  { id: "pink", name: "Pink", emoji: "💗" },
  { id: "dog", name: "Dog", emoji: "🐶" },
  { id: "cat", name: "Cat", emoji: "🐱" },
  { id: "crown", name: "Crown", emoji: "👑" },
  { id: "hearts", name: "Hearts", emoji: "😍" },
  { id: "shades", name: "Shades", emoji: "🕶️" },
  { id: "party", name: "Party", emoji: "🎉" }
];

let currentFilterId = "normal";
let filterAnimId = null;
let filteredStream = null;
let filterCanvasStream = null;
let rawVideoStream = null;

function buildFilterStrip() {
  const strip = document.getElementById("filterStrip");
  if (!strip || strip.dataset.ready === "1") return;
  strip.innerHTML = FILTERS.map(f =>
    '<button type="button" class="filter-item' + (f.id === currentFilterId ? " active" : "") + '" data-filter="' + f.id + '">' +
    '<div class="preview">' + f.emoji + '</div><span class="name">' + f.name + '</span></button>'
  ).join("");
  strip.dataset.ready = "1";
  strip.onclick = (e) => {
    const btn = e.target.closest(".filter-item");
    if (!btn) return;
    currentFilterId = btn.getAttribute("data-filter") || "normal";
    strip.querySelectorAll(".filter-item").forEach(el => {
      el.classList.toggle("active", el.getAttribute("data-filter") === currentFilterId);
    });
  };
}

function applyPixelFilter(ctx, w, h, id) {
  if (id === "normal" || id === "dog" || id === "cat" || id === "crown" || id === "hearts" || id === "shades" || id === "party") {
    return;
  }
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    if (id === "warm") {
      r = Math.min(255, r * 1.12 + 12);
      b = b * 0.88;
    } else if (id === "cool") {
      b = Math.min(255, b * 1.12 + 10);
      r = r * 0.9;
    } else if (id === "vivid") {
      r = Math.min(255, (r - 128) * 1.35 + 128);
      g = Math.min(255, (g - 128) * 1.35 + 128);
      b = Math.min(255, (b - 128) * 1.35 + 128);
    } else if (id === "mono") {
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      r = g = b = y;
    } else if (id === "film") {
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      r = Math.min(255, y * 1.05 + 30);
      g = Math.min(255, y * 0.95 + 15);
      b = Math.min(255, y * 0.75);
    } else if (id === "pink") {
      r = Math.min(255, r * 1.08 + 20);
      g = g * 0.92;
      b = Math.min(255, b * 1.05 + 15);
    } else if (id === "smooth" || id === "glow") {
      r = Math.min(255, r * 1.06 + 8);
      g = Math.min(255, g * 1.04 + 6);
      b = Math.min(255, b * 1.04 + 6);
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  ctx.putImageData(img, 0, 0);

  if (id === "glow" || id === "smooth") {
    ctx.save();
    ctx.globalAlpha = id === "glow" ? 0.22 : 0.12;
    ctx.filter = "blur(6px)";
    ctx.drawImage(ctx.canvas, 0, 0);
    ctx.restore();
    ctx.filter = "none";
  }
}

function drawStickerOverlay(ctx, w, h, id) {
  const cx = w * 0.5;
  const faceY = h * 0.38;
  const faceW = Math.min(w, h) * 0.42;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (id === "dog") {
    ctx.font = (faceW * 0.5) + "px serif";
    ctx.fillText("👂", cx - faceW * 0.45, faceY - faceW * 0.38);
    ctx.fillText("👂", cx + faceW * 0.45, faceY - faceW * 0.38);
    ctx.font = (faceW * 0.42) + "px serif";
    ctx.fillText("🐶", cx, faceY + faceW * 0.02);
  } else if (id === "cat") {
    ctx.font = (faceW * 0.5) + "px serif";
    ctx.fillText("🐱", cx, faceY - faceW * 0.05);
  } else if (id === "crown") {
    ctx.font = (faceW * 0.55) + "px serif";
    ctx.fillText("👑", cx, faceY - faceW * 0.55);
  } else if (id === "hearts") {
    ctx.font = (faceW * 0.32) + "px serif";
    ctx.fillText("😍", cx, faceY);
    ctx.font = (faceW * 0.22) + "px serif";
    ctx.fillText("💕", cx - faceW * 0.55, faceY - faceW * 0.2);
    ctx.fillText("💕", cx + faceW * 0.55, faceY - faceW * 0.2);
  } else if (id === "shades") {
    ctx.font = (faceW * 0.5) + "px serif";
    ctx.fillText("🕶️", cx, faceY - faceW * 0.05);
  } else if (id === "party") {
    ctx.font = (faceW * 0.28) + "px serif";
    ctx.fillText("🎉", cx - faceW * 0.5, faceY - faceW * 0.5);
    ctx.fillText("🥳", cx, faceY);
    ctx.fillText("🎊", cx + faceW * 0.5, faceY - faceW * 0.5);
  }
  ctx.restore();
}

function filterLoop() {
  const video = document.getElementById("filterVideo");
  const canvas = document.getElementById("filterCanvas");
  if (!video || !canvas) return;

  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (video.readyState >= 2) {
    ctx.drawImage(video, 0, 0, w, h);
    applyPixelFilter(ctx, w, h, currentFilterId);
    drawStickerOverlay(ctx, w, h, currentFilterId);
  }

  filterAnimId = requestAnimationFrame(filterLoop);
}

function stopFilterLoop() {
  if (filterAnimId) {
    cancelAnimationFrame(filterAnimId);
    filterAnimId = null;
  }
}

async function openFilterCamera() {
  buildFilterStrip();
  const page = document.getElementById("filterPage");
  if (!page) {
    beginMatching();
    return;
  }

  try {
    setStatus("Opening camera…");
    rawVideoStream = await getLocalMedia();
    const fv = document.getElementById("filterVideo");
    if (fv) {
      fv.srcObject = rawVideoStream;
      await fv.play().catch(() => {});
    }
    page.classList.add("show");
    page.setAttribute("aria-hidden", "false");
    document.body.classList.add("filter-open");
    stopFilterLoop();
    filterLoop();
    setStatus("Pick a filter, then tap Find Stranger");
  } catch (e) {
    console.error(e);
    setStatus("Camera permission needed to continue");
    alert("Please allow camera & microphone access to use filters and video chat.");
  }
}

function closeFilterCamera(keepStream) {
  const page = document.getElementById("filterPage");
  if (page) {
    page.classList.remove("show");
    page.setAttribute("aria-hidden", "true");
  }
  document.body.classList.remove("filter-open");
  if (!keepStream) {
    stopFilterLoop();
  }
}

async function ensureFilteredStream() {
  const canvas = document.getElementById("filterCanvas");
  const video = document.getElementById("filterVideo");

  if (!rawVideoStream) {
    rawVideoStream = await getLocalMedia();
  }

  if (!canvas || !video) {
    filteredStream = rawVideoStream;
    return filteredStream;
  }

  if (video.readyState < 2) {
    await new Promise(resolve => {
      const t = setTimeout(resolve, 1500);
      video.onloadeddata = () => { clearTimeout(t); resolve(); };
    });
  }

  if (!filterAnimId) filterLoop();

  if (!filterCanvasStream) {
    filterCanvasStream = canvas.captureStream(30);
  }

  const audioTracks = rawVideoStream.getAudioTracks();
  const videoTracks = filterCanvasStream.getVideoTracks();
  filteredStream = new MediaStream([
    ...videoTracks,
    ...audioTracks
  ]);

  return filteredStream;
}


/* =========================================================
   EVENTS
========================================================= */

startBtn.onclick =
  startChat;


const findStrangerBtn = document.getElementById("findStrangerBtn");
if (findStrangerBtn) {
  findStrangerBtn.onclick = async () => {
    findStrangerBtn.disabled = true;
    findStrangerBtn.textContent = "Starting…";
    try {
      await beginMatching();
      closeFilterCamera(true);
      const videoCard = document.getElementById("videoCard");
      if (videoCard) videoCard.style.display = "";
      setStatus("Connecting…");
    } catch (e) {
      console.error(e);
      setStatus("Could not start: " + (e.message || e));
    } finally {
      findStrangerBtn.disabled = false;
      findStrangerBtn.textContent = "🚀 Find Stranger";
    }
  };
}

const closeFilterBtn = document.getElementById("closeFilterBtn");
if (closeFilterBtn) {
  closeFilterBtn.onclick = () => {
    closeFilterCamera(false);
    setStatus("● Ready — press Start Video Chat");
  };
}


nextBtn.onclick =
  nextChat;


endBtn.onclick =
  endChat;


reportBtn.onclick =
  openReport;


document
  .getElementById(
    "cameraBtn"
  )
  .onclick =
  toggleCamera;


document
  .getElementById(
    "micBtn"
  )
  .onclick =
  toggleMicrophone;


document
  .getElementById(
    "reconnectBtn"
  )
  .onclick =
  restartVideo;


document
  .getElementById(
    "sendMessage"
  )
  .onclick =
  sendChatMessage;


messageInput.onkeydown =
  event => {

    if (
      event.key ===
      "Enter"
    ) {

      event.preventDefault();

      sendChatMessage();
    }
  };


document
  .getElementById(
    "cancelReport"
  )
  .onclick =
  closeReport;


document
  .getElementById(
    "submitReport"
  )
  .onclick =
  submitReport;


/* =========================================================
   LOAD SAVED PREFERENCES
========================================================= */

window.addEventListener(
  "load",
  () => {

    const savedGender =
      localStorage.getItem(
        "randomtalk_my_gender"
      );


    const savedPreferred =
      localStorage.getItem(
        "randomtalk_preferred_gender"
      );


    const savedCountry =
      localStorage.getItem(
        "randomtalk_country"
      );


    if (savedGender) {

      document.getElementById(
        "myGender"
      ).value =
        savedGender;
    }


    if (savedPreferred) {

      document.getElementById(
        "preferredGender"
      ).value =
        savedPreferred;
    }


    if (savedCountry) {

      document.getElementById(
        "country"
      ).value =
        savedCountry;
    }


    updateButtons();

    updateMediaButtons();
  }
);


/* =========================================================
   SAVE PREFERENCES
========================================================= */

document
  .getElementById(
    "myGender"
  )
  .onchange =
  savePreferences;


document
  .getElementById(
    "preferredGender"
  )
  .onchange =
  savePreferences;


document
  .getElementById(
    "country"
  )
  .onchange =
  savePreferences;


function savePreferences() {

  localStorage.setItem(

    "randomtalk_my_gender",

    document
      .getElementById(
        "myGender"
      )
      .value

  );


  localStorage.setItem(

    "randomtalk_preferred_gender",

    document
      .getElementById(
        "preferredGender"
      )
      .value

  );


  localStorage.setItem(

    "randomtalk_country",

    document
      .getElementById(
        "country"
      )
      .value

  );
}


/* =========================================================
   PAGE CLOSE
========================================================= */

window.addEventListener(
  "beforeunload",
  () => {

    manualClose =
      true;


    try {

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

    } catch {}


    try {

      closePeerConnection();

    } catch {}
  }
);


/* =========================================================
   INITIAL
========================================================= */

updateButtons();

updateMediaButtons();

</script>

</body>

</html>`;