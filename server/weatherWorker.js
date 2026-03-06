require('dotenv').config();
const db = require('./db');
const discordDb = require('./discordDb');
const { sendChannelMessage } = require('./discordService');
const { searchLocation, fetchBasicDayForecast, pickDayForecast, buildMeteogramImageUrl } = require('./meteoblueService');
const tzLookup = require('tz-lookup');

// 5 perc az értesítés ablak, hogy biztos elküldódjon
const WORKER_INTERVAL_MS = 5 * 60 * 1000;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function getDatePartsInTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day)
  };
}

function formatDateParts({ year, month, day }) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function shiftDateParts(dateParts, deltaDays) {
  const utc = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day));
  utc.setUTCDate(utc.getUTCDate() + deltaDays);
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate()
  };
}

function getTimeZoneOffset(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  return (asUtc - date.getTime()) / 60000;
}

function zonedTimeToUtc({ year, month, day, hour, minute = 0 }, timeZone) {
  const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offset = getTimeZoneOffset(utcDate, timeZone);
  return new Date(utcDate.getTime() - offset * 60000);
}

function getLocalDateString(date, timeZone) {
  const parts = getDatePartsInTimeZone(date, timeZone);
  return formatDateParts(parts);
}

function getTimeZoneOffsetDifference(tz1, tz2) {
  const now = new Date();
  const offset1 = getTimeZoneOffset(now, tz1); // minutes
  const offset2 = getTimeZoneOffset(now, tz2); // minutes
  const diffMinutes = offset1 - offset2;
  const hours = Math.floor(Math.abs(diffMinutes) / 60);
  const minutes = Math.abs(diffMinutes) % 60;
  
  let str = '';
  if (diffMinutes > 0) {
    str = `+${hours}`;
  } else if (diffMinutes < 0) {
    str = `-${hours}`;
  } else {
    str = '0';
  }
  
  if (minutes > 0) {
    str += `:${String(minutes).padStart(2, '0')}`;
  }
  
  return { hours, minutes, diffMinutes, str };
}

function average(values) {
  if (!values.length) return null;
  const sum = values.reduce((acc, val) => acc + val, 0);
  return sum / values.length;
}

function maxValue(values) {
  if (!values.length) return null;
  return Math.max(...values);
}

function formatNumber(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }
  const num = Number(value);
  if (Number.isNaN(num)) return null;
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

function normalizeLocationTimezone(location, fallback = 'UTC') {
  return location?.timezone || location?.tz || fallback || 'UTC';
}

function parseLocationField(locationValue) {
  if (!locationValue || typeof locationValue !== 'string') {
    return { country: null, city: null };
  }

  const parts = locationValue
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2) {
    return { country: null, city: null };
  }

  return {
    country: parts[0] || null,
    city: parts[1] || null
  };
}

function buildLocationQuery(event) {
  if (!event) {
    return '';
  }

  const parsedLocation = parseLocationField(event.location);
  const normalizedCity = event.city || parsedLocation.city;
  const normalizedCountry = parsedLocation.country || event.location;

  if (normalizedCity && normalizedCountry) {
    return `${normalizedCity}, ${normalizedCountry}`;
  }

  return normalizedCity || normalizedCountry || event.circuit_name || event.name || '';
}

function buildLocationQueries(event) {
  if (!event) {
    return [];
  }

  const parsedLocation = parseLocationField(event.location);
  const normalizedCity = event.city || parsedLocation.city;
  const normalizedCountry = parsedLocation.country || event.location;

  const candidates = [
    buildLocationQuery(event),
    normalizedCity && normalizedCountry ? `${normalizedCountry}, ${normalizedCity}` : null,
    normalizedCity || null,
    normalizedCountry || null,
    event.circuit_name || null,
    event.name || null
  ]
    .filter(Boolean)
    .flatMap((candidate) => {
      const trimmed = String(candidate).trim();
      if (!trimmed) {
        return [];
      }

      if (trimmed.includes(',')) {
        return [trimmed, trimmed.replace(/,/g, ' ')];
      }

      return [trimmed];
    });

  return [...new Set(candidates)];
}

async function searchLocationWithFallback(event) {
  const candidates = buildLocationQueries(event);
  let lastError = null;

  for (const query of candidates) {
    try {
      const location = await searchLocation(query);
      return { location, query };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('Location not found');
}

function resolveEventTimeZone(event) {
  if (!event) {
    return null;
  }

  if (event.timezone) {
    return event.timezone;
  }

  if (event.lat !== null && event.lat !== undefined && event.lon !== null && event.lon !== undefined) {
    try {
      return tzLookup(event.lat, event.lon);
    } catch (error) {
      return null;
    }
  }

  return null;
}

function buildFallbackLocationName(event) {
  const parsedLocation = parseLocationField(event?.location);
  return event?.circuit_name || event?.city || parsedLocation.city || event?.name || event?.location || 'Unknown location';
}

async function resolveWeatherLocation(event, fallbackTimeZone = 'UTC') {
  if (event?.lat !== null && event?.lat !== undefined && event?.lon !== null && event?.lon !== undefined) {
    const timezone = resolveEventTimeZone(event) || fallbackTimeZone || 'UTC';
    return {
      lat: event.lat,
      lon: event.lon,
      asl: event.asl,
      timezone,
      name: buildFallbackLocationName(event),
      admin1: event.city || null,
      country: event.location || null
    };
  }

  const { location } = await searchLocationWithFallback(event);
  return {
    lat: location.lat,
    lon: location.lon,
    asl: location.asl,
    timezone: normalizeLocationTimezone(location, fallbackTimeZone),
    name: location.name || buildFallbackLocationName(event),
    admin1: location.admin1,
    country: location.country
  };
}

function groupRacesByName(races) {
  const grouped = new Map();
  for (const race of races) {
    const key = (race.name || '').trim();
    if (!key) continue;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(race);
  }
  return grouped;
}

function pickNextWeekend(groupedRaces, referenceDate = new Date()) {
  let nextWeekend = null;
  for (const [name, events] of groupedRaces.entries()) {
    const sortedEvents = [...events].sort((a, b) => new Date(a.date) - new Date(b.date));
    const startEvent = sortedEvents[0];
    const endEvent = sortedEvents[sortedEvents.length - 1];
    if (!startEvent) continue;
    if (!endEvent) continue;

    // Ignore weekends that are already fully finished.
    if (new Date(endEvent.date) < referenceDate) {
      continue;
    }

    if (!nextWeekend || new Date(startEvent.date) < new Date(nextWeekend.startEvent.date)) {
      nextWeekend = { name, events: sortedEvents, startEvent };
    }
  }

  return nextWeekend;
}

async function buildWeekendWeatherEmbed({ weekendRaces, config, eventTimeZone = null }) {
  const sortedEvents = [...weekendRaces].sort((a, b) => new Date(a.date) - new Date(b.date));
  const firstEvent = sortedEvents[0];
  const resolvedEventTimeZone = eventTimeZone || resolveEventTimeZone(firstEvent) || 'UTC';
  
  // Use event's timezone for date parts (for correct meteogram image)
  const startDateParts = getDatePartsInTimeZone(new Date(firstEvent.date), resolvedEventTimeZone);
  const lastEvent = sortedEvents[sortedEvents.length - 1];
  const endDateParts = getDatePartsInTimeZone(new Date(lastEvent.date), resolvedEventTimeZone);

  const startDate = formatDateParts(startDateParts);
  // Calculate days between using date parts, not UTC (which would cause timezone offset issues)
  const daysDiff = Math.round((endDateParts.day - startDateParts.day) + 
    (endDateParts.month - startDateParts.month) * 30 + 
    (endDateParts.year - startDateParts.year) * 365);
  const daysBetween = Math.max(0, daysDiff);

  const weekendDates = [];
  for (let i = 0; i <= daysBetween; i += 1) {
    weekendDates.push(formatDateParts(shiftDateParts(startDateParts, i)));
  }

  const location = await resolveWeatherLocation(firstEvent, resolvedEventTimeZone);
  const locationTimeZone = location.timezone || resolvedEventTimeZone || 'UTC';
  const forecast = await fetchBasicDayForecast({
    lat: location.lat,
    lon: location.lon,
    asl: location.asl,
    tz: locationTimeZone,
    name: location.name
  });

  const dayForecasts = weekendDates
    .map((dateString) => pickDayForecast(forecast, dateString))
    .filter(Boolean);

  if (!dayForecasts.length) {
    throw new Error('No forecast available for weekend');
  }

  const tempMeans = dayForecasts.map((item) => item.values.temperature_mean).filter((val) => val !== undefined);
  const tempMaxes = dayForecasts.map((item) => item.values.temperature_max).filter((val) => val !== undefined);
  const windMeans = dayForecasts.map((item) => item.values.windspeed_mean).filter((val) => val !== undefined);
  const windMaxes = dayForecasts.map((item) => item.values.windspeed_max).filter((val) => val !== undefined);

  const avgTemp = average(tempMeans);
  const maxTemp = maxValue(tempMaxes);
  const avgWind = average(windMeans);
  const maxWind = maxValue(windMaxes);

  const units = dayForecasts[0].units || {};
  const temperatureUnit = resolveUnit(units, 'temperature', 'temperature_mean', 'temperature_max');
  const windspeedUnit = resolveUnit(units, 'windspeed_mean', 'windspeed_max', 'windspeed');
  const precipitationUnit = resolveUnit(units, 'precipitation_sum', 'precipitation', 'precipitation_amount');

  const locationName = [location.name, location.admin1, location.country]
    .filter(Boolean)
    .join(', ');

  const dateRange = weekendDates.length > 1
    ? `${weekendDates[0]} – ${weekendDates[weekendDates.length - 1]}`
    : weekendDates[0];

  // Generate time parameter for meteogram: YYYYMMDDHH in user's timezone
  // Using first event's date at 12:00 in user's timezone
  const timeParam = `${startDateParts.year}${String(startDateParts.month).padStart(2, '0')}${String(startDateParts.day).padStart(2, '0')}12`;

  const meteogramUrl = buildMeteogramImageUrl({
    lat: location.lat,
    lon: location.lon,
    asl: location.asl,
    tz: locationTimeZone,
    name: location.name,
    forecastDays: weekendDates.length,
    time: timeParam
  });

  const avgPrecipitation = average(dayForecasts.map((item) => item.values.precipitation_sum || item.values.precipitation).filter((val) => val !== undefined));
  const avgPrecipitationProbability = average(dayForecasts.map((item) => item.values.precipitation_probability).filter((val) => val !== undefined));

  const temperatureText = [
    formatValue(average(dayForecasts.map((item) => item.values.temperature_min).filter((val) => val !== undefined)), temperatureUnit),
    formatValue(maxTemp, temperatureUnit),
    formatValue(avgTemp, temperatureUnit)
  ].join(' • ');

  const precipitationText = formatValue(avgPrecipitation, precipitationUnit);
  const precipitationProbabilityText = `${formatNumber(avgPrecipitationProbability, 0)} %`;
  const combinedPrecipitationText = `${precipitationText} • ${precipitationProbabilityText}`;
  
  const windText = [
    formatValue(avgWind, windspeedUnit),
    formatValue(maxWind, windspeedUnit)
  ].join(' • ');

  // Calculate timezone offset difference between event TZ and config TZ
  const userTimeZone = config.timezone || 'UTC';
  let tzNote = '';
  if (resolvedEventTimeZone !== userTimeZone) {
    const tzDiff = getTimeZoneOffsetDifference(resolvedEventTimeZone, userTimeZone);
    if (tzDiff.diffMinutes > 0) {
      tzNote = `\n📍 Event location timezone: ${resolvedEventTimeZone}\n⏱️ Difference from your timezone: ${tzDiff.str} hours`;
    } else if (tzDiff.diffMinutes < 0) {
      tzNote = `\n📍 Event location timezone: ${resolvedEventTimeZone}\n⏱️ Difference from your timezone: ${tzDiff.str} hours`;
    }
  }

  const embed = {
    title: `🌦️ ${firstEvent.name} • Weekend weather`,
    description: `${locationName}\n${dateRange}${tzNote}`,
    color: 0x4aa3ff,
    fields: [
      { name: 'Temperature\n(min, max, avg)', value: temperatureText, inline: true },
      { name: 'Precipitation', value: combinedPrecipitationText, inline: true },
      { name: 'Wind\n(avg, max)', value: windText, inline: true }
    ],
    image: { url: meteogramUrl },
    footer: { text: `meteoblue • ${locationTimeZone}` }
  };

  return { embed, startDate, dateRange };
}

async function buildRaceDayWeatherEmbed({ raceEvents, config, eventTimeZone = null }) {
  const sortedEvents = [...raceEvents].sort((a, b) => new Date(a.date) - new Date(b.date));
  const firstEvent = sortedEvents[0];
  const resolvedEventTimeZone = eventTimeZone || resolveEventTimeZone(firstEvent) || 'UTC';

  const raceDayParts = getDatePartsInTimeZone(new Date(firstEvent.date), resolvedEventTimeZone);
  const raceDayDate = formatDateParts(raceDayParts);

  const location = await resolveWeatherLocation(firstEvent, resolvedEventTimeZone);
  const locationTimeZone = location.timezone || resolvedEventTimeZone || 'UTC';

  const forecast = await fetchBasicDayForecast({
    lat: location.lat,
    lon: location.lon,
    asl: location.asl,
    tz: locationTimeZone,
    name: location.name
  });

  const dayForecast = pickDayForecast(forecast, raceDayDate);
  if (!dayForecast) {
    throw new Error('No forecast available for race day');
  }

  const units = dayForecast.units || {};
  const temperatureUnit = resolveUnit(units, 'temperature', 'temperature_mean', 'temperature_max');
  const windspeedUnit = resolveUnit(units, 'windspeed_mean', 'windspeed_max', 'windspeed');
  const precipitationUnit = resolveUnit(units, 'precipitation_sum', 'precipitation', 'precipitation_amount');

  const avgTemp = dayForecast.values.temperature_mean;
  const maxTemp = dayForecast.values.temperature_max;
  const minTemp = dayForecast.values.temperature_min;
  const avgWind = dayForecast.values.windspeed_mean;
  const maxWind = dayForecast.values.windspeed_max;
  const precipitation = dayForecast.values.precipitation_sum ?? dayForecast.values.precipitation;
  const precipitationProbability = dayForecast.values.precipitation_probability;

  const locationName = [location.name, location.admin1, location.country]
    .filter(Boolean)
    .join(', ');

  const timeParam = `${raceDayParts.year}${String(raceDayParts.month).padStart(2, '0')}${String(raceDayParts.day).padStart(2, '0')}12`;
  const meteogramUrl = buildMeteogramImageUrl({
    lat: location.lat,
    lon: location.lon,
    asl: location.asl,
    tz: locationTimeZone,
    name: location.name,
    forecastDays: 1,
    time: timeParam
  });

  const temperatureText = [
    formatValue(minTemp, temperatureUnit),
    formatValue(maxTemp, temperatureUnit),
    formatValue(avgTemp, temperatureUnit)
  ].join(' • ');

  const precipitationText = formatValue(precipitation, precipitationUnit);
  const precipitationProbabilityText = `${formatNumber(precipitationProbability, 0)} %`;
  const combinedPrecipitationText = `${precipitationText} • ${precipitationProbabilityText}`;

  const windText = [
    formatValue(avgWind, windspeedUnit),
    formatValue(maxWind, windspeedUnit)
  ].join(' • ');

  const userTimeZone = config.timezone || 'UTC';
  let tzNote = '';
  if (resolvedEventTimeZone !== userTimeZone) {
    const tzDiff = getTimeZoneOffsetDifference(resolvedEventTimeZone, userTimeZone);
    if (tzDiff.diffMinutes > 0) {
      tzNote = `\n📍 Event location timezone: ${resolvedEventTimeZone}\n⏱️ Difference from your timezone: ${tzDiff.str} hours`;
    } else if (tzDiff.diffMinutes < 0) {
      tzNote = `\n📍 Event location timezone: ${resolvedEventTimeZone}\n⏱️ Difference from your timezone: ${tzDiff.str} hours`;
    }
  }

  const embed = {
    title: `🌦️ ${firstEvent.name} • Today's weather`,
    description: `${locationName}\n${raceDayDate}${tzNote}`,
    color: 0x4aa3ff,
    fields: [
      { name: 'Temperature\n(min, max, avg)', value: temperatureText, inline: true },
      { name: 'Precipitation', value: combinedPrecipitationText, inline: true },
      { name: 'Wind\n(avg, max)', value: windText, inline: true }
    ],
    image: { url: meteogramUrl },
    footer: { text: `meteoblue • ${locationTimeZone}` }
  };

  return { embed, raceDayDate };
}

async function runWeatherNotifications() {
  try {
    const weatherConfigs = await discordDb.getWeatherConfigs();
    if (!weatherConfigs.length) {
      return;
    }

    const enabledConfigs = weatherConfigs.filter(c => c.enabled);
    if (!enabledConfigs.length) {
      return;
    }

    const configs = await discordDb.getDiscordConfigs();
    const configMap = new Map(configs.map((config) => [config.guild_id, config]));

    const events = await db.getAllEvents();
    if (!events.length) {
      return;
    }

    const now = new Date();
    for (const weatherConfig of enabledConfigs) {
      const config = configMap.get(weatherConfig.guild_id);
      if (!config) {
        continue;
      }

      const weatherChannelId = weatherConfig.channel_id || config.channel_id;
      if (!weatherChannelId) {
        continue;
      }
      const weatherRoleId = weatherConfig.role_id || null;

      const grouped = groupRacesByName(events);
      const nextWeekend = pickNextWeekend(grouped, now);

      if (!nextWeekend) {
        continue;
      }

      // Get location info to determine event's timezone
      let eventTimeZone = resolveEventTimeZone(nextWeekend.startEvent);
      if (!eventTimeZone) {
        try {
          const { location } = await searchLocationWithFallback(nextWeekend.startEvent);
          eventTimeZone = normalizeLocationTimezone(location, 'UTC');
        } catch (error) {
          const locationQuery = buildLocationQuery(nextWeekend.startEvent);
          console.warn(`Could not determine timezone for ${locationQuery}, using UTC`, error.message);
          eventTimeZone = 'UTC';
        }
      }

      // Check if today is the first event day in the EVENT's timezone
      const firstEventDate = new Date(nextWeekend.startEvent.date);
      const firstEventDateParts = getDatePartsInTimeZone(firstEventDate, eventTimeZone);
      const todayDateParts = getDatePartsInTimeZone(now, eventTimeZone);

      const isTodayFirstEventDay = 
        todayDateParts.year === firstEventDateParts.year &&
        todayDateParts.month === firstEventDateParts.month &&
        todayDateParts.day === firstEventDateParts.day;

      if (!isTodayFirstEventDay) {
        continue;
      }

      const weekendKey = `${nextWeekend.name}|${formatDateParts(firstEventDateParts)}`;
      const alreadySent = await discordDb.wasWeatherNotified({
        guild_id: weatherConfig.guild_id,
        weekend_key: weekendKey
      });
      if (alreadySent) {
        continue;
      }

      try {
        const { embed } = await buildWeekendWeatherEmbed({
          weekendRaces: nextWeekend.events,
          config,
          eventTimeZone
        });
        await sendChannelMessage(weatherChannelId, embed, weatherRoleId);
        await discordDb.logWeatherNotification({
          guild_id: weatherConfig.guild_id,
          weekend_key: weekendKey,
          scheduled_for: now.toISOString()
        });
        console.log(`🌦️ [Weekend] ${nextWeekend.name} • ${weatherChannelId}`);
      } catch (error) {
        console.error(`❌ Weather failed for ${nextWeekend.name}:`, error.message || error);
      }
    }
  } catch (error) {
    console.error('Weather notification worker error:', error.message || error);
  }
}

async function sendWeatherNotificationNow(guildId) {
  const config = await discordDb.getDiscordConfigByGuild(guildId);
  if (!config) {
    throw new Error('Guild not configured');
  }

  const weatherConfig = await discordDb.getWeatherConfigByGuild(guildId);
  const weatherChannelId = weatherConfig?.channel_id || config.channel_id;
  if (!weatherChannelId) {
    throw new Error('Weather channel not configured');
  }
  const weatherRoleId = weatherConfig?.role_id || null;

  const events = await db.getAllEvents();
  if (!events.length) {
    throw new Error('No races found');
  }

  const now = new Date();
  const grouped = groupRacesByName(events);
  const nextWeekend = pickNextWeekend(grouped, now);

  if (!nextWeekend) {
    throw new Error('No upcoming race weekend found');
  }

  // Get location info to determine event's timezone
  let eventTimeZone = resolveEventTimeZone(nextWeekend.startEvent);
  if (!eventTimeZone) {
    try {
      const { location } = await searchLocationWithFallback(nextWeekend.startEvent);
      eventTimeZone = normalizeLocationTimezone(location, 'UTC');
    } catch (error) {
      const locationQuery = buildLocationQuery(nextWeekend.startEvent);
      console.warn(`Could not determine timezone for ${locationQuery}, using UTC`, error.message);
      eventTimeZone = 'UTC';
    }
  }

  const { embed } = await buildWeekendWeatherEmbed({
    weekendRaces: nextWeekend.events,
    config,
    eventTimeZone
  });

  await sendChannelMessage(weatherChannelId, embed, weatherRoleId);
  return { weekendName: nextWeekend.name };
}

async function runRaceDayWeatherNotifications() {
  try {
    const weatherConfigs = await discordDb.getWeatherConfigs();
    if (!weatherConfigs.length) {
      return;
    }

    const enabledWithLeadTime = weatherConfigs.filter(c => c.enabled && c.race_day_lead_minutes);
    if (!enabledWithLeadTime.length) {
      return;
    }

    const configs = await discordDb.getDiscordConfigs();
    const configMap = new Map(configs.map((config) => [config.guild_id, config]));

    const events = await db.getAllEvents();
    if (!events.length) {
      return;
    }

    const now = new Date();

    for (const weatherConfig of enabledWithLeadTime) {
      const config = configMap.get(weatherConfig.guild_id);
      if (!config) {
        continue;
      }

      const weatherChannelId = weatherConfig.channel_id || config.channel_id;
      if (!weatherChannelId) {
        continue;
      }
      const weatherRoleId = weatherConfig.role_id || null;

      const timeZone = config.timezone || 'UTC';
      const grouped = groupRacesByName(events.filter((event) => new Date(event.date) >= now));

      for (const [raceName, raceEvents] of grouped.entries()) {
        const todayDateString = getLocalDateString(now, timeZone);
        const eventsToday = raceEvents.filter((event) => {
          const eventDateString = getLocalDateString(new Date(event.date), timeZone);
          return eventDateString === todayDateString;
        });

        if (eventsToday.length === 0) {
          continue;
        }

        eventsToday.sort((a, b) => new Date(a.date) - new Date(b.date));
        const firstEvent = eventsToday[0];
        const firstEventTime = new Date(firstEvent.date);

        const scheduledTime = new Date(firstEventTime.getTime() - weatherConfig.race_day_lead_minutes * 60000);
        const windowEnd = new Date(scheduledTime.getTime() + WORKER_INTERVAL_MS);

        if (now < scheduledTime || now >= windowEnd) {
          continue;
        }

        const alreadySent = await discordDb.wasRaceDayWeatherNotified({
          guild_id: weatherConfig.guild_id,
          race_date: todayDateString
        });

        if (alreadySent) {
          continue;
        }

        try {
          // Get location info to determine event's timezone for race-day weather too
          let eventTimeZone = resolveEventTimeZone(firstEvent);
          if (!eventTimeZone) {
            try {
              const { location } = await searchLocationWithFallback(firstEvent);
              eventTimeZone = normalizeLocationTimezone(location, 'UTC');
            } catch (error) {
              const locationQuery = buildLocationQuery(firstEvent);
              console.warn(`Could not determine timezone for ${locationQuery}, using UTC`, error.message);
              eventTimeZone = 'UTC';
            }
          }

          const { embed } = await buildRaceDayWeatherEmbed({
            raceEvents,
            config,
            eventTimeZone
          });

          await sendChannelMessage(weatherChannelId, embed, weatherRoleId);
          
          await discordDb.logRaceDayWeatherNotification({
            guild_id: weatherConfig.guild_id,
            race_date: todayDateString,
            scheduled_for: scheduledTime.toISOString()
          });

          console.log(`🌦️ [Race Day] ${raceName} • ${todayDateString} • ${weatherChannelId}`);
        } catch (error) {
          console.error(`❌ Race-day weather failed for ${raceName}:`, error.message || error);
        }
      }
    }
  } catch (error) {
    console.error('Race-day weather notification worker error:', error.message || error);
  }
}

module.exports = { runWeatherNotifications, runRaceDayWeatherNotifications, sendWeatherNotificationNow };
