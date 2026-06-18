const mineflayer = require('mineflayer');

const HOST = 'villain.falixsrv.me';
const PORT = 48424;
const USERNAME = 'StayAliveBot';
const VERSION = false; // auto-detect

let bot = null;
let reconnectTimer = null;
let antiAfkTimer = null;
const RECONNECT_DELAY_MS = 5000;
const ANTI_AFK_INTERVAL_MS = 30000; // move every 30 seconds

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function startAntiAfk() {
  stopAntiAfk();
  antiAfkTimer = setInterval(() => {
    if (!bot || !bot.entity) return;

    const action = Math.floor(Math.random() * 5);

    try {
      if (action === 0) {
        // Jump
        bot.setControlState('jump', true);
        setTimeout(() => { if (bot) bot.setControlState('jump', false); }, 500);
        log('Anti-AFK: jumped');

      } else if (action === 1) {
        // Sneak briefly
        bot.setControlState('sneak', true);
        setTimeout(() => { if (bot) bot.setControlState('sneak', false); }, 1000);
        log('Anti-AFK: sneaked');

      } else if (action === 2) {
        // Walk forward then stop
        bot.setControlState('forward', true);
        setTimeout(() => { if (bot) bot.setControlState('forward', false); }, 800);
        log('Anti-AFK: walked forward');

      } else if (action === 3) {
        // Walk back then stop
        bot.setControlState('back', true);
        setTimeout(() => { if (bot) bot.setControlState('back', false); }, 800);
        log('Anti-AFK: walked back');

      } else {
        // Look in a random direction
        const yaw = (Math.random() * Math.PI * 2) - Math.PI;
        const pitch = (Math.random() * Math.PI / 2) - Math.PI / 4;
        bot.look(yaw, pitch, false);
        log('Anti-AFK: looked around');
      }
    } catch (err) {
      log('Anti-AFK error (ignored): ' + err.message);
    }
  }, ANTI_AFK_INTERVAL_MS);
}

function stopAntiAfk() {
  if (antiAfkTimer) {
    clearInterval(antiAfkTimer);
    antiAfkTimer = null;
  }
}

function createBot() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

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

  bot.once('spawn', () => {
    log('Bot spawned in the world. Anti-AFK active.');
    startAntiAfk();
  });

  bot.on('respawn', () => {
    log('Bot respawned.');
    startAntiAfk();
  });

  bot.on('kicked', (reason) => {
    let msg = reason;
    try { msg = JSON.parse(reason).text || reason; } catch (_) {}
    log(`Kicked: ${msg}. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    stopAntiAfk();
    scheduleReconnect();
  });

  bot.on('error', (err) => {
    log(`Error: ${err.message}. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    stopAntiAfk();
    scheduleReconnect();
  });

  bot.on('end', (reason) => {
    log(`Disconnected (${reason || 'unknown'}). Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    stopAntiAfk();
    scheduleReconnect();
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    log(`<${username}> ${message}`);
  });

  // Log status every 60s
  setInterval(() => {
    if (bot && bot.entity) {
      log(`Status — Health: ${bot.health ? bot.health.toFixed(1) : '?'} | Food: ${bot.food ?? '?'} | Pos: ${bot.entity.position}`);
    }
  }, 60000);
}

function scheduleReconnect() {
  if (bot) {
    try { bot.removeAllListeners(); } catch (_) {}
    bot = null;
  }
  if (!reconnectTimer) {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      createBot();
    }, RECONNECT_DELAY_MS);
  }
}

process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message}. Reconnecting...`);
  stopAntiAfk();
  scheduleReconnect();
});

process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason}. Reconnecting...`);
  stopAntiAfk();
  scheduleReconnect();
});

createBot();
