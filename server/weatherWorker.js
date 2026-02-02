require('dotenv').config();
const db = require('./db');
const discordDb = require('./discordDb');
const { sendChannelMessage } = require('./discordService');
const { searchLocation, fetchBasicDayForecast, pickDayForecast, buildMeteogramImageUrl } = require('./meteoblueService');

const WORKER_INTERVAL_MS = 60 * 1000;

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

function pickNextWeekend(groupedRaces) {
  let nextWeekend = null;
  for (const [name, events] of groupedRaces.entries()) {
    const sortedEvents = [...events].sort((a, b) => new Date(a.date) - new Date(b.date));
    const startEvent = sortedEvents[0];
    if (!startEvent) continue;

    if (!nextWeekend || new Date(startEvent.date) < new Date(nextWeekend.startEvent.date)) {
      nextWeekend = { name, events: sortedEvents, startEvent };
    }
  }

  return nextWeekend;
}

async function buildWeekendWeatherEmbed({ weekendRaces, config }) {
  const timeZone = config.timezone || 'UTC';
  const sortedEvents = [...weekendRaces].sort((a, b) => new Date(a.date) - new Date(b.date));
  const firstEvent = sortedEvents[0];
  const startDateParts = getDatePartsInTimeZone(new Date(firstEvent.date), timeZone);
  const lastEvent = sortedEvents[sortedEvents.length - 1];
  const endDateParts = getDatePartsInTimeZone(new Date(lastEvent.date), timeZone);

  const startDate = formatDateParts(startDateParts);
  const startUtc = Date.UTC(startDateParts.year, startDateParts.month - 1, startDateParts.day);
  const endUtc = Date.UTC(endDateParts.year, endDateParts.month - 1, endDateParts.day);
  const daysBetween = Math.max(0, Math.round((endUtc - startUtc) / 86400000));

  const weekendDates = [];
  for (let i = 0; i <= daysBetween; i += 1) {
    weekendDates.push(formatDateParts(shiftDateParts(startDateParts, i)));
  }

  const locationQuery = firstEvent.city
    ? `${firstEvent.city}, ${firstEvent.location}`
    : (firstEvent.location || firstEvent.name);

  const location = await searchLocation(locationQuery);
  const forecast = await fetchBasicDayForecast({
    lat: location.lat,
    lon: location.lon,
    asl: location.asl,
    tz: location.timezone,
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

  const meteogramUrl = buildMeteogramImageUrl({
    lat: location.lat,
    lon: location.lon,
    asl: location.asl,
    tz: location.timezone,
    name: location.name,
    forecastDays: weekendDates.length
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

  const embed = {
    title: `🌦️ ${firstEvent.name} • Hétvégi időjárás`,
    description: `${locationName}\n${dateRange}`,
    color: 0x4aa3ff,
    fields: [
      { name: 'Hőmérséklet\n(min, max, avg)', value: temperatureText, inline: true },
      { name: 'Csapadék', value: combinedPrecipitationText, inline: true },
      { name: 'Szél\n(avg, max)', value: windText, inline: true }
    ],
    image: { url: meteogramUrl },
    footer: { text: `meteoblue • ${timeZone}` }
  };

  return { embed, startDate, dateRange };
}

async function runWeatherNotifications() {
  try {
    const weatherConfigs = await discordDb.getWeatherConfigs();
    if (!weatherConfigs.length) {
      return;
    }

    const configs = await discordDb.getDiscordConfigs();
    const configMap = new Map(configs.map((config) => [config.guild_id, config]));

    const events = await db.getAllEvents();
    if (!events.length) {
      return;
    }

    const now = new Date();
    for (const weatherConfig of weatherConfigs) {
      if (!weatherConfig.enabled) {
        continue;
      }

      const config = configMap.get(weatherConfig.guild_id);
      if (!config) {
        continue;
      }

      const grouped = groupRacesByName(events.filter((event) => new Date(event.date) >= now));
      const nextWeekend = pickNextWeekend(grouped);

      if (!nextWeekend) {
        continue;
      }

      const timeZone = config.timezone || 'UTC';
      const startDateParts = getDatePartsInTimeZone(new Date(nextWeekend.startEvent.date), timeZone);
      const scheduledDateParts = shiftDateParts(startDateParts, -weatherConfig.days_before);
      const scheduledTimeUtc = zonedTimeToUtc({
        year: scheduledDateParts.year,
        month: scheduledDateParts.month,
        day: scheduledDateParts.day,
        hour: weatherConfig.hour,
        minute: 0
      }, timeZone);

      const windowEnd = new Date(scheduledTimeUtc.getTime() + WORKER_INTERVAL_MS);
      if (now < scheduledTimeUtc || now >= windowEnd) {
        continue;
      }

      const weekendKey = `${nextWeekend.name}|${formatDateParts(startDateParts)}`;
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
          config
        });
        await sendChannelMessage(config.channel_id, embed);
        await discordDb.logWeatherNotification({
          guild_id: weatherConfig.guild_id,
          weekend_key: weekendKey,
          scheduled_for: scheduledTimeUtc.toISOString()
        });
        console.log(`Weather notification sent for ${nextWeekend.name} in guild ${weatherConfig.guild_id}`);
      } catch (error) {
        console.error(`Failed to send weather notification for ${nextWeekend.name}:`, error.message || error);
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

  const events = await db.getAllEvents();
  if (!events.length) {
    throw new Error('No races found');
  }

  const now = new Date();
  const grouped = groupRacesByName(events.filter((event) => new Date(event.date) >= now));
  const nextWeekend = pickNextWeekend(grouped);

  if (!nextWeekend) {
    throw new Error('No upcoming race weekend found');
  }

  const { embed } = await buildWeekendWeatherEmbed({
    weekendRaces: nextWeekend.events,
    config
  });

  await sendChannelMessage(config.channel_id, embed);
  return { weekendName: nextWeekend.name };
}

async function runRaceDayWeatherNotifications() {
  try {
    const weatherConfigs = await discordDb.getWeatherConfigs();
    if (!weatherConfigs.length) {
      return;
    }

    const configs = await discordDb.getDiscordConfigs();
    const configMap = new Map(configs.map((config) => [config.guild_id, config]));

    const events = await db.getAllEvents();
    if (!events.length) {
      return;
    }

    const now = new Date();

    for (const weatherConfig of weatherConfigs) {
      if (!weatherConfig.race_day_lead_minutes) {
        continue;
      }

      const config = configMap.get(weatherConfig.guild_id);
      if (!config) {
        continue;
      }

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
          const { embed } = await buildWeekendWeatherEmbed({
            weekendRaces: raceEvents,
            config
          });

          await sendChannelMessage(config.channel_id, embed);
          
          await discordDb.logRaceDayWeatherNotification({
            guild_id: weatherConfig.guild_id,
            race_date: todayDateString,
            scheduled_for: scheduledTime.toISOString()
          });

          console.log(`Race-day weather notification sent for ${raceName} in guild ${weatherConfig.guild_id}`);
        } catch (error) {
          console.error(`Failed to send race-day weather notification for ${raceName}:`, error.message || error);
        }
      }
    }
  } catch (error) {
    console.error('Race-day weather notification worker error:', error.message || error);
  }
}

module.exports = { runWeatherNotifications, runRaceDayWeatherNotifications, sendWeatherNotificationNow };
