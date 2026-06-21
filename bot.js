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

// Follow up to 5 redirects and return final response + body
function fetchFollow(url, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return resolve(fetchFollow(next, options, redirects + 1));
      }
      const cookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, cookies, finalUrl: url }));
    });
    req.on('error', reject);
  });
}

function httpPost(url, body, cookies) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = url.startsWith('https') ? https : http;
    const buf = Buffer.from(body, 'utf8');
    const req = lib.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': buf.length,
        'Cookie':         cookies,
        'User-Agent':     'Mozilla/5.0',
        'Referer':        url,
      },
    }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

function parseForm(html, baseUrl) {
  // Extract form action
  const formMatch = html.match(/<form[^>]+>/i);
  if (!formMatch) return null;
  const formTag = formMatch[0];
  const actionMatch = formTag.match(/action="([^"]*)"/i);
  let action = actionMatch ? actionMatch[1] : baseUrl;
  // Make absolute
  if (action && !action.startsWith('http')) {
    action = new URL(action, baseUrl).href;
  }
  if (!action) action = baseUrl;

  // Extract all input fields (hidden + submit value)
  const fields = {};
  const inputRe = /<input([^>]*)>/gi;
  let m;
  while ((m = inputRe.exec(html)) !== null) {
    const attrs = m[1];
    const nameM  = attrs.match(/name="([^"]*)"/i);
    const valueM = attrs.match(/value="([^"]*)"/i);
    const typeM  = attrs.match(/type="([^"]*)"/i);
    if (nameM) {
      // include all types except reset; include submit so the button is "clicked"
      const type = typeM ? typeM[1].toLowerCase() : 'text';
      if (type !== 'reset') fields[nameM[1]] = valueM ? valueM[1] : '';
    }
  }
  return { action, fields };
}

async function verifyFalix(url) {
  log(`🔐 Loading verification page: ${url}`);
  try {
    // Step 1 — load the page
    const { status, body, cookies, finalUrl } = await fetchFollow(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    log(`🔐 Page loaded: HTTP ${status} (${finalUrl})`);

    // Step 2 — find the form/button
    const form = parseForm(body, finalUrl);
    if (!form) {
      log(`🔐 No form found on page — verification may already be complete (HTTP ${status})`);
      return;
    }
    log(`🔐 Found form → POST ${form.action} | fields: ${JSON.stringify(form.fields)}`);

    // Step 3 — submit the form (click the button)
    const postBody = new URLSearchParams(form.fields).toString();
    const postStatus = await httpPost(form.action, postBody, cookies);
    log(`🔐 Form submitted: HTTP ${postStatus} ✅ — server verified!`);
  } catch (err) {
    log(`🔐 Verification failed: ${err.message}`);
  }
}

// Recursively walk a prismarine-chat JSON component and collect all clickEvent URLs
function extractClickUrls(obj, found = []) {
  if (!obj || typeof obj !== 'object') return found;
  if (obj.clickEvent && obj.clickEvent.action === 'open_url' && obj.clickEvent.value) {
    found.push(obj.clickEvent.value);
  }
  if (Array.isArray(obj.extra)) {
    for (const child of obj.extra) extractClickUrls(child, found);
  }
  if (Array.isArray(obj)) {
    for (const child of obj) extractClickUrls(child, found);
  }
  return found;
}

function isFalixUrl(url) {
  return url.includes('falixnodes.net') || url.includes('falix.host') || url.includes('falix.gg');
}

// Check plain text for verification URLs (fallback)
function checkTextForVerification(text) {
  const match = text.match(/https?:\/\/[^\s"'<>]+/i);
  if (!match) return;
  if (isFalixUrl(match[0])) verifyFalix(match[0]);
}

// Check a raw JSON chat component for clickable button URLs (primary method)
function checkJsonForVerification(jsonObj) {
  const urls = extractClickUrls(jsonObj);
  for (const url of urls) {
    if (isFalixUrl(url)) verifyFalix(url);
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
    checkTextForVerification(message);
  });

  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString();
    if (text) log(`[SERVER] ${text}`);
    // Primary: extract clickable button URLs from the JSON component
    checkJsonForVerification(jsonMsg.json);
    // Fallback: also scan plain text in case URL appears as text
    if (text) checkTextForVerification(text);
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
