"use strict";

const { addLog, getLogs } = require("./logger");
const { startTelemetry } = require('./telemetry');
const mineflayer = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const { GoalBlock } = goals;
const config = require("./settings.json");
const express = require("express");
const http = require("http");
const https = require("https");

// ============================================================
// EXPRESS SERVER
// ============================================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 5000;

// ============================================================
// [NEW] CHAT MIRROR — stores last 50 in-game chat messages
// ============================================================
let chatHistory = [];
function addChat(username, message) {
  chatHistory.push({ username, message, time: Date.now() });
  if (chatHistory.length > 50) chatHistory = chatHistory.slice(-50);
}

// ============================================================
// [NEW] RECONNECT HISTORY — stores last 20 disconnect events
// ============================================================
let reconnectHistory = [];
function addReconnectEvent(reason, type) {
  reconnectHistory.push({ reason, type, time: Date.now() });
  if (reconnectHistory.length > 20) reconnectHistory = reconnectHistory.slice(-20);
}

// ============================================================
// [NEW] ANTI-SPAM GUARD — queues chat to prevent spam kicks
// ============================================================
const CHAT_COOLDOWN_MS = 1200; // minimum ms between chat messages
let lastChatTime = 0;
let chatQueue = [];
let chatQueueTimer = null;

function safeBotChat(message) {
  chatQueue.push(message);
  if (!chatQueueTimer) processQueue();
}

function processQueue() {
  if (!chatQueue.length) { chatQueueTimer = null; return; }
  const now = Date.now();
  const wait = Math.max(0, CHAT_COOLDOWN_MS - (now - lastChatTime));
  chatQueueTimer = setTimeout(() => {
    if (bot && botState.connected && chatQueue.length) {
      const msg = chatQueue.shift();
      try { bot.chat(msg); lastChatTime = Date.now(); } catch (_) {}
    }
    processQueue();
  }, wait);
}

// ============================================================
// BOT STATE
// ============================================================
let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
  wasThrottled: false,
  // [NEW]
  ping: null,
  health: null,
  food: null,
  inventory: [],
  players: [],
  lastKickAnalysis: null,
};

let bot = null;
let activeIntervals = [];
let reconnectTimeoutId = null;
let connectionTimeoutId = null;
let isReconnecting = false;
let lastKickReason = null;
let lastDiscordSend = 0;
const DISCORD_RATE_LIMIT_MS = 5000;

// ============================================================
// [NEW] SMART KICK ANALYZER
// ============================================================
function analyzeKickReason(reason) {
  const r = (reason || "").toLowerCase();
  if (r.includes("already connected") || r.includes("proxy"))
    return { label: "Duplicate Session", color: "#f59e0b", icon: "⚠️", tip: "Wait 60–90s before reconnecting. Proxy still has old session." };
  if (r.includes("throttl") || r.includes("too fast") || r.includes("wait before"))
    return { label: "Rate Throttled", color: "#ef4444", icon: "🚫", tip: "Server throttled reconnects. Waiting longer before retry." };
  if (r.includes("banned") || r.includes("ban"))
    return { label: "Banned", color: "#dc2626", icon: "🔨", tip: "Bot may be banned. Check server rules." };
  if (r.includes("whitelist"))
    return { label: "Not Whitelisted", color: "#dc2626", icon: "🔒", tip: "Add bot's username to the server whitelist." };
  if (r.includes("outdated") || r.includes("version"))
    return { label: "Version Mismatch", color: "#8b5cf6", icon: "🔄", tip: "Server version doesn't match. Update settings.json version field." };
  if (r.includes("timeout") || r.includes("timed out"))
    return { label: "Connection Timeout", color: "#6366f1", icon: "⏱️", tip: "Server took too long to respond. May be starting up." };
  if (r.includes("full") || r.includes("maximum"))
    return { label: "Server Full", color: "#f97316", icon: "👥", tip: "Server is at max capacity. Will retry." };
  if (r.includes("maintenance") || r.includes("restart"))
    return { label: "Server Restart", color: "#06b6d4", icon: "🔁", tip: "Server is restarting. Will reconnect shortly." };
  if (r === "" || r.includes("end of stream"))
    return { label: "Server Offline / Starting", color: "#64748b", icon: "💤", tip: "Server is likely sleeping or starting up. Waiting before retry." };
  return { label: "Unknown Kick", color: "#94a3b8", icon: "❓", tip: reason || "No reason provided." };
}

// ============================================================
// DASHBOARD — [NEW REDESIGN]
// ============================================================
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} Dashboard</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>
          *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
          :root {
            --bg: #0a0f1a; --surface: #111827; --border: #1f2937;
            --text: #f1f5f9; --muted: #64748b; --green: #22c55e;
            --red: #ef4444; --blue: #3b82f6; --yellow: #f59e0b;
            --purple: #a855f7;
          }
          body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; padding: 24px 16px; }
          .container { max-width: 960px; margin: 0 auto; }

          /* HEADER */
          .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; flex-wrap: wrap; gap: 12px; }
          .header-left h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
          .header-left p { font-size: 13px; color: var(--muted); margin-top: 3px; }
          .header-right { display: flex; gap: 8px; }
          .nav-btn { padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; text-decoration: none; border: 1px solid var(--border); background: var(--surface); color: var(--muted); transition: all 0.2s; }
          .nav-btn:hover { background: var(--border); color: var(--text); }

          /* STATUS HERO */
          .status-hero { border-radius: 16px; padding: 24px 28px; margin-bottom: 20px; display: flex; align-items: center; gap: 20px; border: 1.5px solid; transition: all 0.4s; position: relative; overflow: hidden; }
          .status-hero.online { background: linear-gradient(135deg, #052e16 0%, #0a1628 100%); border-color: #16a34a; }
          .status-hero.offline { background: linear-gradient(135deg, #1c0a0a 0%, #0a1628 100%); border-color: #dc2626; }
          .status-hero.online::before { content: ''; position: absolute; top: -40px; right: -40px; width: 120px; height: 120px; border-radius: 50%; background: radial-gradient(circle, rgba(34,197,94,0.15) 0%, transparent 70%); }
          .status-pulse { width: 52px; height: 52px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; position: relative; }
          .status-pulse.online { background: rgba(34,197,94,0.15); border: 2px solid #16a34a; }
          .status-pulse.offline { background: rgba(239,68,68,0.15); border: 2px solid #dc2626; }
          .status-pulse.online::after { content: ''; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid rgba(34,197,94,0.3); animation: ripple 2s infinite; }
          @keyframes ripple { 0% { transform: scale(1); opacity: 1; } 100% { transform: scale(1.5); opacity: 0; } }
          .status-info h2 { font-size: 20px; font-weight: 700; }
          .status-info h2.online { color: #22c55e; }
          .status-info h2.offline { color: #ef4444; }
          .status-info p { font-size: 13px; color: var(--muted); margin-top: 4px; }
          .status-meta { margin-left: auto; text-align: right; flex-shrink: 0; }
          .status-meta .ping-badge { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 20px; background: rgba(59,130,246,0.15); border: 1px solid rgba(59,130,246,0.3); color: #60a5fa; }

          /* GRID */
          .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
          @media(max-width: 640px) { .grid { grid-template-columns: 1fr; } }
          .grid-3 { grid-template-columns: 1fr 1fr 1fr; }
          @media(max-width: 640px) { .grid-3 { grid-template-columns: 1fr; } }

          /* CARDS */
          .card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 20px; }
          .card-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; color: var(--muted); margin-bottom: 14px; }
          .card-value { font-size: 28px; font-weight: 700; color: var(--text); line-height: 1; }
          .card-sub { font-size: 12px; color: var(--muted); margin-top: 6px; }

          /* HEALTH & FOOD BARS */
          .bar-row { margin-bottom: 12px; }
          .bar-label { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
          .bar-label span:last-child { font-weight: 600; color: var(--text); }
          .bar-track { background: var(--border); border-radius: 99px; height: 8px; overflow: hidden; }
          .bar-fill { height: 100%; border-radius: 99px; transition: width 0.4s ease; }
          .bar-hp { background: linear-gradient(90deg, #ef4444, #f87171); }
          .bar-food { background: linear-gradient(90deg, #f59e0b, #fbbf24); }

          /* PLAYERS */
          .player-list { display: flex; flex-direction: column; gap: 6px; max-height: 180px; overflow-y: auto; }
          .player-item { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: var(--bg); border-radius: 8px; font-size: 13px; }
          .player-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); flex-shrink: 0; }
          .player-name { font-weight: 500; }
          .player-ping { margin-left: auto; font-size: 11px; color: var(--muted); }
          .empty-state { font-size: 13px; color: var(--muted); text-align: center; padding: 20px 0; }

          /* INVENTORY */
          .inv-grid { display: grid; grid-template-columns: repeat(9, 1fr); gap: 4px; }
          .inv-slot { aspect-ratio: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 10px; color: var(--muted); text-align: center; padding: 2px; overflow: hidden; cursor: default; position: relative; transition: border-color 0.2s; }
          .inv-slot:hover { border-color: var(--blue); }
          .inv-slot .item-name { font-size: 9px; line-height: 1.2; word-break: break-all; color: var(--text); }
          .inv-slot .item-count { position: absolute; bottom: 1px; right: 2px; font-size: 8px; font-weight: 700; color: #fbbf24; }

          /* CHAT MIRROR */
          .chat-box { background: var(--bg); border-radius: 10px; padding: 12px; max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
          .chat-msg { font-size: 12.5px; line-height: 1.5; }
          .chat-time { color: var(--muted); font-size: 10px; margin-right: 6px; }
          .chat-user { font-weight: 700; color: #60a5fa; margin-right: 4px; }
          .chat-text { color: var(--text); }
          .chat-input-row { display: flex; gap: 8px; }
          .chat-input { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 9px 14px; font-size: 13px; color: var(--text); font-family: inherit; outline: none; transition: border-color 0.2s; }
          .chat-input:focus { border-color: var(--blue); }
          .chat-send { padding: 9px 18px; background: #1d4ed8; border: none; border-radius: 8px; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; transition: background 0.2s; font-family: inherit; }
          .chat-send:hover { background: #2563eb; }

          /* KICK ANALYZER */
          .kick-card { border-radius: 10px; padding: 14px 16px; border: 1px solid; margin-bottom: 0; }
          .kick-header { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; margin-bottom: 6px; }
          .kick-tip { font-size: 12px; color: var(--muted); line-height: 1.5; }

          /* CONTROLS */
          .controls { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 20px; }
          .btn { min-height: 48px; border-radius: 10px; font-size: 14px; font-weight: 700; cursor: pointer; border: 1.5px solid; font-family: inherit; transition: all 0.2s; }
          .btn:hover { filter: brightness(1.15); }
          .btn-start { background: #052e16; border-color: #16a34a; color: #22c55e; }
          .btn-stop  { background: #1c0505; border-color: #dc2626; color: #ef4444; }

          /* FOOTER */
          footer { text-align: center; margin-top: 28px; font-size: 12px; color: var(--muted); }

          /* SCROLLBAR */
          ::-webkit-scrollbar { width: 4px; height: 4px; }
          ::-webkit-scrollbar-track { background: transparent; }
          ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 99px; }
        </style>
      </head>
      <body>
        <div class="container">
          <!-- HEADER -->
          <div class="header">
            <div class="header-left">
              <h1>⛏️ ${config.name}</h1>
              <p>Minecraft keep-alive bot &middot; ${config.server.ip}</p>
            </div>
            <div class="header-right">
              <a href="/tutorial" class="nav-btn">Setup guide</a>
              <a href="/logs" class="nav-btn">Logs</a>
            </div>
          </div>

          <!-- STATUS HERO -->
          <div class="status-hero offline" id="status-hero">
            <div class="status-pulse offline" id="status-pulse">⚡</div>
            <div class="status-info">
              <h2 class="offline" id="status-label">Connecting…</h2>
              <p id="status-detail">Establishing connection to server</p>
            </div>
            <div class="status-meta">
              <div class="ping-badge" id="ping-badge">Ping: —</div>
            </div>
          </div>

          <!-- STATS ROW -->
          <div class="grid grid-3" style="margin-bottom:16px">
            <div class="card">
              <div class="card-title">Uptime</div>
              <div class="card-value" id="uptime-val">—</div>
              <div class="card-sub">Since last connect</div>
            </div>
            <div class="card">
              <div class="card-title">Reconnects</div>
              <div class="card-value" id="reconnect-val">0</div>
              <div class="card-sub">Total reconnect attempts</div>
            </div>
            <div class="card">
              <div class="card-title">Coordinates</div>
              <div class="card-value" style="font-size:16px;margin-top:6px" id="coords-val">—</div>
              <div class="card-sub">Bot's current position</div>
            </div>
          </div>

          <!-- HEALTH & FOOD + PLAYERS -->
          <div class="grid" style="margin-bottom:16px">
            <div class="card">
              <div class="card-title">Bot Vitals</div>
              <div class="bar-row">
                <div class="bar-label"><span>❤️ Health</span><span id="hp-text">—</span></div>
                <div class="bar-track"><div class="bar-fill bar-hp" id="hp-bar" style="width:0%"></div></div>
              </div>
              <div class="bar-row">
                <div class="bar-label"><span>🍖 Food</span><span id="food-text">—</span></div>
                <div class="bar-track"><div class="bar-fill bar-food" id="food-bar" style="width:0%"></div></div>
              </div>
            </div>
            <div class="card">
              <div class="card-title">Players Online</div>
              <div class="player-list" id="player-list">
                <div class="empty-state">No players detected</div>
              </div>
            </div>
          </div>

          <!-- INVENTORY -->
          <div class="card" style="margin-bottom:16px">
            <div class="card-title">Inventory (Hotbar)</div>
            <div class="inv-grid" id="inv-grid">
              ${Array(9).fill('<div class="inv-slot"><span style="font-size:16px">·</span></div>').join('')}
            </div>
          </div>

          <!-- CHAT MIRROR -->
          <div class="card" style="margin-bottom:16px">
            <div class="card-title">💬 In-Game Chat</div>
            <div class="chat-box" id="chat-box">
              <div class="empty-state">No chat messages yet</div>
            </div>
            <div class="chat-input-row">
              <input class="chat-input" id="chat-input" type="text" placeholder="Send a message in-game…" maxlength="256">
              <button class="chat-send" onclick="sendChat()">Send</button>
            </div>
          </div>

          <!-- KICK ANALYZER -->
          <div id="kick-section" style="display:none;margin-bottom:16px">
            <div class="card-title" style="margin-bottom:8px">🧠 Last Kick Analysis</div>
            <div class="kick-card" id="kick-card">
              <div class="kick-header" id="kick-header"></div>
              <div class="kick-tip" id="kick-tip"></div>
            </div>
          </div>

          <!-- CONTROLS -->
          <div class="controls">
            <button class="btn btn-start" onclick="startBot()">▶ Start Bot</button>
            <button class="btn btn-stop"  onclick="stopBot()">■ Stop Bot</button>
          </div>

          <footer><p>Updates every 4 seconds &middot; ${config.name} &middot; ${config.server.ip}</p></footer>
        </div>

        <script>
          let lastChatCount = 0;

          function fmt(s) {
            const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
            if (h > 0) return h+'h '+m+'m '+sec+'s';
            if (m > 0) return m+'m '+sec+'s';
            return sec+'s';
          }

          function setOnline(on) {
            const hero  = document.getElementById('status-hero');
            const pulse = document.getElementById('status-pulse');
            const label = document.getElementById('status-label');
            hero.className  = 'status-hero '  + (on ? 'online' : 'offline');
            pulse.className = 'status-pulse ' + (on ? 'online' : 'offline');
            label.className = on ? 'online' : 'offline';
            label.textContent = on ? 'Connected' : 'Disconnected';
            document.getElementById('status-detail').textContent = on
              ? 'Bot is active and keeping the server alive'
              : 'Bot is reconnecting…';
            pulse.textContent = on ? '✓' : '✗';
          }

          async function update() {
            try {
              const r = await fetch('/health');
              const d = await r.json();
              const on = d.status === 'connected';
              setOnline(on);

              document.getElementById('uptime-val').textContent = fmt(d.uptime);
              document.getElementById('reconnect-val').textContent = d.reconnectAttempts;
              document.getElementById('ping-badge').textContent = d.ping != null ? 'Ping: ' + d.ping + 'ms' : 'Ping: —';

              if (d.coords) {
                const p = d.coords;
                document.getElementById('coords-val').textContent =
                  'X '+Math.floor(p.x)+' Y '+Math.floor(p.y)+' Z '+Math.floor(p.z);
              }

              // Health & food bars
              if (d.health != null) {
                const hp = Math.round(d.health);
                document.getElementById('hp-text').textContent = hp + ' / 20';
                document.getElementById('hp-bar').style.width = (hp/20*100)+'%';
              }
              if (d.food != null) {
                const food = Math.round(d.food);
                document.getElementById('food-text').textContent = food + ' / 20';
                document.getElementById('food-bar').style.width = (food/20*100)+'%';
              }

              // Players
              const playerList = document.getElementById('player-list');
              if (d.players && d.players.length > 0) {
                playerList.innerHTML = d.players.map(p =>
                  '<div class="player-item"><div class="player-dot"></div><span class="player-name">'+p.username+'</span>'
                  +(p.ping != null ? '<span class="player-ping">'+p.ping+'ms</span>' : '')+'</div>'
                ).join('');
              } else {
                playerList.innerHTML = '<div class="empty-state">No players detected</div>';
              }

              // Inventory
              const invGrid = document.getElementById('inv-grid');
              if (d.inventory && d.inventory.length > 0) {
                const slots = Array(9).fill(null);
                d.inventory.forEach(item => { if (item.slot < 9) slots[item.slot] = item; });
                invGrid.innerHTML = slots.map(item => item
                  ? '<div class="inv-slot" title="'+item.name+' x'+item.count+'"><span class="item-name">'+item.displayName.replace(/ /g,'\\n')+'</span><span class="item-count">'+item.count+'</span></div>'
                  : '<div class="inv-slot"><span style="font-size:16px;color:var(--border)">·</span></div>'
                ).join('');
              }

              // Kick analyzer
              if (d.lastKickAnalysis) {
                const k = d.lastKickAnalysis;
                document.getElementById('kick-section').style.display = 'block';
                const card = document.getElementById('kick-card');
                card.style.borderColor = k.color;
                card.style.background = k.color + '18';
                document.getElementById('kick-header').innerHTML = '<span>'+k.icon+'</span><span style="color:'+k.color+'">'+k.label+'</span>';
                document.getElementById('kick-tip').textContent = k.tip;
              } else {
                document.getElementById('kick-section').style.display = 'none';
              }

            } catch(e) {
              setOnline(false);
            }

            // Chat mirror
            try {
              const cr = await fetch('/chat-history');
              const msgs = await cr.json();
              if (msgs.length !== lastChatCount) {
                lastChatCount = msgs.length;
                const box = document.getElementById('chat-box');
                if (msgs.length === 0) {
                  box.innerHTML = '<div class="empty-state">No chat messages yet</div>';
                } else {
                  box.innerHTML = msgs.map(m => {
                    const t = new Date(m.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
                    return '<div class="chat-msg"><span class="chat-time">'+t+'</span>'
                      +'<span class="chat-user">'+m.username+'</span>'
                      +'<span class="chat-text">'+m.message+'</span></div>';
                  }).join('');
                  box.scrollTop = box.scrollHeight;
                }
              }
            } catch(_) {}
          }

          async function sendChat() {
            const input = document.getElementById('chat-input');
            const msg = input.value.trim();
            if (!msg) return;
            input.value = '';
            await fetch('/command', {
              method: 'POST',
              headers: {'Content-Type':'application/json'},
              body: JSON.stringify({ command: msg })
            });
            update();
          }

          document.getElementById('chat-input').addEventListener('keydown', e => {
            if (e.key === 'Enter') sendChat();
          });

          async function startBot() {
            const r = await fetch('/start', { method: 'POST' });
            const d = await r.json();
            if (!d.success) alert(d.msg);
            update();
          }
          async function stopBot() {
            const r = await fetch('/stop', { method: 'POST' });
            const d = await r.json();
            if (!d.success) alert(d.msg);
            update();
          }

          setInterval(update, 4000);
          update();
        </script>
      </body>
    </html>
  `);
});

// ============================================================
// TUTORIAL PAGE (unchanged)
// ============================================================
app.get("/tutorial", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} - Setup Guide</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>
          *, *::before, *::after { box-sizing: border-box; }
          body { font-family: 'Inter', sans-serif; background: #0a0f1a; color: #f1f5f9; margin: 0; padding: 40px 24px; }
          main { width: 100%; max-width: 560px; margin: 0 auto; }
          .back-btn { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; color: #64748b; text-decoration: none; background: #111827; border: 1px solid #1f2937; border-radius: 8px; padding: 7px 14px; margin-bottom: 32px; transition: all 0.2s; }
          .back-btn:hover { background: #1f2937; color: #f1f5f9; }
          header { margin-bottom: 32px; }
          header h1 { font-size: 26px; font-weight: 700; margin: 0; }
          header p { font-size: 14px; color: #64748b; margin: 6px 0 0; }
          .step-card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 24px; margin-bottom: 16px; }
          .step-header { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; }
          .step-number { width: 32px; height: 32px; border-radius: 50%; background: #052e16; border: 2px solid #16a34a; color: #22c55e; font-size: 14px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
          .step-title { font-size: 16px; font-weight: 700; margin: 0; }
          ol { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; }
          li { font-size: 14px; color: #64748b; line-height: 1.6; padding-left: 20px; position: relative; }
          li::before { content: "·"; position: absolute; left: 6px; color: #22c55e; font-weight: 700; }
          li strong { color: #f1f5f9; font-weight: 600; }
          code { background: #1f2937; border: 1px solid #374151; padding: 2px 7px; border-radius: 5px; font-size: 12px; }
          footer { margin-top: 32px; text-align: center; font-size: 12px; color: #374151; }
        </style>
      </head>
      <body>
        <main>
          <a href="/" class="back-btn">← Back to Dashboard</a>
          <header><h1>Setup Guide</h1><p>Get your AFK bot running in under 15 minutes</p></header>
          <div class="step-card">
            <div class="step-header"><div class="step-number">1</div><h2 class="step-title">Configure Aternos</h2></div>
            <ol>
              <li>Go to <strong>Aternos</strong> and open your server.</li>
              <li>Install <strong>Paper/Bukkit</strong> as your server software.</li>
              <li>Enable <strong>Cracked</strong> mode using the green switch.</li>
              <li>Install these plugins: <code>ViaVersion</code>, <code>ViaBackwards</code>, <code>ViaRewind</code></li>
            </ol>
          </div>
          <div class="step-card">
            <div class="step-header"><div class="step-number">2</div><h2 class="step-title">GitHub Setup</h2></div>
            <ol>
              <li>Download this project as a ZIP and extract it.</li>
              <li>Edit <code>settings.json</code> with your server IP and port.</li>
              <li>Upload all files to a new <strong>GitHub Repository</strong>.</li>
            </ol>
          </div>
          <div class="step-card">
            <div class="step-header"><div class="step-number">3</div><h2 class="step-title">Deploy on Render (Free 24/7)</h2></div>
            <ol>
              <li>Import your GitHub repo into <strong>Render</strong>.</li>
              <li>Set the build command to <code>npm install</code>.</li>
              <li>Set the start command to <code>node index.js</code>.</li>
              <li>Hit <strong>Deploy</strong> — the bot connects automatically.</li>
            </ol>
          </div>
          <footer><p>AFK Bot Dashboard · ${config.name}</p></footer>
        </main>
      </body>
    </html>
  `);
});

// ============================================================
// API ENDPOINTS
// ============================================================
app.get("/health", (req, res) => {
  // [NEW] includes ping, health, food, players, inventory, kick analysis
  const players = bot && bot.players
    ? Object.values(bot.players).map(p => ({ username: p.username, ping: p.ping })).filter(p => p.username)
    : [];

  const inventory = bot && bot.inventory
    ? bot.inventory.slots.slice(36, 45).map((item, i) => item ? {
        slot: i,
        name: item.name,
        displayName: item.displayName || item.name,
        count: item.count,
      } : null).filter(Boolean)
    : [];

  res.json({
    status: botState.connected ? "connected" : "disconnected",
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: bot && bot.entity ? bot.entity.position : null,
    lastActivity: botState.lastActivity,
    reconnectAttempts: botState.reconnectAttempts,
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
    ping: botState.ping,
    health: botState.health,
    food: botState.food,
    players,
    inventory,
    lastKickAnalysis: botState.lastKickAnalysis,
  });
});

// [NEW] Chat history endpoint
app.get("/chat-history", (req, res) => res.json(chatHistory));

app.get("/ping", (req, res) => res.send("pong"));

// ============================================================
// LOGS PAGE (unchanged styling, kept functional)
// ============================================================
app.get("/logs", (req, res) => {
  const logs = getLogs();
  const escapeHTML = (str) =>
    str.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]);
  const logCount = logs.length;

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} - Logs</title>
        <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>
          *, *::before, *::after { box-sizing: border-box; }
          body { font-family: 'Inter', sans-serif; background: #0a0f1a; color: #f1f5f9; margin: 0; padding: 40px 24px; }
          main { width: 100%; max-width: 760px; margin: 0 auto; }
          .back-btn { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; color: #64748b; text-decoration: none; background: #111827; border: 1px solid #1f2937; border-radius: 8px; padding: 7px 14px; margin-bottom: 32px; transition: all 0.2s; }
          .back-btn:hover { background: #1f2937; color: #f1f5f9; }
          .page-header { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 20px; gap: 12px; flex-wrap: wrap; }
          .page-header-left h1 { font-size: 26px; font-weight: 700; margin: 0; }
          .page-header-left p { font-size: 14px; color: #64748b; margin: 6px 0 0; }
          .badge { font-size: 12px; font-weight: 600; color: #64748b; background: #111827; border: 1px solid #1f2937; border-radius: 20px; padding: 4px 12px; white-space: nowrap; }
          .log-card { background: #0a0f1a; border: 1px solid #1f2937; border-radius: 12px; overflow: hidden; }
          .log-card-header { background: #111827; border-bottom: 1px solid #1f2937; padding: 12px 18px; display: flex; align-items: center; gap: 8px; }
          .dot { width: 10px; height: 10px; border-radius: 50%; }
          .dot-red { background: #ff5f57; } .dot-yellow { background: #ffbd2e; } .dot-green { background: #28c840; }
          .log-card-title { font-size: 12px; font-weight: 500; color: #374151; margin-left: 4px; }
          .log-body { padding: 16px 18px; max-height: 560px; overflow-y: auto; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12.5px; line-height: 1.7; }
          .log-entry { display: block; padding: 1px 0; white-space: pre-wrap; word-break: break-all; }
          .log-entry.error { color: #f87171; } .log-entry.warn { color: #fbbf24; } .log-entry.success { color: #4ade80; } .log-entry.control { color: #60a5fa; } .log-entry.default { color: #64748b; }
          .empty-state { text-align: center; padding: 40px 20px; color: #374151; font-size: 13px; }
          .console-row { display: flex; align-items: center; border-top: 1px solid #1f2937; background: #0a0f1a; padding: 10px 18px; gap: 10px; }
          .console-prompt { font-family: monospace; font-size: 13px; color: #22c55e; font-weight: 700; flex-shrink: 0; }
          .console-input { flex: 1; background: transparent; border: none; outline: none; font-family: monospace; font-size: 12.5px; color: #f1f5f9; caret-color: #22c55e; }
          .console-send { background: #052e16; border: 1px solid #16a34a; color: #22c55e; font-size: 12px; font-weight: 600; padding: 5px 14px; border-radius: 6px; cursor: pointer; font-family: inherit; transition: background 0.2s; }
          .console-send:hover { background: #14532d; }
          .refresh-bar { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin-top: 12px; font-size: 12px; color: #374151; }
          .refresh-dot { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; animation: pulse 2s infinite; }
          @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
          footer { margin-top: 32px; text-align: center; font-size: 12px; color: #374151; }
        </style>
      </head>
      <body>
        <main>
          <a href="/" class="back-btn">← Back to Dashboard</a>
          <div class="page-header">
            <div class="page-header-left"><h1>Bot Logs</h1><p>Live output from the AFK bot</p></div>
            <span class="badge">${logCount} ${logCount === 1 ? "entry" : "entries"}</span>
          </div>
          <div class="log-card">
            <div class="log-card-header">
              <span class="dot dot-red"></span><span class="dot dot-yellow"></span><span class="dot dot-green"></span>
              <span class="log-card-title">bot.log</span>
            </div>
            <div class="log-body" id="log-body">
              ${logCount === 0
                ? `<div class="empty-state">No log entries yet.</div>`
                : logs.map((l) => {
                    const escaped = escapeHTML(l);
                    const lower = l.toLowerCase();
                    let cls = "default";
                    if (lower.includes("error") || lower.includes("fail")) cls = "error";
                    else if (lower.includes("warn")) cls = "warn";
                    else if (lower.includes("[control]")) cls = "control";
                    else if (lower.includes("connect") || lower.includes("join") || lower.includes("spawn")) cls = "success";
                    return `<span class="log-entry ${cls}">${escaped}</span>`;
                  }).join("")
              }
            </div>
            <div class="console-row">
              <span class="console-prompt">></span>
              <input id="console-input" class="console-input" type="text" placeholder="Type a command or message…" autocomplete="off">
              <button id="console-send" class="console-send">Send</button>
            </div>
          </div>
          <div class="refresh-bar"><span class="refresh-dot"></span><span>Auto-refreshing every 5 seconds</span></div>
          <footer><p>AFK Bot Dashboard · ${config.name}</p></footer>
        </main>
        <script>
          const logBody = document.getElementById('log-body');
          const input = document.getElementById('console-input');
          const sendBtn = document.getElementById('console-send');
          if (logBody) logBody.scrollTop = logBody.scrollHeight;
          function appendEntry(text, cls) {
            const span = document.createElement('span');
            span.className = 'log-entry ' + (cls||'control');
            span.textContent = text;
            logBody.appendChild(span);
            logBody.scrollTop = logBody.scrollHeight;
          }
          async function sendCommand() {
            const cmd = input.value.trim();
            if (!cmd) return;
            input.value = '';
            sendBtn.disabled = true;
            appendEntry('> ' + cmd, 'control');
            try {
              const r = await fetch('/command', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({command: cmd}) });
              const d = await r.json();
              if (d.msg) d.msg.split('\\n').forEach(l => appendEntry(l, d.success ? 'default' : 'error'));
            } catch(_) { appendEntry('Failed to send.', 'error'); }
            sendBtn.disabled = false;
            input.focus();
          }
          sendBtn.addEventListener('click', sendCommand);
          input.addEventListener('keydown', e => { if (e.key === 'Enter') sendCommand(); });
          setTimeout(() => location.reload(), 5000);
        </script>
      </body>
    </html>
  `);
});

// ============================================================
// BOT CONTROL ENDPOINTS
// ============================================================
let botRunning = true;

app.post("/start", (req, res) => {
  if (botRunning) return res.json({ success: false, msg: "Already running" });
  botRunning = true;
  createBot();
  addLog("[Control] Bot started");
  res.json({ success: true });
});

app.post("/stop", (req, res) => {
  if (!botRunning) return res.json({ success: false, msg: "Already stopped" });
  botRunning = false;
  if (bot) { try { bot.end(); } catch (_) {} bot = null; }
  clearAllIntervals();
  clearBotTimeouts();
  isReconnecting = false;
  addLog("[Control] Bot stopped");
  res.json({ success: true });
});

app.post("/command", express.json(), (req, res) => {
  const cmd = (req.body.command || "").trim();
  if (!cmd) return res.json({ success: false, msg: "Empty command." });
  addLog(`[Console] > ${cmd}`);

  if (cmd === "/help") {
    const lines = [
      "Available commands:",
      "  /help   - Show this help",
      "  /pos    - Show coordinates",
      "  /status - Show bot status",
      "  /list   - Player list",
      "  /say <message> - Send chat",
    ];
    lines.forEach((l) => addLog(`[Console] ${l}`));
    return res.json({ success: true, msg: lines.join("\n") });
  }
  if (cmd === "/pos" || cmd === "/coords") {
    const pos = bot && bot.entity ? bot.entity.position : null;
    const msg = pos
      ? `Position: X=${Math.floor(pos.x)} Y=${Math.floor(pos.y)} Z=${Math.floor(pos.z)}`
      : "Position unavailable.";
    addLog(`[Console] ${msg}`);
    return res.json({ success: true, msg });
  }
  if (cmd === "/status") {
    const status = botState.connected ? "Connected" : "Disconnected";
    const uptime = Math.floor((Date.now() - botState.startTime) / 1000);
    const msg = `Status: ${status} | Uptime: ${uptime}s | Reconnects: ${botState.reconnectAttempts}`;
    addLog(`[Console] ${msg}`);
    return res.json({ success: true, msg });
  }

  if (!bot || typeof bot.chat !== "function") {
    const msg = bot ? "Bot is still connecting — try again in a moment." : "Bot is not running.";
    addLog(`[Console] ${msg}`);
    return res.json({ success: false, msg });
  }

  try {
    // [NEW] Use safe chat with anti-spam guard
    safeBotChat(cmd);
    addLog(`[Console] Sent: ${cmd}`);
    return res.json({ success: true, msg: `Sent: ${cmd}` });
  } catch (err) {
    addLog(`[Console] Error: ${err.message}`);
    return res.json({ success: false, msg: err.message });
  }
});

// ============================================================
// HTTP SERVER
// ============================================================
const server = app.listen(PORT, "0.0.0.0", () => {
  addLog(`[Server] HTTP server started on port ${server.address().port}`);
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    const fallbackPort = PORT + 1;
    addLog(`[Server] Port ${PORT} in use - trying ${fallbackPort}`);
    server.listen(fallbackPort, "0.0.0.0");
  } else {
    addLog(`[Server] HTTP server error: ${err.message}`);
  }
});

// ============================================================
// UTILITIES
// ============================================================
function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

// ============================================================
// SELF-PING
// ============================================================
const SELF_PING_INTERVAL = 10 * 60 * 1000;
function startSelfPing() {
  const renderUrl = process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN;
  if (!renderUrl) { addLog("[KeepAlive] No external URL set - self-ping disabled"); return; }
  setInterval(() => {
    const protocol = renderUrl.startsWith("https") ? https : http;
    protocol.get(`${renderUrl}/ping`, () => {}).on("error", (err) => {
      addLog(`[KeepAlive] Self-ping failed: ${err.message}`);
    });
  }, SELF_PING_INTERVAL);
  addLog("[KeepAlive] Self-ping started (every 10 min)");
}
startSelfPing();

// ============================================================
// MEMORY MONITORING
// ============================================================
setInterval(() => {
  const heapMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
  addLog(`[Memory] Heap: ${heapMB} MB`);
}, 5 * 60 * 1000);

// ============================================================
// BOT STATE & RECONNECTION
// ============================================================
function clearBotTimeouts() {
  if (reconnectTimeoutId)  { clearTimeout(reconnectTimeoutId);  reconnectTimeoutId  = null; }
  if (connectionTimeoutId) { clearTimeout(connectionTimeoutId); connectionTimeoutId = null; }
}
function clearAllIntervals() {
  addLog(`[Cleanup] Clearing ${activeIntervals.length} intervals`);
  activeIntervals.forEach((id) => clearInterval(id));
  activeIntervals = [];
}
function addInterval(callback, delay) {
  const id = setInterval(callback, delay);
  activeIntervals.push(id);
  return id;
}

// ============================================================
// RECONNECT DELAY LOGIC
// ============================================================
const KICK_REASONS = {
  PROXY_DUPLICATE: "already connected to this proxy",
  THROTTLE_KEYWORDS: ["throttl", "wait before reconnect", "too fast"],
};

function getReconnectDelay() {
  const reason = (lastKickReason || "").toLowerCase();
  if (reason.includes(KICK_REASONS.PROXY_DUPLICATE)) {
    const delay = 65000 + Math.floor(Math.random() * 15000);
    addLog(`[Bot] Proxy duplicate — waiting ${(delay/1000).toFixed(0)}s`);
    return delay;
  }
  if (lastKickReason === "") {
    const delay = 30000 + Math.floor(Math.random() * 10000);
    addLog(`[Bot] Server not ready — waiting ${(delay/1000).toFixed(0)}s`);
    return delay;
  }
  if (botState.wasThrottled || KICK_REASONS.THROTTLE_KEYWORDS.some((k) => reason.includes(k))) {
    botState.wasThrottled = false;
    const delay = 60000 + Math.floor(Math.random() * 60000);
    addLog(`[Bot] Throttle detected — waiting ${(delay/1000).toFixed(0)}s`);
    return delay;
  }
  const baseDelay = config.utils["auto-reconnect-delay"] || 3000;
  const maxDelay  = config.utils["max-reconnect-delay"]  || 30000;
  const delay = Math.min(baseDelay * Math.pow(2, botState.reconnectAttempts), maxDelay);
  const jitter = Math.floor(Math.random() * 2000);
  return delay + jitter;
}

// ============================================================
// BOT CREATION
// ============================================================
function createBot() {
  if (!botRunning) return;
  if (isReconnecting) { addLog("[Bot] Already reconnecting, skipping..."); return; }
  if (bot) {
    clearAllIntervals();
    try { bot.removeAllListeners(); bot.end(); } catch (_) {}
    bot = null;
  }

  addLog(`[Bot] Connecting to ${config.server.ip}:${config.server.port}`);

  try {
    const botVersion = config.server.version && config.server.version.trim() !== "" ? config.server.version : false;

    bot = mineflayer.createBot({
      username: config["bot-account"].username,
      password: config["bot-account"].password || undefined,
      auth: config["bot-account"].type,
      host: config.server.ip,
      port: config.server.port,
      version: botVersion,
      hideErrors: false,
      keepAlive: false,
      checkTimeoutInterval: 600000,
    });

    bot._client.on("keep_alive", (packet) => {
      try { bot._client.write("keep_alive", { keepAliveId: packet.keepAliveId }); } catch (_) {}
    });

    bot.loadPlugin(pathfinder);

    clearBotTimeouts();
    connectionTimeoutId = setTimeout(() => {
      if (!botState.connected) {
        addLog("[Bot] Connection timeout after 150s");
        try { bot.removeAllListeners(); bot.end(); } catch (_) {}
        bot = null;
        scheduleReconnect();
      }
    }, 150000);

    let spawnHandled = false;

    bot.once("spawn", () => {
      if (spawnHandled) return;
      spawnHandled = true;
      lastKickReason = null;
      clearBotTimeouts();
      botState.connected = true;
      botState.lastActivity = Date.now();
      botState.reconnectAttempts = 0;
      botState.lastKickAnalysis = null; // [NEW] clear on connect
      isReconnecting = false;

      addLog(`[Bot] [+] Spawned! (Version: ${bot.version})`);
      startTelemetry(bot, config.server.ip);

      if (config.discord?.events?.connect)
        sendDiscordWebhook(`[+] **Connected** to \`${config.server.ip}\``, 0x4ade80);

      const mcData = require("minecraft-data")(bot.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.allowFreeMotion = false;
      defaultMove.canDig = false;
      defaultMove.liquidCost = 1000;
      defaultMove.fallDamageCost = 1000;

      // [NEW] Track ping
      addInterval(() => {
        if (bot && botState.connected) botState.ping = bot.player ? bot.player.ping : null;
      }, 5000);

      // [NEW] Track health & food
      bot.on("health", () => {
        botState.health = bot.health;
        botState.food   = bot.food;
      });

      initializeModules(bot, mcData, defaultMove);

      setTimeout(() => {
        if (bot && botState.connected && config.server["try-creative"]) {
          safeBotChat("/gamemode creative");
          addLog("[INFO] Attempted creative mode");
        }
      }, 3000);

      bot.on("messagestr", (message) => {
        if (message.includes("Set own game mode to Creative Mode"))
          addLog("[INFO] Bot is now in Creative Mode.");
      });
    });

    bot.on("kicked", (reason) => {
      const kickReason = typeof reason === "object" ? JSON.stringify(reason) : String(reason || "");
      addLog(`[Bot] Kicked: ${kickReason}`);
      botState.connected = false;
      botState.errors.push({ type: "kicked", reason: kickReason, time: Date.now() });
      clearAllIntervals();

      let kickText = kickReason;
      try { const parsed = JSON.parse(kickReason); kickText = parsed.text || kickReason; } catch (_) {}
      lastKickReason = kickText;

      // [NEW] Analyze & store kick reason for dashboard
      botState.lastKickAnalysis = analyzeKickReason(kickText);
      addLog(`[KickAnalyzer] ${botState.lastKickAnalysis.label}: ${botState.lastKickAnalysis.tip}`);
      addReconnectEvent(kickText, "kicked");

      const lower = kickText.toLowerCase();
      if (KICK_REASONS.THROTTLE_KEYWORDS.some((k) => lower.includes(k))) botState.wasThrottled = true;

      if (config.discord?.events?.disconnect)
        sendDiscordWebhook(`[!] **Kicked**: ${kickReason}`, 0xff0000);
    });

    bot.on("end", (reason) => {
      addLog(`[Bot] Disconnected: ${reason || "Unknown"}`);
      botState.connected = false;
      clearAllIntervals();
      spawnHandled = false;
      addReconnectEvent(reason || "Unknown", "disconnect"); // [NEW]

      if (config.discord?.events?.disconnect)
        sendDiscordWebhook(`[-] **Disconnected**: ${reason || "Unknown"}`, 0xf87171);

      if (botRunning) scheduleReconnect();
    });

    bot.on("error", (err) => {
      const msg = err?.message || String(err);
      addLog(`[Bot] Error: ${msg}`);
      botState.errors.push({ type: "error", message: msg, time: Date.now() });
    });

  } catch (err) {
    addLog(`[Bot] Failed to create bot: ${err.message}`);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!botRunning) return;
  clearBotTimeouts();
  if (isReconnecting) { addLog("[Bot] Reconnect already scheduled."); return; }
  isReconnecting = true;
  botState.reconnectAttempts++;
  const delay = getReconnectDelay();
  addLog(`[Bot] Reconnecting in ${(delay/1000).toFixed(1)}s (attempt #${botState.reconnectAttempts})`);
  reconnectTimeoutId = setTimeout(() => {
    reconnectTimeoutId = null;
    isReconnecting = false;
    lastKickReason = null;
    createBot();
  }, delay);
}

// ============================================================
// MODULE INITIALIZATION
// ============================================================
function initializeModules(bot, mcData, defaultMove) {
  addLog("[Modules] Initializing...");

  // AUTO AUTH
  if (config.utils["auto-auth"]?.enabled) {
    const password = config.utils["auto-auth"].password;
    let authHandled = false;
    const tryAuth = (type) => {
      if (authHandled || !bot || !botState.connected) return;
      authHandled = true;
      if (type === "register") { safeBotChat(`/register ${password} ${password}`); addLog("[Auth] Sent /register"); }
      else { safeBotChat(`/login ${password}`); addLog("[Auth] Sent /login"); }
    };
    bot.on("messagestr", (message) => {
      if (authHandled) return;
      const msg = message.toLowerCase();
      if (msg.includes("/register") || msg.includes("register ")) tryAuth("register");
      else if (msg.includes("/login") || msg.includes("login ")) tryAuth("login");
    });
    setTimeout(() => {
      if (!authHandled && bot && botState.connected) {
        safeBotChat(`/login ${password}`); authHandled = true;
        addLog("[Auth] Failsafe /login sent");
      }
    }, 10000);
  }

  // CHAT MESSAGES
  if (config.utils["chat-messages"]?.enabled) {
    const messages = config.utils["chat-messages"].messages;
    if (config.utils["chat-messages"].repeat) {
      let i = 0;
      addInterval(() => {
        if (bot && botState.connected) {
          safeBotChat(messages[i]); // [NEW] uses anti-spam guard
          botState.lastActivity = Date.now();
          i = (i + 1) % messages.length;
        }
      }, config.utils["chat-messages"]["repeat-delay"] * 1000);
    } else {
      messages.forEach((msg, idx) => {
        setTimeout(() => { if (bot && botState.connected) safeBotChat(msg); }, idx * 1500);
      });
    }
  }

  // MOVE TO POSITION
  const circleWalkEnabled = config.movement?.["circle-walk"]?.enabled;
  if (config.position?.enabled && !circleWalkEnabled) {
    bot.pathfinder.setMovements(defaultMove);
    bot.pathfinder.setGoal(new GoalBlock(config.position.x, config.position.y, config.position.z));
    addLog("[Position] Navigating to configured position...");
  }

  // ANTI-AFK
  if (config.utils["anti-afk"]?.enabled) {
    addInterval(() => { if (!bot || !botState.connected) return; try { bot.swingArm(); } catch (_) {} }, 15000 + Math.floor(Math.random() * 15000));
    addInterval(() => { if (!bot || !botState.connected) return; try { bot.setQuickBarSlot(Math.floor(Math.random() * 9)); } catch (_) {} }, 20000 + Math.floor(Math.random() * 20000));
    addInterval(() => {
      if (!bot || !botState.connected) return;
      try { bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.5, true); botState.lastActivity = Date.now(); } catch (_) {}
    }, 10000 + Math.floor(Math.random() * 10000));

    if (!circleWalkEnabled) {
      addInterval(() => {
        if (!bot || !botState.connected || typeof bot.setControlState !== "function") return;
        try {
          bot.look(Math.random() * Math.PI * 2, 0, true);
          bot.setControlState("forward", true);
          setTimeout(() => { if (bot && typeof bot.setControlState === "function") bot.setControlState("forward", false); }, 400 + Math.floor(Math.random() * 600));
          botState.lastActivity = Date.now();
        } catch (e) { addLog(`[AntiAFK] Walk error: ${e.message}`); }
      }, 45000 + Math.floor(Math.random() * 45000));
    }

    addInterval(() => {
      if (!bot || !botState.connected || typeof bot.setControlState !== "function") return;
      if (Math.random() > 0.5) {
        let count = 2 + Math.floor(Math.random() * 3);
        const doTeabag = () => {
          if (count <= 0 || !bot || typeof bot.setControlState !== "function") return;
          try {
            bot.setControlState("sneak", true);
            setTimeout(() => { if (bot && typeof bot.setControlState === "function") bot.setControlState("sneak", false); count--; setTimeout(doTeabag, 200); }, 200);
          } catch (_) {}
        };
        doTeabag();
      }
    }, 180000 + Math.floor(Math.random() * 120000));

    addInterval(() => {
      if (!bot || !botState.connected || typeof bot.setControlState !== "function") return;
      try {
        bot.setControlState("jump", true);
        setTimeout(() => { if (bot && typeof bot.setControlState === "function") bot.setControlState("jump", false); }, 300);
        botState.lastActivity = Date.now();
      } catch (e) { addLog(`[AntiAFK] Jump error: ${e.message}`); }
    }, 60000 + Math.floor(Math.random() * 60000));

    if (config.utils["anti-afk"].sneak) {
      try { if (typeof bot.setControlState === "function") bot.setControlState("sneak", true); } catch (_) {}
    }
  }

  // MOVEMENT
  if (config.movement?.enabled !== false) {
    if (circleWalkEnabled) startCircleWalk(bot, defaultMove);
    if (config.movement?.["random-jump"]?.enabled && !circleWalkEnabled) startRandomJump(bot);
    if (config.movement?.["look-around"]?.enabled) startLookAround(bot);
  }

  // CUSTOM MODULES
  if (config.modules.avoidMobs && !config.modules.combat) avoidMobs(bot);
  if (config.modules.combat)  combatModule(bot, mcData);
  if (config.modules.beds)    bedModule(bot, mcData);
  if (config.modules.chat)    chatModule(bot);

  addLog("[Modules] All initialized!");
}

// ============================================================
// MOVEMENT HELPERS
// ============================================================
function startCircleWalk(bot, defaultMove) {
  const radius = config.movement["circle-walk"].radius;
  let angle = 0, lastPathTime = 0;
  addInterval(() => {
    if (!bot || !botState.connected) return;
    const now = Date.now();
    if (now - lastPathTime < 2000) return;
    lastPathTime = now;
    try {
      const x = bot.entity.position.x + Math.cos(angle) * radius;
      const z = bot.entity.position.z + Math.sin(angle) * radius;
      bot.pathfinder.setMovements(defaultMove);
      bot.pathfinder.setGoal(new GoalBlock(Math.floor(x), Math.floor(bot.entity.position.y), Math.floor(z)));
      angle += Math.PI / 4;
      botState.lastActivity = Date.now();
    } catch (e) { addLog(`[CircleWalk] Error: ${e.message}`); }
  }, config.movement["circle-walk"].speed);
}

function startRandomJump(bot) {
  addInterval(() => {
    if (!bot || !botState.connected || typeof bot.setControlState !== "function") return;
    try {
      bot.setControlState("jump", true);
      setTimeout(() => { if (bot && typeof bot.setControlState === "function") bot.setControlState("jump", false); }, 300);
      botState.lastActivity = Date.now();
    } catch (e) { addLog(`[RandomJump] Error: ${e.message}`); }
  }, config.movement["random-jump"].interval);
}

function startLookAround(bot) {
  addInterval(() => {
    if (!bot || !botState.connected) return;
    try {
      bot.look(Math.random() * Math.PI * 2 - Math.PI, (Math.random() * Math.PI) / 2 - Math.PI / 4, false);
      botState.lastActivity = Date.now();
    } catch (e) { addLog(`[LookAround] Error: ${e.message}`); }
  }, config.movement["look-around"].interval);
}

// ============================================================
// CUSTOM MODULES
// ============================================================
function avoidMobs(bot) {
  const safeDistance = 5;
  addInterval(() => {
    if (!bot || !botState.connected || typeof bot.setControlState !== "function") return;
    try {
      const entities = Object.values(bot.entities).filter(
        (e) => e.type === "mob" || (e.type === "player" && e.username !== bot.username)
      );
      for (const e of entities) {
        if (!e.position) continue;
        if (bot.entity.position.distanceTo(e.position) < safeDistance) {
          bot.setControlState("back", true);
          setTimeout(() => { if (bot && typeof bot.setControlState === "function") bot.setControlState("back", false); }, 500);
          break;
        }
      }
    } catch (e) { addLog(`[AvoidMobs] Error: ${e.message}`); }
  }, 2000);
}

function combatModule(bot, mcData) {
  let lastAttackTime = 0, lockedTarget = null, lockedTargetExpiry = 0;
  bot.on("physicsTick", () => {
    if (!bot || !botState.connected || !config.combat?.["attack-mobs"]) return;
    const now = Date.now();
    if (now - lastAttackTime < 620) return;
    try {
      if (lockedTarget && now < lockedTargetExpiry && bot.entities[lockedTarget.id] && lockedTarget.position) {
        if (bot.entity.position.distanceTo(lockedTarget.position) < 4) {
          bot.attack(lockedTarget); lastAttackTime = now; return;
        }
        lockedTarget = null;
      }
      const mobs = Object.values(bot.entities).filter(
        (e) => e.type === "mob" && e.position && bot.entity.position.distanceTo(e.position) < 4
      );
      if (mobs.length > 0) {
        lockedTarget = mobs[0]; lockedTargetExpiry = now + 3000;
        bot.attack(lockedTarget); lastAttackTime = now;
      }
    } catch (e) { addLog(`[Combat] Error: ${e.message}`); }
  });

  bot.on("health", () => {
    if (!config.combat?.["auto-eat"]) return;
    try {
      if (bot.food < 14) {
        const food = bot.inventory.items().find((i) => i.foodPoints && i.foodPoints > 0);
        if (food) bot.equip(food, "hand").then(() => bot.consume()).catch((e) => addLog(`[AutoEat] Error: ${e.message}`));
      }
    } catch (e) { addLog(`[AutoEat] Error: ${e.message}`); }
  });
}

function bedModule(bot, mcData) {
  let isTryingToSleep = false;
  addInterval(async () => {
    if (!bot || !botState.connected || !config.beds?.["place-night"]) return;
    try {
      const isNight = bot.time.timeOfDay >= 12500 && bot.time.timeOfDay <= 23500;
      if (isNight && !isTryingToSleep) {
        const bedBlock = bot.findBlock({ matching: (block) => block.name.includes("bed"), maxDistance: 8 });
        if (bedBlock) {
          isTryingToSleep = true;
          try { await bot.sleep(bedBlock); addLog("[Bed] Sleeping..."); }
          catch (_) {}
          finally { isTryingToSleep = false; }
        }
      }
    } catch (e) { isTryingToSleep = false; addLog(`[Bed] Error: ${e.message}`); }
  }, 10000);
}

// [NEW] Chat module now also stores messages in chatHistory
function chatModule(bot) {
  bot.on("chat", (username, message) => {
    if (!bot || username === bot.username) return;
    try {
      // [NEW] Mirror to dashboard
      addChat(username, message);
      addLog(`[Chat] <${username}> ${message}`);

      if (config.discord?.enabled && config.discord?.events?.chat)
        sendDiscordWebhook(`💬 **${username}**: ${message}`, 0x7289da);

      if (config.chat?.respond) {
        const lowerMsg = message.toLowerCase();
        if (lowerMsg.includes("hello") || lowerMsg.includes("hi"))
          safeBotChat(`Hello, ${username}!`); // [NEW] anti-spam guard
        if (message.startsWith("!tp ")) {
          const target = message.split(" ")[1];
          if (target) safeBotChat(`/tp ${target}`);
        }
      }
    } catch (e) { addLog(`[Chat] Error: ${e.message}`); }
  });

  // [NEW] Also capture all player chat even if config.modules.chat wasn't set
  // (chat mirror works regardless)
  bot.on("chat", (username, message) => {
    if (username === bot.username) return;
    addChat(username, message);
  });
}

// [NEW] Always mirror chat, even if chatModule is not enabled
function startChatMirror(bot) {
  bot.on("chat", (username, message) => {
    if (bot && username !== bot.username) addChat(username, message);
  });
}

// ============================================================
// CONSOLE (stdin)
// ============================================================
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
rl.on("line", (line) => {
  if (!bot || !botState.connected) { addLog("[Console] Bot not connected"); return; }
  const trimmed = line.trim();
  if (trimmed.startsWith("say "))      safeBotChat(trimmed.slice(4));
  else if (trimmed.startsWith("cmd ")) safeBotChat("/" + trimmed.slice(4));
  else if (trimmed === "status")
    addLog(`Connected: ${botState.connected}, Uptime: ${formatUptime(Math.floor((Date.now() - botState.startTime) / 1000))}`);
  else safeBotChat(trimmed);
});

// ============================================================
// DISCORD WEBHOOK
// ============================================================
function sendDiscordWebhook(content, color = 0x0099ff) {
  if (!config.discord?.enabled || !config.discord?.webhookUrl || config.discord.webhookUrl.includes("YOUR_DISCORD")) return;
  const now = Date.now();
  if (now - lastDiscordSend < DISCORD_RATE_LIMIT_MS) { addLog("[Discord] Rate limited"); return; }
  lastDiscordSend = now;
  const protocol = config.discord.webhookUrl.startsWith("https") ? https : http;
  const urlParts = new URL(config.discord.webhookUrl);
  const payload = JSON.stringify({
    username: config.name,
    embeds: [{ description: content, color, timestamp: new Date().toISOString(), footer: { text: "AFK Bot" } }],
  });
  const options = {
    hostname: urlParts.hostname, port: 443,
    path: urlParts.pathname + urlParts.search, method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload, "utf8") },
  };
  const req = protocol.request(options, () => {});
  req.on("error", (e) => addLog(`[Discord] Error: ${e.message}`));
  req.write(payload); req.end();
}

// ============================================================
// CRASH RECOVERY
// ============================================================
process.on("uncaughtException", (err) => {
  const msg = err?.message || String(err) || "Unknown";
  try { addLog(`[FATAL] Uncaught Exception: ${msg}`); } catch (_) { console.error("[FATAL]", msg); }
  try { botState.errors.push({ type: "uncaught", message: msg, time: Date.now() }); } catch (_) {}
  try { if (botState.errors.length > 100) botState.errors = botState.errors.slice(-50); } catch (_) {}
  const isNetworkError = ["PartialReadError","ECONNRESET","EPIPE","ETIMEDOUT","timed out","write after end","This socket has been ended"].some((k) => msg.includes(k));
  try { clearAllIntervals(); } catch (_) {}
  try { botState.connected = false; } catch (_) {}
  try {
    if (isReconnecting) { isReconnecting = false; if (reconnectTimeoutId) { clearTimeout(reconnectTimeoutId); reconnectTimeoutId = null; } }
  } catch (_) {}
  setTimeout(() => { try { scheduleReconnect(); } catch (e) { console.error("[FATAL] scheduleReconnect failed:", e.message); } }, isNetworkError ? 5000 : 10000);
});

process.on("unhandledRejection", (reason) => {
  const msg = String(reason);
  addLog(`[FATAL] Unhandled Rejection: ${msg}`);
  botState.errors.push({ type: "rejection", message: msg, time: Date.now() });
  if (botState.errors.length > 100) botState.errors = botState.errors.slice(-50);
  const isNetworkError = ["ETIMEDOUT","ECONNRESET","EPIPE","ENOTFOUND","timed out","PartialReadError"].some((k) => msg.includes(k));
  if (isNetworkError && !isReconnecting && typeof scheduleReconnect === "function") {
    addLog("[FATAL] Network rejection — triggering reconnect...");
    clearAllIntervals();
    botState.connected = false;
    if (bot) { try { bot.end(); } catch (_) {} bot = null; }
    scheduleReconnect();
  }
});

process.on("SIGTERM", () => addLog("[System] SIGTERM received — ignoring."));
process.on("SIGINT",  () => addLog("[System] SIGINT received — ignoring."));

// ============================================================
// START
// ============================================================
addLog("=".repeat(50));
addLog("  Minecraft AFK Bot v3.0 - Feature Edition");
addLog("=".repeat(50));
addLog(`Server: ${config.server.ip}:${config.server.port}`);
addLog(`Version: ${config.server.version || "auto-detect"}`);
addLog(`Auto-Reconnect: ${config.utils["auto-reconnect"] ? "Enabled" : "Disabled"}`);
addLog("=".repeat(50));

createBot();
