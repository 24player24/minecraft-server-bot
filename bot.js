const http = require('http');
const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;

const HOST = 'villain.falixsrv.me';
const MC_PORT = 48424;
const USERNAME = 'StayAliveBot';
const HTTP_PORT = process.env.PORT || 3000; // Render injects PORT

let bot = null;
let reconnectTimer = null;
let antiAfkTimer = null;
let pvpScanTimer = null;
let statusTimer = null; // FIX: module-level so it can be cleared on cleanup

const RECONNECT_DELAY_MS = 5000;
const ANTI_AFK_INTERVAL_MS = 30000;
const PVP_SCAN_INTERVAL_MS = 2000;
const PVP_RANGE = 16;

let pvpMode = 'defend'; // 'off' | 'defend' | 'attack'
let currentTarget = null;

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─── Anti-AFK ─────────────────────────────────────────────────────────────────

function startAntiAfk() {
  stopAntiAfk();
  antiAfkTimer = setInterval(() => {
    if (!bot || !bot.entity || currentTarget) return;
    const action = Math.floor(Math.random() * 5);
    try {
      if (action === 0) {
        bot.setControlState('jump', true);
        setTimeout(() => { if (bot) bot.setControlState('jump', false); }, 500);
      } else if (action === 1) {
        bot.setControlState('sneak', true);
        setTimeout(() => { if (bot) bot.setControlState('sneak', false); }, 1000);
      } else if (action === 2) {
        bot.setControlState('forward', true);
        setTimeout(() => { if (bot) bot.setControlState('forward', false); }, 800);
      } else if (action === 3) {
        bot.setControlState('back', true);
        setTimeout(() => { if (bot) bot.setControlState('back', false); }, 800);
      } else {
        const yaw = (Math.random() * Math.PI * 2) - Math.PI;
        const pitch = (Math.random() * Math.PI / 2) - Math.PI / 4;
        bot.look(yaw, pitch, false);
      }
    } catch (_) {}
  }, ANTI_AFK_INTERVAL_MS);
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
        `💓 Health: ${bot.health != null ? bot.health.toFixed(1) : '?'}/20 | ` +
        `Food: ${bot.food ?? '?'} | ` +
        `PvP: ${pvpMode.toUpperCase()} | ` +
        `Target: ${currentTarget ? (currentTarget.username || currentTarget.type) : 'none'}`
      );
    }
  }, 60000);
}

function stopStatusLogger() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
}

// ─── PvP ──────────────────────────────────────────────────────────────────────

function getNearestPlayer() {
  if (!bot || !bot.entity) return null;
  let nearest = null;
  let nearestDist = PVP_RANGE;
  for (const entity of Object.values(bot.entities)) {
    if (entity.type !== 'player') continue;
    if (entity.username === bot.username) continue;
    const dist = bot.entity.position.distanceTo(entity.position);
    if (dist < nearestDist) { nearest = entity; nearestDist = dist; }
  }
  return nearest;
}

function attackTarget(entity) {
  if (!bot || !entity) return;
  currentTarget = entity;
  log(`⚔️  Attacking ${entity.username || entity.name || entity.type}`);
  try {
    bot.pvp.attack(entity);
  } catch (err) {
    log(`PvP attack error: ${err.message}`);
    currentTarget = null;
  }
}

function stopAttacking(silent = false) {
  if (!bot) { currentTarget = null; return; }
  currentTarget = null;
  try { bot.pvp.stop(); } catch (_) {}
  try { bot.pathfinder.stop(); } catch (_) {}
  if (!silent) log('⛔ Stopped attacking.');
}

function startPvpScan() {
  stopPvpScan();
  pvpScanTimer = setInterval(() => {
    if (!bot || !bot.entity) return;

    if (pvpMode === 'off') {
      if (currentTarget) stopAttacking(true);
      return;
    }

    if (currentTarget) {
      // FIX: entity.id check — reference equality can fail across reconnects
      const stillValid =
        currentTarget.id != null &&
        bot.entities[currentTarget.id] &&
        bot.entity.position.distanceTo(currentTarget.position) < PVP_RANGE + 8;
      if (!stillValid) {
        log(`Target ${currentTarget.username || currentTarget.type} lost.`);
        stopAttacking(true);
      }
      return;
    }

    if (pvpMode === 'attack') {
      const nearest = getNearestPlayer();
      if (nearest) attackTarget(nearest);
    }
  }, PVP_SCAN_INTERVAL_MS);
}

function stopPvpScan() {
  if (pvpScanTimer) { clearInterval(pvpScanTimer); pvpScanTimer = null; }
}

// ─── Chat Commands ────────────────────────────────────────────────────────────

function handleCommand(username, message) {
  const msg = message.trim().toLowerCase();

  if (msg === '!pvp attack') {
    pvpMode = 'attack';
    log(`PvP mode → ATTACK (by ${username})`);
    bot.chat('⚔️ PvP: ATTACK — hunting all nearby players.');

  } else if (msg === '!pvp defend') {
    pvpMode = 'defend';
    stopAttacking(true);
    log(`PvP mode → DEFEND (by ${username})`);
    bot.chat('🛡️ PvP: DEFEND — fighting back only if attacked.');

  } else if (msg === '!pvp off') {
    pvpMode = 'off';
    stopAttacking(true);
    log(`PvP mode → OFF (by ${username})`);
    bot.chat('❌ PvP: OFF — not fighting anyone.');

  } else if (msg.startsWith('!kill ')) {
    const targetName = message.trim().slice(6).trim();
    const target = Object.values(bot.entities).find(
      e => e.type === 'player' && e.username &&
           e.username.toLowerCase() === targetName.toLowerCase()
    );
    if (target) {
      attackTarget(target);
      bot.chat(`⚔️ Targeting ${target.username}!`);
    } else {
      bot.chat(`❌ Player "${targetName}" not found nearby.`);
    }

  } else if (msg === '!stop') {
    stopAttacking();

  } else if (msg === '!status') {
    bot.chat(
      `📊 HP: ${bot.health != null ? bot.health.toFixed(1) : '?'}/20 | ` +
      `Food: ${bot.food ?? '?'} | ` +
      `PvP: ${pvpMode.toUpperCase()} | ` +
      `Target: ${currentTarget ? (currentTarget.username || currentTarget.type) : 'none'}`
    );

  } else if (msg === '!help') {
    bot.chat('Commands: !pvp attack | !pvp defend | !pvp off | !kill <name> | !stop | !status');
  }
}

// ─── Bot Creation ─────────────────────────────────────────────────────────────

function createBot() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  log(`Connecting to ${HOST}:${MC_PORT} as ${USERNAME}...`);

  bot = mineflayer.createBot({
    host: HOST,
    port: MC_PORT,
    username: USERNAME,
    // FIX: removed VERSION=false — mineflayer rejects it; omit to auto-detect
    auth: 'offline',
    keepAlive: true,
    checkTimeoutInterval: 30000,
  });

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvp);

  bot.once('spawn', () => {
    log('✅ Spawned. Anti-AFK + PvP active.');
    log(`Mode: ${pvpMode.toUpperCase()} | Range: ${PVP_RANGE} blocks | !help for commands`);

    try {
      const movements = new Movements(bot);
      movements.allowSprinting = true;
      bot.pathfinder.setMovements(movements);
    } catch (err) {
      log(`Pathfinder setup error: ${err.message}`);
    }

    startAntiAfk();
    startPvpScan();
    startStatusLogger();
  });

  bot.on('respawn', () => {
    log('🔄 Respawned.');
    currentTarget = null;
    try { bot.pvp.stop(); } catch (_) {}
    startAntiAfk();
    startPvpScan();
  });

  // FIX: compare entity.id instead of reference to avoid false negatives
  bot.on('entityHurt', (entity) => {
    if (!bot || !bot.entity) return;
    if (entity.id !== bot.entity.id) return;
    if (pvpMode === 'off') return;
    if (currentTarget) return; // already fighting
    const attacker = getNearestPlayer();
    if (attacker) {
      log(`🛡️ Hit! Defending against ${attacker.username || attacker.type}`);
      attackTarget(attacker);
    }
  });

  bot.on('entitySpawn', (entity) => {
    if (!bot || !bot.entity) return;
    if (entity.type !== 'player' || entity.username === bot.username) return;
    const dist = bot.entity.position.distanceTo(entity.position);
    if (dist <= PVP_RANGE) {
      log(`👀 ${entity.username} appeared nearby (${dist.toFixed(1)} blocks)`);
      if (pvpMode === 'attack' && !currentTarget) attackTarget(entity);
    }
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    log(`<${username}> ${message}`);
    handleCommand(username, message);
  });

  bot.on('kicked', (reason) => {
    let msg = reason;
    try { msg = JSON.parse(reason).text || reason; } catch (_) {}
    log(`Kicked: ${msg}`);
    cleanup();
    scheduleReconnect();
  });

  bot.on('error', (err) => {
    log(`Error: ${err.message}`);
    cleanup();
    scheduleReconnect();
  });

  bot.on('end', (reason) => {
    log(`Disconnected: ${reason || 'unknown'}`);
    cleanup();
    scheduleReconnect();
  });
}

// ─── Cleanup & Reconnect ──────────────────────────────────────────────────────

function cleanup() {
  stopAntiAfk();
  stopPvpScan();
  stopStatusLogger();
  currentTarget = null;
  if (bot) {
    // FIX: stop pvp/pathfinder BEFORE removing listeners
    try { bot.pvp.stop(); } catch (_) {}
    try { bot.pathfinder.stop(); } catch (_) {}
    try { bot.removeAllListeners(); } catch (_) {}
    bot = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return; // already scheduled
  log(`Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createBot();
  }, RECONNECT_DELAY_MS);
}

// FIX: only reconnect on uncaughtException (true crashes), not all rejections
process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message}`);
  cleanup();
  scheduleReconnect();
});

// FIX: log unhandled rejections but don't blindly reconnect — they may be unrelated
process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason}`);
});

// ─── HTTP Status Server ───────────────────────────────────────────────────────
// Required so Render keeps the process alive and UptimeRobot gets a 200 OK.

const startTime = Date.now();

http.createServer((req, res) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const hh = String(Math.floor(uptime / 3600)).padStart(2, '0');
  const mm = String(Math.floor((uptime % 3600) / 60)).padStart(2, '0');
  const ss = String(uptime % 60).padStart(2, '0');

  const connected = bot && bot.entity ? 'ONLINE' : 'RECONNECTING';
  const health    = bot && bot.health  != null ? bot.health.toFixed(1) : '?';
  const food      = bot && bot.food    != null ? String(bot.food)      : '?';
  const target    = currentTarget
    ? (currentTarget.username || currentTarget.type)
    : 'none';

  const body = JSON.stringify({
    status:   connected,
    server:   `${HOST}:${MC_PORT}`,
    username: USERNAME,
    pvpMode,
    health,
    food,
    target,
    uptime:   `${hh}:${mm}:${ss}`,
  }, null, 2);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}).listen(HTTP_PORT, () => {
  log(`🌐 Status server listening on port ${HTTP_PORT} (for Render + UptimeRobot)`);
});

createBot();
