require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db');
const discordDb = require('./discordDb');
const adminDb = require('./adminDb');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const discord = require('./discordService');
const { startScheduler } = require('./scheduler');
const { syncCalendar } = require('./icsParser');
const { runDiscordNotifications } = require('./discordWorker');
const { sendWeatherNotificationNow } = require('./weatherWorker');
const { searchLocation, fetchBasicDayForecast, pickDayForecast, buildMeteogramImageUrl } = require('./meteoblueService');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

const adminSessions = new Map();
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const discordSessions = new Map();
const DISCORD_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function createAdminSession(username) {
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.set(token, {
    username,
    expiresAt: Date.now() + ADMIN_SESSION_TTL_MS
  });
  return token;
}

function createDiscordSession(discordUser) {
  const token = crypto.randomBytes(24).toString('hex');
  discordSessions.set(token, {
    discord_id: discordUser.discord_id,
    expiresAt: Date.now() + DISCORD_SESSION_TTL_MS
  });
  return token;
}

function getDiscordToken(req) {
  if (req.cookies && req.cookies.discord_session) {
    return req.cookies.discord_session;
  }
  return null;
}

function requireDiscordAuth(req, res, next) {
  const token = getDiscordToken(req);
  if (!token || !discordSessions.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const session = discordSessions.get(token);
  if (Date.now() > session.expiresAt) {
    discordSessions.delete(token);
    return res.status(401).json({ error: 'Session expired' });
  }
  req.discordUserId = session.discord_id;
  return next();
}

function getAdminToken(req) {
  if (req.cookies && req.cookies.admin_session) {
    return req.cookies.admin_session;
  }
  const authHeader = req.headers.authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
}

function requireAdmin(req, res, next) {
  const token = getAdminToken(req);

  if (!token || !adminSessions.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const session = adminSessions.get(token);
  if (Date.now() > session.expiresAt) {
    adminSessions.delete(token);
    return res.status(401).json({ error: 'Session expired' });
  }

  return next();
}

function formatNumber(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }
  const num = Number(value);
  if (Number.isNaN(num)) {
    return null;
  }
  return num.toFixed(digits);
}

function formatValue(value, unit, digits = 1) {
  const formatted = formatNumber(value, digits);
  if (formatted === null) {
    return '—';
  }
  return unit ? `${formatted} ${unit}` : formatted;
}

function resolveUnit(units, ...keys) {
  for (const key of keys) {
    if (units && units[key]) {
      return units[key];
    }
  }
  return '';
}

// API Routes
app.get('/api/races', async (req, res) => {
  try {
    const events = await db.getAllEvents();
    res.json(events);
  } catch (error) {
    console.error('Error fetching races:', error);
    res.status(500).json({ error: 'Failed to fetch races' });
  }
});

app.post('/api/races', async (req, res) => {
  try {
    const { name, location, date, type } = req.body;
    const id = await db.addRace({ name, location, date, type });
    res.status(201).json({ id, name, location, date, type });
  } catch (error) {
    console.error('Error adding race:', error);
    res.status(500).json({ error: 'Failed to add race' });
  }
});

app.delete('/api/races/:id', async (req, res) => {
  try {
    await db.deleteRace(req.params.id);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting race:', error);
    res.status(500).json({ error: 'Failed to delete race' });
  }
});

// Admin auth
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }

    const admin = await adminDb.getAdminByUsername(username);
    if (!admin) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValid = await bcrypt.compare(password, admin.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = createAdminSession(username);
    res.cookie('admin_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: ADMIN_SESSION_TTL_MS
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Error during admin login:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

app.get('/api/admin/me', requireAdmin, async (req, res) => {
  res.json({ success: true });
});

app.post('/api/admin/logout', requireAdmin, async (req, res) => {
  const token = getAdminToken(req);
  if (token) {
    adminSessions.delete(token);
  }
  res.clearCookie('admin_session');
  res.json({ success: true });
});

app.post('/api/admin/change-password', requireAdmin, async (req, res) => {
  try {
    const { username, currentPassword, newPassword } = req.body;
    if (!username || !currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    if (newPassword.length < 10) {
      return res.status(400).json({ error: 'Password too short (min 10 chars)' });
    }

    const admin = await adminDb.getAdminByUsername(username);
    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    const isValid = await bcrypt.compare(currentPassword, admin.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid current password' });
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await adminDb.updateAdminPassword(username, newHash);
    res.json({ success: true });
  } catch (error) {
    console.error('Error changing password:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// Admin - manage custom events
app.get('/api/admin/custom-events', requireAdmin, async (req, res) => {
  try {
    const events = await db.getAllEvents();
    const customEvents = events.filter(event => event.source === 'custom');
    res.json(customEvents);
  } catch (error) {
    console.error('Error fetching custom events:', error);
    res.status(500).json({ error: 'Failed to fetch custom events' });
  }
});

// Admin - get all events (races + custom) for testing notifications
app.get('/api/admin/all-events', requireAdmin, async (req, res) => {
  try {
    const events = await db.getAllEvents();
    res.json(events);
  } catch (error) {
    console.error('Error fetching all events:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

app.post('/api/admin/custom-events', requireAdmin, async (req, res) => {
  try {
    const { name, location, date, type, description } = req.body;
    if (!name || !date) {
      return res.status(400).json({ error: 'Name and date are required' });
    }

    const id = await db.addCustomEvent({ name, location, date, type, description });
    res.status(201).json({ id, name, location, date, type: type || 'custom', description });
  } catch (error) {
    console.error('Error adding custom event:', error);
    res.status(500).json({ error: 'Failed to add custom event' });
  }
});

app.delete('/api/admin/custom-events/:id', requireAdmin, async (req, res) => {
  try {
    await db.deleteCustomEvent(req.params.id);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting custom event:', error);
    res.status(500).json({ error: 'Failed to delete custom event' });
  }
});

app.post('/api/admin/sync', requireAdmin, async (req, res) => {
  try {
    await syncCalendar();
    res.json({ message: 'Calendar synced successfully' });
  } catch (error) {
    console.error('Error syncing calendar:', error);
    res.status(500).json({ error: 'Failed to sync calendar' });
  }
});

// Discord OAuth
app.get('/api/discord/login', async (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('discord_oauth_state', state, { httpOnly: true, sameSite: 'lax' });
  res.redirect(discord.buildDiscordAuthUrl(state));
});

app.get('/api/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || req.cookies.discord_oauth_state !== state) {
      return res.status(400).send('Invalid OAuth state');
    }
    res.clearCookie('discord_oauth_state');

    const tokenData = await discord.exchangeCodeForToken(code);
    const user = await discord.fetchDiscordUser(tokenData.access_token);

    await discordDb.upsertDiscordUser({
      discord_id: user.id,
      username: user.username,
      avatar: user.avatar,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    });

    const sessionToken = createDiscordSession({ discord_id: user.id });
    res.cookie('discord_session', sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: DISCORD_SESSION_TTL_MS
    });

    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/#discord`);
  } catch (error) {
    console.error('Discord OAuth callback error:', error.message || error);
    res.status(500).send('Discord authentication failed');
  }
});

app.post('/api/discord/logout', requireDiscordAuth, async (req, res) => {
  const token = getDiscordToken(req);
  if (token) {
    discordSessions.delete(token);
  }
  res.clearCookie('discord_session');
  res.json({ success: true });
});

app.get('/api/discord/me', requireDiscordAuth, async (req, res) => {
  const user = await discordDb.getDiscordUserById(req.discordUserId);
  const avatarUrl = user.avatar 
    ? `https://cdn.discordapp.com/avatars/${user.discord_id}/${user.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${parseInt(user.discord_id) % 5}.png`;
  
  res.json({
    id: user.discord_id,
    username: user.username,
    avatar: user.avatar,
    avatarUrl: avatarUrl
  });
});

app.get('/api/discord/guilds', requireDiscordAuth, async (req, res) => {
  try {
    const user = await discordDb.getDiscordUserById(req.discordUserId);
    const guilds = await discord.fetchUserGuilds(user.access_token);
    res.json(guilds);
  } catch (error) {
    console.error('Failed to fetch guilds:', error.message || error);
    res.status(500).json({ error: 'Failed to fetch guilds' });
  }
});

app.get('/api/discord/admin-guilds', requireDiscordAuth, async (req, res) => {
  try {
    const user = await discordDb.getDiscordUserById(req.discordUserId);
    const guilds = await discord.fetchUserGuilds(user.access_token);
    
    // Szűrjük csak az admin jogokkal rendelkező szervereket
    // Administrator permission = 8 (bitwise)
    const adminGuilds = guilds.filter(guild => {
      return (guild.permissions & 8) === 8;
    });
    
    // Ellenőrizzük, hogy a bot benne van-e az egyes szerveren
    const guildWithBotCheck = await Promise.all(
      adminGuilds.map(async (guild) => {
        const botInGuild = await discord.isBotInGuild(guild.id);
        return { ...guild, botInGuild };
      })
    );
    
    // Csak azokat az szervereket adjuk vissza, ahol a bot is benne van
    const activeGuilds = guildWithBotCheck.filter(guild => guild.botInGuild);
    
    res.json(activeGuilds);
  } catch (error) {
    console.error('Failed to fetch admin guilds:', error.message || error);
    res.status(500).json({ error: 'Failed to fetch admin guilds' });
  }
});

// Admin endpoint to list guilds for testing notifications
app.get('/api/admin/discord-guilds', requireAdmin, async (req, res) => {
  try {
    const configs = await discordDb.getDiscordConfigs();
    const guilds = configs.map(config => ({
      id: config.guild_id,
      name: config.guild_id // We don't have the name stored, use ID
    }));
    res.json(guilds);
  } catch (error) {
    console.error('Failed to fetch guilds for admin:', error.message || error);
    res.status(500).json({ error: 'Failed to fetch guilds' });
  }
});

app.get('/api/discord/guilds/:guildId/channels', requireDiscordAuth, async (req, res) => {
  try {
    const channels = await discord.fetchGuildChannels(req.params.guildId);
    const textChannels = channels.filter((c) => c.type === 0);
    res.json(textChannels);
  } catch (error) {
    console.error('Failed to fetch channels:', error.message || error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

app.get('/api/discord/guilds/:guildId/roles', requireDiscordAuth, async (req, res) => {
  try {
    const roles = await discord.fetchGuildRoles(req.params.guildId);
    res.json(roles);
  } catch (error) {
    console.error('Failed to fetch roles:', error.message || error);
    res.status(500).json({ error: 'Failed to fetch roles' });
  }
});

app.get('/api/discord/config/:guildId', requireDiscordAuth, async (req, res) => {
  try {
    const config = await discordDb.getDiscordConfigByGuild(req.params.guildId);
    res.json(config || null);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get config' });
  }
});

app.get('/api/discord/weather-config/:guildId', requireDiscordAuth, async (req, res) => {
  try {
    const config = await discordDb.getWeatherConfigByGuild(req.params.guildId);
    res.json(config || null);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get weather config' });
  }
});

app.post('/api/discord/config', requireDiscordAuth, async (req, res) => {
  try {
    const { guild_id, channel_id, lead_minutes, timezone, role_id, role_map } = req.body;
    if (!guild_id || !channel_id || !lead_minutes || !timezone) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    await discordDb.upsertDiscordConfig({
      guild_id,
      channel_id,
      lead_minutes,
      timezone,
      role_id: role_id || null,
      role_map: role_map || {}
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to save config:', error.message || error);
    res.status(500).json({ error: 'Failed to save config' });
  }
});

app.post('/api/discord/weather-config', requireDiscordAuth, async (req, res) => {
  try {
    const { guild_id, days_before, hour, enabled } = req.body;
    if (!guild_id || days_before === undefined || hour === undefined) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    if (Number.isNaN(Number(days_before)) || Number.isNaN(Number(hour))) {
      return res.status(400).json({ error: 'Invalid numeric values' });
    }
    const daysValue = Math.max(0, Math.min(3, Number(days_before)));
    const hourValue = Math.max(0, Math.min(23, Number(hour)));

    await discordDb.upsertWeatherConfig({
      guild_id,
      days_before: daysValue,
      hour: hourValue,
      enabled: Boolean(enabled)
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Failed to save weather config:', error.message || error);
    res.status(500).json({ error: 'Failed to save weather config' });
  }
});

app.get('/api/discord/invite-url', (req, res) => {
  const url = discord.buildBotInviteUrl();
  res.json({ url });
});

app.post('/api/sync', async (req, res) => {
  try {
    await syncCalendar();
    res.json({ message: 'Calendar synced successfully' });
  } catch (error) {
    console.error('Error syncing calendar:', error);
    res.status(500).json({ error: 'Failed to sync calendar' });
  }
});

app.post('/api/discord/test-notification', requireDiscordAuth, async (req, res) => {
  try {
    const { guild_id } = req.body;
    if (!guild_id) {
      return res.status(400).json({ error: 'Guild ID required' });
    }

    const config = await discordDb.getDiscordConfigByGuild(guild_id);
    if (!config) {
      return res.status(404).json({ error: 'Guild not configured' });
    }

    const testEmbed = {
      title: '🏁 Test Notification',
      description: 'This is a test notification from F1 Calendar.',
      color: 0xe10600,
      fields: [
        { name: 'Channel', value: `<#${config.channel_id}>`, inline: true },
        { name: 'Timezone', value: config.timezone, inline: true }
      ],
      footer: { text: 'F1 Calendar • Discord Notify' }
    };

    await discord.sendChannelMessage(config.channel_id, testEmbed, config.role_id);
    res.json({ success: true, message: 'Test notification sent' });
  } catch (error) {
    console.error('Failed to send test notification:', error.message || error);
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

app.post('/api/discord/weather-test', requireDiscordAuth, async (req, res) => {
  try {
    const { guild_id } = req.body;
    if (!guild_id) {
      return res.status(400).json({ error: 'Guild ID required' });
    }

    const result = await sendWeatherNotificationNow(guild_id);
    res.json({ success: true, weekend: result.weekendName });
  } catch (error) {
    console.error('Failed to send weather test:', error.message || error);
    res.status(500).json({ error: error.message || 'Failed to send weather test' });
  }
});

// Notification management
app.get('/api/discord/notifications/:guildId', requireDiscordAuth, async (req, res) => {
  try {
    const notifications = await discordDb.getNotificationsByGuild(req.params.guildId);
    res.json(notifications);
  } catch (error) {
    console.error('Failed to fetch notifications:', error.message || error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

app.post('/api/discord/notifications', requireDiscordAuth, async (req, res) => {
  try {
    const { guild_id, lead_minutes, event_types } = req.body;
    if (!guild_id || lead_minutes === undefined) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const id = await discordDb.addNotification({ guild_id, lead_minutes, event_types });
    res.json({ success: true, id });
  } catch (error) {
    console.error('Failed to add notification:', error.message || error);
    res.status(500).json({ error: 'Failed to add notification' });
  }
});

app.delete('/api/discord/notifications/:id', requireDiscordAuth, async (req, res) => {
  try {
    await discordDb.deleteNotification(req.params.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete notification:', error.message || error);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

// Admin test notification by type
app.post('/api/admin/test-notification-type', requireAdmin, async (req, res) => {
  try {
    const { guild_id, event_type, lead_minutes } = req.body;
    if (!guild_id || !event_type || lead_minutes === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const config = await discordDb.getDiscordConfigByGuild(guild_id);
    if (!config) {
      return res.status(404).json({ error: 'Guild not configured' });
    }

    // Create mock race event
    const mockRace = {
      id: 99999,
      name: `Test ${event_type.charAt(0).toUpperCase() + event_type.slice(1)} Event`,
      location: 'Test Circuit',
      city: 'Test City',
      circuit_name: 'Test Circuit Layout',
      date: new Date(Date.now() + lead_minutes * 60 * 1000).toISOString(),
      type: event_type
    };

    // Build embed using worker logic
    const { buildRaceEmbed } = require('./discordWorker');
    const embed = await buildRaceEmbed(mockRace, config, lead_minutes);
    
    // Get role for this event type
    const roleIdForType = config.role_map?.[event_type] || config.role_id || null;
    
    await discord.sendChannelMessage(config.channel_id, embed, roleIdForType);
    res.json({ success: true, message: 'Test notification sent' });
  } catch (error) {
    console.error('Failed to send admin test notification:', error.message || error);
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

// Send test notification for real race event
app.post('/api/admin/send-test-race-notification', requireAdmin, async (req, res) => {
  try {
    const { channel_id, race_id, lead_minutes } = req.body;
    if (!channel_id || !race_id || lead_minutes === undefined) {
      return res.status(400).json({ error: 'Missing required fields: channel_id, race_id, lead_minutes' });
    }

    // Get race from database
    const races = await db.getAllEvents();
    const race = races.find(r => r.id === parseInt(race_id));
    
    if (!race) {
      return res.status(404).json({ error: 'Race not found' });
    }

    // Get discord server config for this channel
    const config = await discordDb.getDiscordConfigByChannelId(channel_id);
    if (!config) {
      return res.status(400).json({ error: 'Channel not configured in any Discord server' });
    }

    // Build embed using worker logic
    const { buildRaceEmbed } = require('./discordWorker');
    const embed = await buildRaceEmbed(race, config, lead_minutes);
    
    // Get role for this event type
    const roleIdForType = config.role_map?.[race.type] || config.role_id || null;
    
    await discord.sendChannelMessage(channel_id, embed, roleIdForType);
    res.json({ success: true, message: 'Test race notification sent' });
  } catch (error) {
    console.error('Failed to send test race notification:', error.message || error);
    res.status(500).json({ error: 'Failed to send test notification: ' + error.message });
  }
});

// Admin debug: fetch Meteoblue weather and send to Discord
app.post('/api/admin/weather-debug', requireAdmin, async (req, res) => {
  try {
    const { city, date, channel_id } = req.body;
    if (!city || !date || !channel_id) {
      return res.status(400).json({ error: 'Missing required fields: city, date, channel_id' });
    }

    const location = await searchLocation(city);
    const forecast = await fetchBasicDayForecast({
      lat: location.lat,
      lon: location.lon,
      asl: location.asl,
      tz: location.timezone,
      name: location.name
    });

    const dayForecast = pickDayForecast(forecast, date);
    if (!dayForecast) {
      return res.status(404).json({ error: 'No forecast available for the requested date' });
    }

    const { values, units } = dayForecast;

    const temperatureUnit = resolveUnit(units, 'temperature', 'temperature_max', 'temperature_min', 'temperature_mean');
    const precipitationUnit = resolveUnit(units, 'precipitation_sum', 'precipitation', 'precipitation_amount');
    const windspeedUnit = resolveUnit(units, 'windspeed_mean', 'windspeed', 'windspeed_max');

    const temperatureTextParts = [];
    if (values.temperature_min !== undefined) {
      temperatureTextParts.push(formatValue(values.temperature_min, temperatureUnit));
    }
    if (values.temperature_max !== undefined) {
      temperatureTextParts.push(formatValue(values.temperature_max, temperatureUnit));
    }
    if (values.temperature_mean !== undefined) {
      temperatureTextParts.push(formatValue(values.temperature_mean, temperatureUnit));
    }
    const temperatureText = temperatureTextParts.length > 0 ? temperatureTextParts.join(' • ') : '—';

    const precipitationValue = values.precipitation_sum !== undefined ? values.precipitation_sum : values.precipitation;
    const precipitationText = precipitationValue !== undefined
      ? formatValue(precipitationValue, precipitationUnit)
      : '—';

    const precipitationProbabilityText = values.precipitation_probability !== undefined
      ? `${formatNumber(values.precipitation_probability, 0)} %`
      : '—';

    const windTextParts = [];
    if (values.windspeed_mean !== undefined) {
      windTextParts.push(formatValue(values.windspeed_mean, windspeedUnit));
    }
    if (values.windspeed_max !== undefined) {
      windTextParts.push(formatValue(values.windspeed_max, windspeedUnit));
    }
    const windText = windTextParts.length > 0 ? windTextParts.join(' • ') : '—';

    const locationName = [location.name, location.admin1, location.country]
      .filter(Boolean)
      .join(', ');

    const meteogramUrl = buildMeteogramImageUrl({
      lat: location.lat,
      lon: location.lon,
      asl: location.asl,
      tz: location.timezone,
      name: location.name,
      forecastDays: 1
    });

    const combinedPrecipitationText = precipitationText !== '—' && precipitationProbabilityText !== '—'
      ? `${precipitationText} • ${precipitationProbabilityText}`
      : (precipitationText !== '—' ? precipitationText : precipitationProbabilityText);

    const embed = {
      title: '🌦️ Időjárás előrejelzés',
      description: `${locationName}\n${date}`,
      color: 0x4aa3ff,
      fields: [
        { name: 'Hőmérséklet\n(min, max, avg)', value: temperatureText, inline: true },
        { name: 'Csapadék', value: combinedPrecipitationText, inline: true },
        { name: 'Szél\n(avg, max)', value: windText, inline: true }
      ],
      image: { url: meteogramUrl },
      footer: { text: `meteoblue • ${location.timezone || 'UTC'}` }
    };

    await discord.sendChannelMessage(channel_id, embed);

    res.json({
      success: true,
      location: {
        name: location.name,
        admin1: location.admin1,
        country: location.country,
        lat: location.lat,
        lon: location.lon,
        asl: location.asl,
        timezone: location.timezone
      },
      date,
      values,
      units
    });
  } catch (error) {
    console.error('Weather debug failed:', error.message || error);
    res.status(500).json({ error: error.message || 'Failed to fetch weather data' });
  }
});

// Initialize database and start scheduler
Promise.all([db.initDatabase(), adminDb.initAdminDatabase(), discordDb.initDiscordDatabase()])
  .then(() => {
    console.log('Databases initialized');
    // Initial sync
    return syncCalendar();
  })
  .then(() => {
    console.log('Initial calendar sync completed');
    // Start cron job for hourly updates
    startScheduler();
    console.log('Scheduler started - will sync every hour');
  })
  .catch(error => {
    console.error('Initialization error:', error);
  });

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
