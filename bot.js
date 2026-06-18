const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const { GoalFollow } = require('mineflayer-pathfinder').goals;
const pvp = require('mineflayer-pvp').plugin;

const HOST = 'villain.falixsrv.me';
const PORT = 48424;
const USERNAME = 'StayAliveBot';
const VERSION = false; // auto-detect

let bot = null;
let reconnectTimer = null;
let antiAfkTimer = null;
let pvpScanTimer = null;

const RECONNECT_DELAY_MS = 5000;
const ANTI_AFK_INTERVAL_MS = 30000;
const PVP_SCAN_INTERVAL_MS = 2000;
const PVP_RANGE = 16; // blocks

// PvP state
let pvpMode = 'defend'; // 'off' | 'defend' | 'attack'
let currentTarget = null;

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// ─── Anti-AFK ─────────────────────────────────────────────────────────────────

function startAntiAfk() {
  stopAntiAfk();
  antiAfkTimer = setInterval(() => {
    if (!bot || !bot.entity || currentTarget) return; // skip if fighting
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
    } catch (err) {
      // ignore
    }
  }, ANTI_AFK_INTERVAL_MS);
}

function stopAntiAfk() {
  if (antiAfkTimer) { clearInterval(antiAfkTimer); antiAfkTimer = null; }
}

// ─── PvP Logic ────────────────────────────────────────────────────────────────

function getNearestPlayer() {
  if (!bot || !bot.entity) return null;
  let nearest = null;
  let nearestDist = PVP_RANGE;
  for (const entity of Object.values(bot.entities)) {
    if (entity.type !== 'player') continue;
    if (entity.username === bot.username) continue;
    const dist = bot.entity.position.distanceTo(entity.position);
    if (dist < nearestDist) {
      nearest = entity;
      nearestDist = dist;
    }
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
    log('PvP attack error: ' + err.message);
  }
}

function stopAttacking() {
  if (!bot) return;
  currentTarget = null;
  try { bot.pvp.stop(); } catch (_) {}
  try { bot.pathfinder.stop(); } catch (_) {}
  log('⚔️  Stopped attacking.');
}

function startPvpScan() {
  stopPvpScan();
  pvpScanTimer = setInterval(() => {
    if (!bot || !bot.entity) return;

    if (pvpMode === 'off') {
      if (currentTarget) stopAttacking();
      return;
    }

    // If we have a target, check if they're still valid/in range
    if (currentTarget) {
      const stillValid =
        bot.entities[currentTarget.id] &&
        bot.entity.position.distanceTo(currentTarget.position) < PVP_RANGE + 8;
      if (!stillValid) {
        log(`Target ${currentTarget.username || currentTarget.type} out of range or gone.`);
        stopAttacking();
      }
      return;
    }

    // Scan for a new target
    if (pvpMode === 'attack') {
      const nearest = getNearestPlayer();
      if (nearest) attackTarget(nearest);
    }
  }, PVP_SCAN_INTERVAL_MS);
}

function stopPvpScan() {
  if (pvpScanTimer) { clearInterval(pvpScanTimer); pvpScanTimer = null; }
}

// ─── Chat Commands ─────────────────────────────────────────────────────────────
// !pvp attack       — hunt & kill all nearby players
// !pvp defend       — only attack when hit (default)
// !pvp off          — stop all PvP
// !kill <player>    — attack a specific player
// !stop             — stop current attack
// !status           — show bot info

function handleCommand(username, message) {
  const msg = message.trim().toLowerCase();

  if (msg === '!pvp attack') {
    pvpMode = 'attack';
    log(`PvP mode set to ATTACK by ${username}`);
    bot.chat('⚔️ PvP mode: ATTACK — hunting all nearby players.');

  } else if (msg === '!pvp defend') {
    pvpMode = 'defend';
    stopAttacking();
    log(`PvP mode set to DEFEND by ${username}`);
    bot.chat('🛡️ PvP mode: DEFEND — will only fight back if attacked.');

  } else if (msg === '!pvp off') {
    pvpMode = 'off';
    stopAttacking();
    log(`PvP disabled by ${username}`);
    bot.chat('❌ PvP mode: OFF — not fighting anyone.');

  } else if (msg.startsWith('!kill ')) {
    const targetName = message.trim().slice(6).trim();
    const target = Object.values(bot.entities).find(
      e => e.type === 'player' && e.username && e.username.toLowerCase() === targetName.toLowerCase()
    );
    if (target) {
      attackTarget(target);
      bot.chat(`⚔️ Attacking ${target.username}!`);
    } else {
      bot.chat(`❌ Player "${targetName}" not found nearby.`);
    }

  } else if (msg === '!stop') {
    stopAttacking();
    bot.chat('⛔ Stopped attacking.');

  } else if (msg === '!status') {
    const pos = bot.entity ? bot.entity.position : null;
    bot.chat(
      `📊 Health: ${bot.health ? bot.health.toFixed(1) : '?'}/20 | ` +
      `Food: ${bot.food ?? '?'} | ` +
      `PvP: ${pvpMode.toUpperCase()} | ` +
      `Target: ${currentTarget ? (currentTarget.username || currentTarget.type) : 'none'}`
    );
  }
}

// ─── Bot Creation ─────────────────────────────────────────────────────────────

function createBot() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  log(`Connecting to ${HOST}:${PORT} as ${USERNAME}...`);

  bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    version: VERSION,
    auth: 'offline',
    keepAlive: true,
    checkTimeoutInterval: 30000,
  });

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvp);

  bot.once('spawn', () => {
    log('✅ Bot spawned. Anti-AFK + PvP active.');
    log(`PvP mode: ${pvpMode.toUpperCase()} | Range: ${PVP_RANGE} blocks`);
    log('Commands: !pvp attack | !pvp defend | !pvp off | !kill <player> | !stop | !status');

    const defaultMove = new Movements(bot);
    bot.pathfinder.setMovements(defaultMove);

    startAntiAfk();
    startPvpScan();
  });

  bot.on('respawn', () => {
    log('🔄 Bot respawned.');
    currentTarget = null;
    startAntiAfk();
    startPvpScan();
  });

  // Self-defense: attack back when hit
  bot.on('entityHurt', (entity) => {
    if (!bot || !bot.entity) return;
    if (entity !== bot.entity) return; // only care about bot being hurt
    if (pvpMode === 'off') return;

    const attacker = getNearestPlayer();
    if (attacker && !currentTarget) {
      log(`🛡️ Hit! Defending against ${attacker.username || attacker.type}`);
      attackTarget(attacker);
    }
  });

  // Notify when a player gets close
  bot.on('entitySpawn', (entity) => {
    if (entity.type === 'player' && entity.username !== bot.username) {
      const dist = bot.entity ? bot.entity.position.distanceTo(entity.position) : 999;
      if (dist <= PVP_RANGE) {
        log(`👀 Player ${entity.username} appeared nearby (${dist.toFixed(1)} blocks)`);
        if (pvpMode === 'attack' && !currentTarget) {
          attackTarget(entity);
        }
      }
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
    log(`Kicked: ${msg}. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    cleanup();
    scheduleReconnect();
  });

  bot.on('error', (err) => {
    log(`Error: ${err.message}. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    cleanup();
    scheduleReconnect();
  });

  bot.on('end', (reason) => {
    log(`Disconnected (${reason || 'unknown'}). Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    cleanup();
    scheduleReconnect();
  });

  // Status log every 60s
  setInterval(() => {
    if (bot && bot.entity) {
      log(
        `💓 Health: ${bot.health ? bot.health.toFixed(1) : '?'} | ` +
        `Food: ${bot.food ?? '?'} | ` +
        `PvP: ${pvpMode} | ` +
        `Target: ${currentTarget ? (currentTarget.username || currentTarget.type) : 'none'}`
      );
    }
  }, 60000);
}

function cleanup() {
  stopAntiAfk();
  stopPvpScan();
  currentTarget = null;
  if (bot) { try { bot.removeAllListeners(); } catch (_) {} bot = null; }
}

function scheduleReconnect() {
  if (!reconnectTimer) {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      createBot();
    }, RECONNECT_DELAY_MS);
  }
}

process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message}. Reconnecting...`);
  cleanup();
  scheduleReconnect();
});

process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason}. Reconnecting...`);
  cleanup();
  scheduleReconnect();
});

createBot();
