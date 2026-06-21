'use strict';

const http       = require('http');
const https      = require('https');
const mineflayer = require('mineflayer');

// ─── Config ───────────────────────────────────────────────────────────────────

const SERVERS = [
  { host: 'villain.falixsrv.me', port: 48424 },
  { host: 'villain.falixsrv.me', port: 20092 },
];

const FALIX_START_URL   = 'https://falixnodes.net/startserver?ip=villain.falixsrv.me';
const SERVER_BOOT_WAIT_MS = 30_000;

const USERNAME  = 'StayAliveBot';
const HTTP_PORT = parseInt(process.env.PORT || '3000', 10);

const ANTI_AFK_MS = 30_000;
const STATUS_MS   = 60_000;

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS  = 60_000;

// ─── State ────────────────────────────────────────────────────────────────────

let bot            = null;
let reconnectTimer = null;
let antiAfkTimer   = null;
let statusTimer    = null;

let failStreak   = 0;
let serverOnline = true;
let serverIndex  = 0;

function currentServer() { return SERVERS[serverIndex]; }
function nextServer()    { serverIndex = (serverIndex + 1) % SERVERS.length; }

const startTime = Date.now();

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

// ─── Backoff ──────────────────────────────────────────────────────────────────

function getReconnectDelay() {
  if (serverOnline) {
    return Math.min(RECONNECT_BASE_MS * Math.pow(2, Math.min(failStreak, 3)), 10_000);
  }
  return Math.min(RECONNECT_BASE_MS * Math.pow(2, Math.min(failStreak, 5)), RECONNECT_MAX_MS);
}

// ─── FalixNodes Wake-Up ───────────────────────────────────────────────────────

let waking = false;

function wakeServer() {
  if (waking) return;
  waking = true;
  log(`🚀 Sending wake-up request to FalixNodes...`);
  https.get(FALIX_START_URL, (res) => {
    log(`🚀 Wake-up response: HTTP ${res.statusCode} — waiting ${SERVER_BOOT_WAIT_MS / 1000}s for server to boot...`);
    res.resume();
  }).on('error', (err) => {
    log(`🚀 Wake-up request failed: ${err.message}`);
  }).on('close', () => {
    setTimeout(() => { waking = false; }, SERVER_BOOT_WAIT_MS);
  });
}

// ─── FalixNodes Verification Link ─────────────────────────────────────────────

function verifyFalix(url) {
  log(`🔐 Verifying FalixNodes link: ${url}`);
  const lib = url.startsWith('https') ? https : http;
  lib.get(url, (res) => {
    log(`🔐 Verification response: HTTP ${res.statusCode} ✅`);
    res.resume();
  }).on('error', (err) => {
    log(`🔐 Verification request failed: ${err.message}`);
  });
}

function checkMessageForVerification(text) {
  const match = text.match(/https?:\/\/[^\s"'<>]+/i);
  if (!match) return;
  const url = match[0];
  if (url.includes('falixnodes.net') || url.includes('falix.host') || url.includes('falix.gg')) {
    verifyFalix(url);
  }
}

// ─── Anti-AFK ─────────────────────────────────────────────────────────────────

function startAntiAfk() {
  stopAntiAfk();
  antiAfkTimer = setInterval(() => {
    if (!bot || !bot.entity) return;
    try {
      const r = Math.random();
      if (r < 0.2) {
        bot.setControlState('jump', true);
        setTimeout(() => bot && bot.setControlState('jump', false), 400);
      } else if (r < 0.4) {
        bot.setControlState('forward', true);
        setTimeout(() => bot && bot.setControlState('forward', false), 700);
      } else if (r < 0.6) {
        bot.setControlState('back', true);
        setTimeout(() => bot && bot.setControlState('back', false), 700);
      } else if (r < 0.8) {
        bot.setControlState('sneak', true);
        setTimeout(() => bot && bot.setControlState('sneak', false), 900);
      } else {
        bot.look(
          (Math.random() * Math.PI * 2) - Math.PI,
          (Math.random() - 0.5) * (Math.PI / 2),
          false
        );
      }
    } catch (_) {}
  }, ANTI_AFK_MS);
}

function stopAntiAfk() {
  if (antiAfkTimer) { clearInterval(antiAfkTimer); antiAfkTimer = null; }
}

// ─── Status Logger ────────────────────────────────────────────────────────────

function startStatusLogger() {
  stopStatusLogger();
  statusTimer = setInterval(() => {
    if (bot && bot.entity) {
      log(
        `💓 HP:${bot.health != null ? bot.health.toFixed(1) : '?'}/20 | ` +
        `Food:${bot.food ?? '?'} | ` +
        `Fails:${failStreak}`
      );
    }
  }, STATUS_MS);
}

function stopStatusLogger() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
}

// ─── Chat Commands ────────────────────────────────────────────────────────────

function handleCommand(username, raw) {
  if (!bot) return;
  const msg = raw.trim().toLowerCase();

  if (msg === '!status') {
    const delay = getReconnectDelay();
    bot.chat(
      `📊 HP:${bot.health != null ? bot.health.toFixed(1) : '?'} ` +
      `Food:${bot.food ?? '?'} ` +
      `Fails:${failStreak} NextRetry:${delay / 1000}s`
    );
  } else if (msg === '!help') {
    bot.chat('Commands: !status');
  }
}

// ─── Bot Creation ─────────────────────────────────────────────────────────────

function createBot() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  const { host, port } = currentServer();
  log(`Connecting to ${host}:${port} [server ${serverIndex + 1}/${SERVERS.length}] (streak: ${failStreak})...`);

  bot = mineflayer.createBot({
    host,
    port,
    username:             USERNAME,
    auth:                 'offline',
    keepAlive:            true,
    checkTimeoutInterval: 30_000,
    skipValidation:       true,
  });

  bot.once('spawn', () => {
    failStreak   = 0;
    serverOnline = true;
    log(`✅ Spawned! Anti-AFK active. Type !status in chat for info.`);
    startAntiAfk();
    startStatusLogger();
  });

  bot.on('respawn', () => {
    log('🔄 Respawned.');
    startAntiAfk();
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    log(`<${username}> ${message}`);
    handleCommand(username, message);
    checkMessageForVerification(message);
  });

  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString();
    if (!text) return;
    log(`[SERVER] ${text}`);
    checkMessageForVerification(text);
  });

  bot.on('kicked', (reason) => {
    let msg = reason;
    try { const p = JSON.parse(reason); msg = p.text || p.translate || reason; } catch (_) {}
    log(`⚠️  Kicked from ${currentServer().host}:${currentServer().port}: ${msg}`);
    serverOnline = true;
    failStreak++;
    nextServer();
    cleanup();
    scheduleReconnect();
  });

  bot.on('error', (err) => {
    const code = err.code || '';
    const { host, port } = currentServer();
    if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') {
      serverOnline = false;
      log(`🔴 ${host}:${port} offline (${code})`);
      wakeServer();
    } else {
      serverOnline = true;
      log(`❌ Error on ${host}:${port}: ${err.message}`);
    }
    failStreak++;
    nextServer();
    cleanup();
    scheduleReconnect();
  });

  bot.on('end', (reason) => {
    log(`🔌 Disconnected from ${currentServer().host}:${currentServer().port}: ${reason || 'unknown'}`);
    failStreak++;
    nextServer();
    cleanup();
    scheduleReconnect();
  });
}

// ─── Cleanup & Reconnect ──────────────────────────────────────────────────────

function cleanup() {
  stopAntiAfk();
  stopStatusLogger();
  if (bot) {
    try { bot.removeAllListeners(); } catch (_) {}
    bot = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = getReconnectDelay();
  log(`⏳ Reconnecting in ${delay / 1000}s (server ${serverOnline ? 'ONLINE' : 'OFFLINE'}, streak: ${failStreak})...`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; createBot(); }, delay);
}

process.on('uncaughtException', (err) => {
  log(`💥 Uncaught exception: ${err.message}`);
  cleanup();
  scheduleReconnect();
});

process.on('unhandledRejection', (reason) => {
  log(`⚠️  Unhandled rejection: ${reason}`);
});

// ─── HTTP Status Server ───────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const upSec  = Math.floor((Date.now() - startTime) / 1000);
  const pad    = n => String(n).padStart(2, '0');
  const uptime = `${pad(Math.floor(upSec / 3600))}:${pad(Math.floor((upSec % 3600) / 60))}:${pad(upSec % 60)}`;

  const { host, port } = currentServer();
  const body = JSON.stringify({
    status:     bot && bot.entity ? 'ONLINE' : (serverOnline ? 'RECONNECTING' : 'SERVER_DOWN'),
    server:     `${host}:${port}`,
    trying:     `${serverIndex + 1}/${SERVERS.length}`,
    allServers: SERVERS.map(s => `${s.host}:${s.port}`),
    username:   USERNAME,
    health:     bot && bot.health != null ? bot.health.toFixed(1) : '?',
    food:       bot && bot.food   != null ? String(bot.food)      : '?',
    failStreak,
    nextRetry:  reconnectTimer ? `${getReconnectDelay() / 1000}s` : 'connected',
    uptime,
  }, null, 2);

  res.writeHead(200, {
    'Content-Type':   'application/json',
    'Cache-Control':  'no-cache',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
});

server.on('error', (err) => log(`🌐 HTTP server error: ${err.message}`));
server.listen(HTTP_PORT, '0.0.0.0', () => log(`🌐 Status server on 0.0.0.0:${HTTP_PORT}`));

// ─── Start ────────────────────────────────────────────────────────────────────

createBot();
