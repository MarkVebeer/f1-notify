const axios = require('axios');
const WebSocket = require('ws');

const DISCORD_API = 'https://discord.com/api/v10';

let ws = null;
let heartbeatInterval = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let sessionId = null;
let sequence = null;

function getActivityType(type) {
  switch (String(type || 'WATCHING').toUpperCase()) {
    case 'PLAYING':
      return 0;
    case 'STREAMING':
      return 1;
    case 'LISTENING':
      return 2;
    case 'WATCHING':
      return 3;
    case 'COMPETING':
      return 5;
    default:
      return 3;
  }
}

function buildPresencePayload() {
  const activityText = process.env.DISCORD_BOT_ACTIVITY_TEXT || 'f1.markveber.hu';
  const activityType = getActivityType(process.env.DISCORD_BOT_ACTIVITY_TYPE || 'WATCHING');
  const status = process.env.DISCORD_BOT_STATUS || 'online';

  return {
    since: null,
    activities: [
      {
        name: activityText,
        type: activityType
      }
    ],
    status,
    afk: false
  };
}

function clearTimers() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function sendHeartbeat() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify({
    op: 1,
    d: sequence
  }));
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectPresence().catch((error) => {
      console.error('Discord presence reconnect failed:', error.message || error);
      scheduleReconnect();
    });
  }, 5000);
}

async function fetchGatewayUrl(botToken) {
  const response = await axios.get(`${DISCORD_API}/gateway/bot`, {
    headers: {
      Authorization: `Bot ${botToken}`
    }
  });

  return response.data.url;
}

function handleGatewayMessage(rawMessage, botToken) {
  let payload;

  try {
    payload = JSON.parse(rawMessage);
  } catch {
    return;
  }

  if (payload.s !== null && payload.s !== undefined) {
    sequence = payload.s;
  }

  if (payload.op === 10) {
    heartbeatInterval = payload.d.heartbeat_interval;

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }

    heartbeatTimer = setInterval(sendHeartbeat, heartbeatInterval);
    sendHeartbeat();

    ws.send(JSON.stringify({
      op: 2,
      d: {
        token: botToken,
        intents: 0,
        properties: {
          os: process.platform,
          browser: 'f1-notify',
          device: 'f1-notify'
        },
        presence: buildPresencePayload()
      }
    }));

    return;
  }

  if (payload.op === 11) {
    return;
  }

  if (payload.t === 'READY') {
    sessionId = payload.d?.session_id || null;
    console.log('Discord presence connected');
  }
}

async function connectPresence() {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    console.warn('Discord presence not started: missing DISCORD_BOT_TOKEN');
    return;
  }

  clearTimers();

  if (ws) {
    try {
      ws.terminate();
    } catch {
      // no-op
    }
    ws = null;
  }

  const gatewayUrl = await fetchGatewayUrl(botToken);
  ws = new WebSocket(`${gatewayUrl}?v=10&encoding=json`);

  ws.on('message', (message) => {
    handleGatewayMessage(message, botToken);
  });

  ws.on('close', () => {
    sessionId = null;
    clearTimers();
    scheduleReconnect();
  });

  ws.on('error', (error) => {
    console.error('Discord presence socket error:', error.message || error);
  });
}

function startDiscordPresence() {
  connectPresence().catch((error) => {
    console.error('Failed to start Discord presence:', error.message || error);
    scheduleReconnect();
  });
}

module.exports = {
  startDiscordPresence
};
