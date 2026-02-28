require('dotenv').config();
const axios = require('axios');
const db = require('./db');
const discordDb = require('./discordDb');
const { sendChannelMessage } = require('./discordService');

const WORKER_INTERVAL_MS = 60 * 1000;
const TRACK_LAYOUT_JSON_URL = process.env.TRACK_LAYOUT_JSON_URL || 'https://raw.githubusercontent.com/julesr0y/f1-circuits-svg/refs/heads/main/circuits.json';
const TRACK_LAYOUT_SVG_FOLDER_URL = process.env.TRACK_LAYOUT_SVG_FOLDER_URL || process.env['TRACK:LAYOUT_SVG_FOLDER_URL'] || 'https://raw.githubusercontent.com/julesr0y/f1-circuits-svg/refs/heads/main/circuits/white-outline';
const TRACK_LAYOUT_CACHE_TTL_MS = 60 * 60 * 1000;

const COUNTRY_ALIASES = {
  usa: 'united-states-of-america',
  'united-states': 'united-states-of-america',
  'united-states-of-america': 'united-states-of-america',
  us: 'united-states-of-america',
  uk: 'united-kingdom',
  'great-britain': 'united-kingdom',
  britain: 'united-kingdom',
  uae: 'united-arab-emirates'
};

let trackLayoutMapCache = null;
let trackLayoutMapFetchedAt = 0;

function normalizeCountryId(value) {
  if (!value) return '';

  const normalized = String(value)
    .split(',')[0]
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return COUNTRY_ALIASES[normalized] || normalized;
}

function getLayoutOrder(layoutId) {
  const match = String(layoutId || '').match(/(\d+)(?!.*\d)/);
  return match ? Number.parseInt(match[1], 10) : Number.NEGATIVE_INFINITY;
}

function getLatestLayoutId(layouts) {
  if (!Array.isArray(layouts) || layouts.length === 0) {
    return null;
  }

  return layouts
    .map((layout) => {
      const layoutId = layout?.layoutId || '';
      return {
        layoutId,
        order: getLayoutOrder(layoutId)
      };
    })
    .filter((item) => item.layoutId)
    .sort((a, b) => b.order - a.order)[0]?.layoutId || null;
}

function getCircuitMaxSeasonYear(layouts) {
  if (!Array.isArray(layouts) || layouts.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }

  const years = layouts.flatMap((layout) => {
    const seasons = layout?.seasons || '';
    const matches = String(seasons).match(/\d{4}/g);
    return matches ? matches.map((year) => Number.parseInt(year, 10)) : [];
  });

  return years.length > 0 ? Math.max(...years) : Number.NEGATIVE_INFINITY;
}

function buildCountryLayoutMap(circuits) {
  const bestByCountry = {};

  if (!Array.isArray(circuits)) {
    return {};
  }

  for (const circuit of circuits) {
    const countryId = normalizeCountryId(circuit?.countryId);
    const latestLayoutId = getLatestLayoutId(circuit?.layouts);
    if (!countryId || !latestLayoutId) {
      continue;
    }

    const candidate = {
      layoutId: latestLayoutId,
      maxSeasonYear: getCircuitMaxSeasonYear(circuit?.layouts),
      layoutOrder: getLayoutOrder(latestLayoutId)
    };

    const current = bestByCountry[countryId];
    if (
      !current ||
      candidate.maxSeasonYear > current.maxSeasonYear ||
      (candidate.maxSeasonYear === current.maxSeasonYear && candidate.layoutOrder > current.layoutOrder)
    ) {
      bestByCountry[countryId] = candidate;
    }
  }

  const result = {};
  for (const [countryId, value] of Object.entries(bestByCountry)) {
    result[countryId] = value.layoutId;
  }
  return result;
}

async function getTrackLayoutMap() {
  const now = Date.now();
  if (trackLayoutMapCache && now - trackLayoutMapFetchedAt < TRACK_LAYOUT_CACHE_TTL_MS) {
    return trackLayoutMapCache;
  }

  try {
    const response = await axios.get(TRACK_LAYOUT_JSON_URL, { timeout: 10000 });
    trackLayoutMapCache = buildCountryLayoutMap(response.data);
    trackLayoutMapFetchedAt = now;
    return trackLayoutMapCache;
  } catch (error) {
    console.error('Failed to fetch track layout map for Discord embeds:', error.message || error);
    return trackLayoutMapCache || {};
  }
}

async function resolveTrackLayoutUrl(race) {
  const countryId = normalizeCountryId(race?.location);
  if (!countryId) {
    return null;
  }

  const map = await getTrackLayoutMap();
  const layoutId = map[countryId];
  if (!layoutId) {
    return null;
  }

  const baseUrl = TRACK_LAYOUT_SVG_FOLDER_URL.replace(/\/+$/, '');
  return `${baseUrl}/${layoutId}.svg`;
}

function toDiscordImageUrl(layoutSvgUrl) {
  if (!layoutSvgUrl) {
    return null;
  }

  const withoutProtocol = layoutSvgUrl.replace(/^https?:\/\//, '');
  return `https://images.weserv.nl/?url=${encodeURIComponent(withoutProtocol)}&output=png&w=420&h=260&fit=inside`;
}

async function buildRaceEmbed(race, config, leadMinutes) {
  const start = new Date(race.date);
  const locale = 'hu-HU';

  // Different message based on lead_minutes
  let description;
  if (leadMinutes === 0) {
    description = `🚦 Az esemény most kezdődik!`;
  } else if (leadMinutes === 1) {
    description = `Az esemény 1 percen belül kezdődik!`;
  } else if (leadMinutes < 60) {
    description = `Az esemény ${leadMinutes} percen belül kezdődik!`;
  } else {
    const hours = Math.floor(leadMinutes / 60);
    const minutes = leadMinutes % 60;
    if (minutes === 0) {
      description = `Az esemény ${hours} órán belül kezdődik!`;
    } else {
      description = `Az esemény ${hours} óra ${minutes} percen belül kezdődik!`;
    }
  }

  // Build location info
  let locationValue = race.location || '—';
  if (race.city) {
    locationValue = `${race.location}, ${race.city}`;
  }

  // Get circuit image URL (from Wikimedia or fallback)
  let circuitImage = null;
  if (race.circuit_name) {
    // Try to use a circuit layout from Wikimedia Commons
    // Format: Circuit-name-circuits-layout.svg
    const circuitId = race.circuit_name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');
    circuitImage = `https://upload.wikimedia.org/wikipedia/commons/thumb/f/f7/${circuitId}-circuit-layout.svg/400px-${circuitId}-circuit-layout.svg.png`;
  }

  const fields = [
    { name: 'Típus', value: getEventTypeName(race.type), inline: true },
    { name: 'Kezdés', value: start.toLocaleString(locale, { timeZone: config.timezone }), inline: true },
    { name: 'Helyszín', value: locationValue, inline: false }
  ];

  if (race.circuit_name) {
    fields.push({ name: '🏎️ Pálya', value: race.circuit_name, inline: false });
  }

  const trackLayoutUrl = await resolveTrackLayoutUrl(race);

  const embed = {
    title: `🏁 ${race.name}`,
    description: description,
    color: getColorForType(race.type),
    fields: fields,
    footer: { text: 'F1 Calendar • Discord Notify' }
  };

  const discordTrackLayoutImageUrl = toDiscordImageUrl(trackLayoutUrl);

  if (discordTrackLayoutImageUrl) {
    embed.thumbnail = { url: discordTrackLayoutImageUrl };
  } else if (circuitImage) {
    embed.thumbnail = { url: circuitImage };
  }

  return embed;
}

function getEventTypeName(type) {
  switch(type) {
    case 'race': return '🏁 Race';
    case 'qualifying': return '⏱️ Qualifying';
    case 'practice': return '🔧 Practice';
    case 'sprint': return '⚡ Sprint';
    case 'custom': return '📝 Custom';
    default: return type;
  }
}

function getColorForType(type) {
  switch(type) {
    case 'race': return 0xe10600;      // F1 Red
    case 'qualifying': return 0xf093fb; // Pink
    case 'practice': return 0x667eea;   // Blue
    case 'sprint': return 0xfad961;     // Yellow
    case 'custom': return 0xa0a0a8;     // Gray
    default: return 0xe10600;
  }
}

async function sendMessageWithRetry(channelId, embed, roleId, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await sendChannelMessage(channelId, embed, roleId);
      return true;
    } catch (error) {
      console.error(`Attempt ${attempt}/${maxRetries} failed for channel ${channelId}:`, error.message);
      
      if (attempt < maxRetries) {
        // Exponential backoff: 1s, 2s, 4s
        const waitTime = Math.pow(2, attempt - 1) * 1000;
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        throw error;
      }
    }
  }
}

async function runDiscordNotifications() {
  try {
    const configs = await discordDb.getDiscordConfigs();
    if (configs.length === 0) {
      return;
    }

    const windowHours = 168;
    const now = new Date();
    const until = new Date(now.getTime() + windowHours * 60 * 60 * 1000);
    
    const races = await db.getUpcomingEvents(windowHours); // next 7 days (+ 5 min lookback)
    if (races.length === 0) {
      return;
    }

    const windowMs = WORKER_INTERVAL_MS;

    for (const config of configs) {
      // Fetch all notifications for this guild
      const notifications = await discordDb.getNotificationsByGuild(config.guild_id);
      if (notifications.length === 0) {
        continue;
      }

      for (const race of races) {
        const raceTime = new Date(race.date).getTime();
        const now = Date.now();

        for (const notification of notifications) {
          // Check if this event type is in the allowed types
          if (!notification.event_types.includes(race.type)) {
            continue;
          }

          const notifyAt = raceTime - notification.lead_minutes * 60 * 1000;

          // Check if we're in the worker interval window
          if (now < notifyAt || now > notifyAt + windowMs) {
            continue;
          }

          const alreadySent = await discordDb.wasDiscordNotified({ 
            guild_id: config.guild_id, 
            race_id: race.id,
            lead_minutes: notification.lead_minutes
          });
          if (alreadySent) {
            continue;
          }

          try {
            const embed = await buildRaceEmbed(race, config, notification.lead_minutes);
            const roleIdForType = config.role_map?.[race.type] || config.role_id || null;
            await sendMessageWithRetry(config.channel_id, embed, roleIdForType);
            await discordDb.logDiscordNotification({
              guild_id: config.guild_id,
              race_id: race.id,
              channel_id: config.channel_id,
              lead_minutes: notification.lead_minutes,
              scheduled_for: new Date(notifyAt).toISOString()
            });
            console.log(`Notification sent for ${race.name} in guild ${config.guild_id} (${notification.lead_minutes} min before)`);
          } catch (error) {
            console.error(`Failed to send notification for ${race.name} in guild ${config.guild_id}:`, error.message);
          }
        }
      }
    }
  } catch (error) {
    console.error('Discord notification worker error:', error.message || error);
  }
}

function startDiscordWorker() {
  console.log('Discord notification worker started');
  runDiscordNotifications();
  setInterval(runDiscordNotifications, WORKER_INTERVAL_MS);
}

if (require.main === module) {
  Promise.all([db.initDatabase(), discordDb.initDiscordDatabase()])
    .then(() => startDiscordWorker())
    .catch((error) => {
      console.error('Failed to start discord worker:', error);
    });
}

module.exports = { startDiscordWorker, runDiscordNotifications, buildRaceEmbed };
