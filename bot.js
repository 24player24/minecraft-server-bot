const mineflayer = require('mineflayer');

const HOST = 'villain.falixsrv.me';
const PORT = 20092;
const USERNAME = 'StayAliveBot';
const VERSION = false; // auto-detect

let bot = null;
let reconnectTimer = null;
const RECONNECT_DELAY_MS = 5000;

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
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
    log('Bot spawned in the world. Running 24/7.');
    keepAlive();
  });

  bot.on('kicked', (reason) => {
    log(`Kicked: ${reason}. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    scheduleReconnect();
  });

  bot.on('error', (err) => {
    log(`Error: ${err.message}. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    scheduleReconnect();
  });

  bot.on('end', (reason) => {
    log(`Disconnected (${reason || 'unknown reason'}). Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    scheduleReconnect();
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    log(`<${username}> ${message}`);
  });
}

function keepAlive() {
  setInterval(() => {
    if (bot && bot.entity) {
      log('Bot is alive. Health: ' + (bot.health ? bot.health.toFixed(1) : '?') + ' Food: ' + (bot.food ? bot.food : '?'));
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
  scheduleReconnect();
});

process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason}. Reconnecting...`);
  scheduleReconnect();
});

createBot();
