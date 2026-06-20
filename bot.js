'use strict';

const http       = require('http');
const mineflayer = require('mineflayer');

// ─── Config ───────────────────────────────────────────────────────────────────

const MC_HOST   = 'villain.falixsrv.me';
const MC_PORT   = 48424;
const USERNAME  = 'StayAliveBot';
const HTTP_PORT = parseInt(process.env.PORT || '3000', 10);

const ANTI_AFK_MS    = 30_000;
const PVP_SCAN_MS    = 2_000;
const COMBAT_TICK_MS = 250;
const STATUS_MS      = 60_000;
const PVP_RANGE      = 16;
const ATTACK_RANGE   = 3.5;

// Reconnect backoff: 2s, 4s, 8s, 16s, 32s, 60s (cap)
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS  = 60_000;

// ─── State ────────────────────────────────────────────────────────────────────

let bot            = null;
let reconnectTimer = null;
let antiAfkTimer   = null;
let pvpScanTimer   = null;
let combatTimer    = null;
let statusTimer    = null;

let pvpMode       = 'defend'; // 'off' | 'defend' | 'attack'
let currentTarget = null;

// Reconnect backoff tracking
let failStreak    = 0;   // consecutive failed connection attempts
let serverOnline  = true; // optimistic — flipped by ECONNREFUSED/timeout

const startTime = Date.now();

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

// ─── Backoff ──────────────────────────────────────────────────────────────────

function getReconnectDelay() {
  // Fast retry when server is known online (quick kick recovery)
  // Slow retry when server appears offline (FalixNodes auto-stop)
  if (serverOnline) {
    return Math.min(RECONNECT_BASE_MS * Math.pow(2, Math.min(failStreak, 3)), 10_000);
  }
  return Math.min(RECONNECT_BASE_MS * Math.pow(2, Math.min(failStreak, 5)), RECONNECT_MAX_MS);
}

// ─── Anti-AFK ─────────────────────────────────────────────────────────────────

function startAntiAfk() {
  stopAntiAfk();
  antiAfkTimer = setInterval(() => {
    if (!bot || !bot.entity || currentTarget) return;
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
        `PvP:${pvpMode.toUpperCase()} | ` +
        `Target:${currentTarget ? (currentTarget.username || currentTarget.type) : 'none'} | ` +
        `Fails:${failStreak}`
      );
    }
  }, STATUS_MS);
}

function stopStatusLogger() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
}

// ─── Lightweight PvP ──────────────────────────────────────────────────────────

function getNearestPlayer() {
  if (!bot || !bot.entity) return null;
  let nearest = null;
  let nearestDist = PVP_RANGE;
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (e.type !== 'player' || e.username === bot.username) continue;
    const d = bot.entity.position.distanceTo(e.position);
    if (d < nearestDist) { nearest = e; nearestDist = d; }
  }
  return nearest;
}

function startCombat(entity) {
  if (!bot || !entity) return;
  stopCombat(true);
  currentTarget = entity;
  log(`⚔️  Attacking ${entity.username || entity.type}`);

  combatTimer = setInterval(() => {
    if (!bot || !bot.entity) { stopCombat(true); return; }
    const target = currentTarget && bot.entities[currentTarget.id];
    if (!target) { log('Target gone.'); stopCombat(true); return; }

    const dist = bot.entity.position.distanceTo(target.position);
    if (dist > PVP_RANGE + 4) { log(`Target out of range.`); stopCombat(true); return; }

    try {
      bot.lookAt(target.position.offset(0, target.height * 0.9, 0), true);
      if (dist > ATTACK_RANGE) {
        bot.setControlState('sprint', true);
        bot.setControlState('forward', true);
        if (bot.entity.onGround && Math.random() < 0.3) {
          bot.setControlState('jump', true);
          setTimeout(() => bot && bot.setControlState('jump', false), 150);
        }
      } else {
        bot.setControlState('forward', false);
        bot.setControlState('sprint', false);
        if (bot.entity.onGround) {
          bot.setControlState('jump', true);
          setTimeout(() => {
            if (!bot) return;
            bot.setControlState('jump', false);
            try { bot.attack(target); } catch (_) {}
          }, 100);
        } else {
          bot.attack(target);
        }
      }
    } catch (_) {}
  }, COMBAT_TICK_MS);
}

function stopCombat(silent = false) {
  if (combatTimer) { clearInterval(combatTimer); combatTimer = null; }
  currentTarget = null;
  if (bot) {
    try {
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);
      bot.setControlState('jump', false);
    } catch (_) {}
  }
  if (!silent) log('⛔ Stopped attacking.');
}

function startPvpScan() {
  stopPvpScan();
  pvpScanTimer = setInterval(() => {
    if (!bot || !bot.entity || pvpMode === 'off' || currentTarget) return;
    if (pvpMode === 'attack') {
      const nearest = getNearestPlayer();
      if (nearest) startCombat(nearest);
    }
  }, PVP_SCAN_MS);
}

function stopPvpScan() {
  if (pvpScanTimer) { clearInterval(pvpScanTimer); pvpScanTimer = null; }
}

// ─── Chat Commands ────────────────────────────────────────────────────────────

function handleCommand(username, raw) {
  if (!bot) return;
  const msg = raw.trim().toLowerCase();

  if (msg === '!pvp attack') {
    pvpMode = 'attack';
    bot.chat('⚔️ PvP: ATTACK');

  } else if (msg === '!pvp defend') {
    pvpMode = 'defend'; stopCombat();
    bot.chat('🛡️ PvP: DEFEND');

  } else if (msg === '!pvp off') {
    pvpMode = 'off'; stopCombat();
    bot.chat('❌ PvP: OFF');

  } else if (msg.startsWith('!kill ')) {
    const name = raw.trim().slice(6).trim().toLowerCase();
    let found = null;
    for (const id in bot.entities) {
      const e = bot.entities[id];
      if (e.type === 'player' && e.username && e.username.toLowerCase() === name) { found = e; break; }
    }
    found ? (startCombat(found), bot.chat(`⚔️ Targeting ${found.username}!`))
           : bot.chat(`❌ "${raw.trim().slice(6).trim()}" not found.`);

  } else if (msg === '!stop') {
    stopCombat();

  } else if (msg === '!status') {
    const delay = getReconnectDelay();
    bot.chat(
      `📊 HP:${bot.health != null ? bot.health.toFixed(1) : '?'} ` +
      `Food:${bot.food ?? '?'} PvP:${pvpMode.toUpperCase()} ` +
      `Fails:${failStreak} NextRetry:${delay / 1000}s`
    );

  } else if (msg === '!help') {
    bot.chat('!pvp attack/defend/off | !kill <name> | !stop | !status');
  }
}

// ─── Bot Creation ─────────────────────────────────────────────────────────────

function createBot() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  log(`Connecting to ${MC_HOST}:${MC_PORT} (attempt, streak: ${failStreak})...`);

  bot = mineflayer.createBot({
    host:                 MC_HOST,
    port:                 MC_PORT,
    username:             USERNAME,
    auth:                 'offline',
    keepAlive:            true,
    checkTimeoutInterval: 30_000,
    skipValidation:       true,
  });

  // ── Successful connection ───────────────────────────────────────────────────

  bot.once('spawn', () => {
    failStreak   = 0;     // reset on successful spawn
    serverOnline = true;
    log(`✅ Spawned! PvP:${pvpMode.toUpperCase()} Range:${PVP_RANGE}m | !help`);
    startAntiAfk();
    startPvpScan();
    startStatusLogger();
  });

  bot.on('respawn', () => {
    log('🔄 Respawned.');
    stopCombat(true);
    startAntiAfk();
    startPvpScan();
  });

  // ── PvP events ─────────────────────────────────────────────────────────────

  bot.on('entityHurt', (entity) => {
    if (!bot || !bot.entity) return;
    if (entity.id !== bot.entity.id || pvpMode === 'off' || currentTarget) return;
    const attacker = getNearestPlayer();
    if (attacker) {
      log(`🛡️ Hit! Counter-attacking ${attacker.username || attacker.type}`);
      startCombat(attacker);
    }
  });

  bot.on('entitySpawn', (entity) => {
    if (!bot || !bot.entity) return;
    if (entity.type !== 'player' || entity.username === bot.username) return;
    if (pvpMode !== 'attack' || currentTarget) return;
    const dist = bot.entity.position.distanceTo(entity.position);
    if (dist <= PVP_RANGE) {
      log(`👀 ${entity.username} in range (${dist.toFixed(1)}m) — attacking`);
      startCombat(entity);
    }
  });

  // ── Chat ────────────────────────────────────────────────────────────────────

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    log(`<${username}> ${message}`);
    handleCommand(username, message);
  });

  // ── Disconnection events ────────────────────────────────────────────────────

  bot.on('kicked', (reason) => {
    let msg = reason;
    try { const p = JSON.parse(reason); msg = p.text || p.translate || reason; } catch (_) {}
    log(`⚠️  Kicked: ${msg}`);
    // Kick = server was online and active — fast reconnect
    serverOnline = true;
    failStreak++;
    cleanup();
    scheduleReconnect();
  });

  bot.on('error', (err) => {
    const code = err.code || '';
    // ECONNREFUSED / ETIMEDOUT / ENOTFOUND = server is DOWN (FalixNodes stopped it)
    if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') {
      serverOnline = false;
      log(`🔴 Server offline (${code}) — backing off...`);
    } else {
      serverOnline = true;
      log(`❌ Error: ${err.message}`);
    }
    failStreak++;
    cleanup();
    scheduleReconnect();
  });

  bot.on('end', (reason) => {
    log(`🔌 Disconnected: ${reason || 'unknown'}`);
    failStreak++;
    cleanup();
    scheduleReconnect();
  });
}

// ─── Cleanup & Reconnect ──────────────────────────────────────────────────────

function cleanup() {
  stopAntiAfk();
  stopCombat(true);
  stopPvpScan();
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

http.createServer((req, res) => {
  const upSec  = Math.floor((Date.now() - startTime) / 1000);
  const pad    = n => String(n).padStart(2, '0');
  const uptime = `${pad(Math.floor(upSec / 3600))}:${pad(Math.floor((upSec % 3600) / 60))}:${pad(upSec % 60)}`;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status:       bot && bot.entity ? 'ONLINE' : (serverOnline ? 'RECONNECTING' : 'SERVER_DOWN'),
    server:       `${MC_HOST}:${MC_PORT}`,
    username:     USERNAME,
    pvpMode,
    health:       bot && bot.health != null ? bot.health.toFixed(1) : '?',
    food:         bot && bot.food   != null ? String(bot.food)      : '?',
    target:       currentTarget ? (currentTarget.username || currentTarget.type) : 'none',
    failStreak,
    nextRetry:    reconnectTimer ? `${getReconnectDelay() / 1000}s` : 'connected',
    uptime,
  }, null, 2));
}).listen(HTTP_PORT, () => log(`🌐 Status server on :${HTTP_PORT}`));

// ─── Start ────────────────────────────────────────────────────────────────────

createBot();
