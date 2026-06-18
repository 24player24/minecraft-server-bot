# Minecraft 24/7 Server Bot

A bot that connects to your Minecraft server 24/7 and auto-reconnects if kicked or disconnected.

## Server
- **Host:** 157.90.205.61
- **Port:** 48424
- **Username:** StayAliveBot (offline mode)

## Setup

```bash
npm install
npm start
```

## Features

- Connects on startup automatically
- Auto-reconnects after kicks or disconnects (5 second delay)
- Logs health & food every 60 seconds to show it's alive
- Logs all chat messages
- Handles crashes gracefully

## Running 24/7 (on a server/VPS)

Use `pm2` to keep it running permanently:

```bash
npm install -g pm2
pm2 start bot.js --name minecraft-bot
pm2 save
pm2 startup
```

Or just run directly:

```bash
npm start
```

## Configuration

Edit the top of `bot.js` to change:
- `HOST` — server IP
- `PORT` — server port
- `USERNAME` — bot's username
- `RECONNECT_DELAY_MS` — how long to wait before reconnecting (default 5000ms)
