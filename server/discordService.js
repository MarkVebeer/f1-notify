const axios = require('axios');

const DISCORD_API = 'https://discord.com/api/v10';

// Retry logika Discord API rate limitek kezelésére
async function retryRequest(requestFn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await requestFn();
    } catch (error) {
      const isRateLimit = error.response?.status === 429;
      const isServerError = error.response?.status >= 500;
      const shouldRetry = isRateLimit || isServerError;
      
      if (shouldRetry && i < retries - 1) {
        const retryAfter = error.response?.headers['retry-after'];
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : delay * (i + 1);
        console.log(`Discord API error ${error.response?.status}, retrying after ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        throw error;
      }
    }
  }
}

function getDiscordConfig() {
  return {
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    redirectUri: process.env.DISCORD_REDIRECT_URI,
    botToken: process.env.DISCORD_BOT_TOKEN
  };
}

function buildDiscordAuthUrl(state) {
  const { clientId, redirectUri } = getDiscordConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify guilds',
    state
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const { clientId, clientSecret, redirectUri } = getDiscordConfig();
  const data = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  });

  const response = await axios.post(`${DISCORD_API}/oauth2/token`, data, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  return response.data;
}

async function fetchDiscordUser(accessToken) {
  return retryRequest(async () => {
    const response = await axios.get(`${DISCORD_API}/users/@me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    return response.data;
  });
}

async function fetchUserGuilds(accessToken) {
  return retryRequest(async () => {
    const response = await axios.get(`${DISCORD_API}/users/@me/guilds`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    return response.data;
  });
}

async function fetchGuildChannels(guildId) {
  const { botToken } = getDiscordConfig();
  return retryRequest(async () => {
    const response = await axios.get(`${DISCORD_API}/guilds/${guildId}/channels`, {
      headers: {
        Authorization: `Bot ${botToken}`
      }
    });
    return response.data;
  });
}

async function fetchGuildRoles(guildId) {
  const { botToken } = getDiscordConfig();
  return retryRequest(async () => {
    const response = await axios.get(`${DISCORD_API}/guilds/${guildId}/roles`, {
      headers: {
        Authorization: `Bot ${botToken}`
      }
    });
    return response.data;
  });
}

async function sendChannelMessage(channelId, embed, roleId = null) {
  const { botToken } = getDiscordConfig();
  const payload = { embeds: [embed] };
  
  if (roleId) {
    payload.content = `<@&${roleId}>`;
  }
  
  const response = await axios.post(
    `${DISCORD_API}/channels/${channelId}/messages`,
    payload,
    {
      headers: {
        Authorization: `Bot ${botToken}`
      }
    }
  );
  return response.data;
}

function buildBotInviteUrl(guildId) {
  const { clientId } = getDiscordConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    scope: 'bot applications.commands',
    permissions: '2147560448'
  });
  if (guildId) params.set('guild_id', guildId);
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

async function isBotInGuild(guildId) {
  try {
    const { botToken } = getDiscordConfig();
    return await retryRequest(async () => {
      const response = await axios.get(`${DISCORD_API}/guilds/${guildId}`, {
        headers: {
          Authorization: `Bot ${botToken}`
        }
      });
      return !!response.data;
    });
  } catch (error) {
    return false;
  }
}

module.exports = {
  getDiscordConfig,
  buildDiscordAuthUrl,
  exchangeCodeForToken,
  fetchDiscordUser,
  fetchUserGuilds,
  fetchGuildChannels,
  fetchGuildRoles,
  sendChannelMessage,
  buildBotInviteUrl,
  isBotInGuild
};
