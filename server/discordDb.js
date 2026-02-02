const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const discordDbPath = path.join(__dirname, '..', 'f1calendar-discord.db');
const discordDb = new sqlite3.Database(discordDbPath);

function initDiscordDatabase() {
  return new Promise((resolve, reject) => {
    discordDb.run(`
      CREATE TABLE IF NOT EXISTS discord_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_id TEXT UNIQUE NOT NULL,
        username TEXT NOT NULL,
        avatar TEXT,
        access_token TEXT,
        refresh_token TEXT,
        token_expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (userErr) => {
      if (userErr) return reject(userErr);

      discordDb.run(`
        CREATE TABLE IF NOT EXISTS discord_configs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT UNIQUE NOT NULL,
          channel_id TEXT NOT NULL,
          lead_minutes INTEGER NOT NULL DEFAULT 60,
          timezone TEXT NOT NULL DEFAULT 'UTC',
          role_id TEXT,
          role_map TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (configErr) => {
        if (configErr) return reject(configErr);

        discordDb.run(`
          CREATE TABLE IF NOT EXISTS discord_notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT NOT NULL,
            lead_minutes INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (guild_id) REFERENCES discord_configs(guild_id) ON DELETE CASCADE
          )
        `, (notifErr) => {
          if (notifErr) return reject(notifErr);

          discordDb.run(`
            CREATE TABLE IF NOT EXISTS discord_notify_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              race_id INTEGER NOT NULL,
              guild_id TEXT NOT NULL,
              channel_id TEXT NOT NULL,
              lead_minutes INTEGER NOT NULL,
              scheduled_for TEXT NOT NULL,
              sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
          `, (logErr) => {
            if (logErr) return reject(logErr);

            discordDb.run(`
              CREATE TABLE IF NOT EXISTS discord_weather_settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guild_id TEXT UNIQUE NOT NULL,
                days_before INTEGER NOT NULL DEFAULT 1,
                hour INTEGER NOT NULL DEFAULT 18,
                enabled INTEGER NOT NULL DEFAULT 0,
                race_day_lead_minutes INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
              )
            `, (weatherErr) => {
              if (weatherErr) return reject(weatherErr);

              discordDb.run(`
                CREATE TABLE IF NOT EXISTS discord_weather_log (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  guild_id TEXT NOT NULL,
                  weekend_key TEXT NOT NULL,
                  scheduled_for TEXT NOT NULL,
                  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
              `, (weatherLogErr) => {
                if (weatherLogErr) return reject(weatherLogErr);

                discordDb.run(`
                  CREATE TABLE IF NOT EXISTS discord_race_day_weather_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    guild_id TEXT NOT NULL,
                    race_date TEXT NOT NULL,
                    scheduled_for TEXT NOT NULL,
                    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
                  )
                `, (raceDayWeatherLogErr) => {
                  if (raceDayWeatherLogErr) return reject(raceDayWeatherLogErr);

                  // Migration: Add role_id column if it doesn't exist
                  addRoleIdColumn()
                    .then(() => addRoleMapColumn())
                    .then(() => addLeadMinutesToLog())
                    .then(() => addEventTypesColumn())
                    .then(() => addRaceDayLeadMinutesColumn())
                    .then(() => resolve())
                    .catch((err) => {
                      console.warn('Migration warning (safe to ignore):', err.message);
                      resolve(); // Continue even if column exists
                    });
                });
              });
            });
          });
        });
      });
    });
  });
}

// Migration: Add role_id column if it doesn't exist
function addRoleIdColumn() {
  return new Promise((resolve, reject) => {
    discordDb.all("PRAGMA table_info(discord_configs)", (err, columns) => {
      if (err) return reject(err);
      
      const hasRoleId = columns.some(col => col.name === 'role_id');
      if (!hasRoleId) {
        discordDb.run("ALTER TABLE discord_configs ADD COLUMN role_id TEXT", (err) => {
          if (err) return reject(err);
          console.log('Successfully added role_id column to discord_configs');
          resolve();
        });
      } else {
        resolve();
      }
    });
  });
}

// Migration: Add role_map column if it doesn't exist
function addRoleMapColumn() {
  return new Promise((resolve, reject) => {
    discordDb.all("PRAGMA table_info(discord_configs)", (err, columns) => {
      if (err) return reject(err);

      const hasRoleMap = columns.some(col => col.name === 'role_map');
      if (!hasRoleMap) {
        discordDb.run("ALTER TABLE discord_configs ADD COLUMN role_map TEXT", (err) => {
          if (err) return reject(err);
          console.log('Successfully added role_map column to discord_configs');
          resolve();
        });
      } else {
        resolve();
      }
    });
  });
}

// Migration: Add event_types column if it doesn't exist
function addEventTypesColumn() {
  return new Promise((resolve, reject) => {
    discordDb.all("PRAGMA table_info(discord_notifications)", (err, columns) => {
      if (err) return reject(err);
      
      const hasEventTypes = columns.some(col => col.name === 'event_types');
      if (!hasEventTypes) {
        discordDb.run("ALTER TABLE discord_notifications ADD COLUMN event_types TEXT DEFAULT '[\"race\",\"practice\",\"qualifying\",\"sprint\",\"custom\"]'", (err) => {
          if (err) return reject(err);
          console.log('Successfully added event_types column to discord_notifications');
          resolve();
        });
      } else {
        resolve();
      }
    });
  });
}

// Migration: Add lead_minutes to notify_log
function addLeadMinutesToLog() {
  return new Promise((resolve, reject) => {
    discordDb.all("PRAGMA table_info(discord_notify_log)", (err, columns) => {
      if (err) return reject(err);
      
      const hasLeadMinutes = columns.some(col => col.name === 'lead_minutes');
      if (!hasLeadMinutes) {
        discordDb.run("ALTER TABLE discord_notify_log ADD COLUMN lead_minutes INTEGER DEFAULT 0", (err) => {
          if (err) return reject(err);
          console.log('Successfully added lead_minutes column to discord_notify_log');
          resolve();
        });
      } else {
        resolve();
      }
    });
  });
}

// Migration: Add race_day_lead_minutes to weather_settings
function addRaceDayLeadMinutesColumn() {
  return new Promise((resolve, reject) => {
    discordDb.all("PRAGMA table_info(discord_weather_settings)", (err, columns) => {
      if (err) return reject(err);
      
      const hasRaceDayLeadMinutes = columns.some(col => col.name === 'race_day_lead_minutes');
      if (!hasRaceDayLeadMinutes) {
        discordDb.run("ALTER TABLE discord_weather_settings ADD COLUMN race_day_lead_minutes INTEGER", (err) => {
          if (err) return reject(err);
          console.log('Successfully added race_day_lead_minutes column to discord_weather_settings');
          resolve();
        });
      } else {
        resolve();
      }
    });
  });
}

function upsertDiscordUser({ discord_id, username, avatar, access_token, refresh_token, token_expires_at }) {
  return new Promise((resolve, reject) => {
    const stmt = discordDb.prepare(`
      INSERT INTO discord_users (discord_id, username, avatar, access_token, refresh_token, token_expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(discord_id) DO UPDATE SET
        username = excluded.username,
        avatar = excluded.avatar,
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        token_expires_at = excluded.token_expires_at
    `);

    stmt.run(discord_id, username, avatar, access_token, refresh_token, token_expires_at, function(err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });

    stmt.finalize();
  });
}

function getDiscordUserById(discord_id) {
  return new Promise((resolve, reject) => {
    discordDb.get('SELECT * FROM discord_users WHERE discord_id = ?', [discord_id], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function upsertDiscordConfig({ guild_id, channel_id, lead_minutes, timezone, role_id, role_map }) {
  return new Promise((resolve, reject) => {
    const stmt = discordDb.prepare(`
      INSERT INTO discord_configs (guild_id, channel_id, lead_minutes, timezone, role_id, role_map, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        lead_minutes = excluded.lead_minutes,
        timezone = excluded.timezone,
        role_id = excluded.role_id,
        role_map = excluded.role_map,
        updated_at = CURRENT_TIMESTAMP
    `);

    const roleMapJson = role_map ? JSON.stringify(role_map) : null;
    stmt.run(guild_id, channel_id, lead_minutes, timezone, role_id, roleMapJson, function(err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });

    stmt.finalize();
  });
}

function getDiscordConfigByGuild(guild_id) {
  return new Promise((resolve, reject) => {
    discordDb.get('SELECT * FROM discord_configs WHERE guild_id = ?', [guild_id], (err, row) => {
      if (err) reject(err);
      else resolve(normalizeRoleMap(row));
    });
  });
}

function getDiscordConfigByChannelId(channel_id) {
  return new Promise((resolve, reject) => {
    discordDb.get('SELECT * FROM discord_configs WHERE channel_id = ?', [channel_id], (err, row) => {
      if (err) reject(err);
      else resolve(normalizeRoleMap(row));
    });
  });
}

function getDiscordConfigs() {
  return new Promise((resolve, reject) => {
    discordDb.all('SELECT * FROM discord_configs', (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(normalizeRoleMap));
    });
  });
}

function normalizeRoleMap(row) {
  if (!row) return row;
  let roleMap = null;
  if (typeof row.role_map === 'string' && row.role_map.trim() !== '') {
    try {
      roleMap = JSON.parse(row.role_map);
    } catch {
      roleMap = null;
    }
  }
  return { ...row, role_map: roleMap || {} };
}

function wasDiscordNotified({ guild_id, race_id, lead_minutes }) {
  return new Promise((resolve, reject) => {
    discordDb.get(
      'SELECT id FROM discord_notify_log WHERE guild_id = ? AND race_id = ? AND lead_minutes = ? LIMIT 1',
      [guild_id, race_id, lead_minutes],
      (err, row) => {
        if (err) reject(err);
        else resolve(Boolean(row));
      }
    );
  });
}

function logDiscordNotification({ guild_id, race_id, channel_id, lead_minutes, scheduled_for }) {
  return new Promise((resolve, reject) => {
    const stmt = discordDb.prepare(`
      INSERT INTO discord_notify_log (guild_id, race_id, channel_id, lead_minutes, scheduled_for)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(guild_id, race_id, channel_id, lead_minutes, scheduled_for, function(err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });

    stmt.finalize();
  });
}

// Notification CRUD
function addNotification({ guild_id, lead_minutes, event_types = ['race', 'practice', 'qualifying', 'sprint', 'custom'] }) {
  return new Promise((resolve, reject) => {
    const stmt = discordDb.prepare(`
      INSERT INTO discord_notifications (guild_id, lead_minutes, event_types)
      VALUES (?, ?, ?)
    `);

    const eventTypesJson = JSON.stringify(event_types);
    stmt.run(guild_id, lead_minutes, eventTypesJson, function(err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });

    stmt.finalize();
  });
}

function getNotificationsByGuild(guild_id) {
  return new Promise((resolve, reject) => {
    discordDb.all(
      'SELECT * FROM discord_notifications WHERE guild_id = ? ORDER BY lead_minutes ASC',
      [guild_id],
      (err, rows) => {
        if (err) reject(err);
        else {
          // Parse event_types JSON
          const parsed = rows.map(row => ({
            ...row,
            event_types: row.event_types ? JSON.parse(row.event_types) : ['race', 'practice', 'qualifying', 'sprint', 'custom']
          }));
          resolve(parsed);
        }
      }
    );
  });
}

function deleteNotification(id) {
  return new Promise((resolve, reject) => {
    discordDb.run('DELETE FROM discord_notifications WHERE id = ?', [id], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function clearNotificationsByGuild(guild_id) {
  return new Promise((resolve, reject) => {
    discordDb.run('DELETE FROM discord_notifications WHERE guild_id = ?', [guild_id], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function upsertWeatherConfig({ guild_id, days_before, hour, enabled, race_day_lead_minutes }) {
  return new Promise((resolve, reject) => {
    const stmt = discordDb.prepare(`
      INSERT INTO discord_weather_settings (guild_id, days_before, hour, enabled, race_day_lead_minutes, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(guild_id) DO UPDATE SET
        days_before = excluded.days_before,
        hour = excluded.hour,
        enabled = excluded.enabled,
        race_day_lead_minutes = excluded.race_day_lead_minutes,
        updated_at = CURRENT_TIMESTAMP
    `);

    const enabledValue = enabled ? 1 : 0;
    stmt.run(guild_id, days_before, hour, enabledValue, race_day_lead_minutes || null, function(err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });

    stmt.finalize();
  });
}

function getWeatherConfigByGuild(guild_id) {
  return new Promise((resolve, reject) => {
    discordDb.get('SELECT * FROM discord_weather_settings WHERE guild_id = ?', [guild_id], (err, row) => {
      if (err) reject(err);
      else resolve(row ? { ...row, enabled: Boolean(row.enabled) } : null);
    });
  });
}

function getWeatherConfigs() {
  return new Promise((resolve, reject) => {
    discordDb.all('SELECT * FROM discord_weather_settings', (err, rows) => {
      if (err) reject(err);
      else resolve(rows.map(row => ({ ...row, enabled: Boolean(row.enabled) })));
    });
  });
}

function wasWeatherNotified({ guild_id, weekend_key }) {
  return new Promise((resolve, reject) => {
    discordDb.get(
      'SELECT id FROM discord_weather_log WHERE guild_id = ? AND weekend_key = ? LIMIT 1',
      [guild_id, weekend_key],
      (err, row) => {
        if (err) reject(err);
        else resolve(Boolean(row));
      }
    );
  });
}

function logWeatherNotification({ guild_id, weekend_key, scheduled_for }) {
  return new Promise((resolve, reject) => {
    const stmt = discordDb.prepare(`
      INSERT INTO discord_weather_log (guild_id, weekend_key, scheduled_for)
      VALUES (?, ?, ?)
    `);

    stmt.run(guild_id, weekend_key, scheduled_for, function(err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });

    stmt.finalize();
  });
}

function wasRaceDayWeatherNotified({ guild_id, race_date }) {
  return new Promise((resolve, reject) => {
    discordDb.get(
      'SELECT id FROM discord_race_day_weather_log WHERE guild_id = ? AND race_date = ? LIMIT 1',
      [guild_id, race_date],
      (err, row) => {
        if (err) reject(err);
        else resolve(Boolean(row));
      }
    );
  });
}

function logRaceDayWeatherNotification({ guild_id, race_date, scheduled_for }) {
  return new Promise((resolve, reject) => {
    const stmt = discordDb.prepare(`
      INSERT INTO discord_race_day_weather_log (guild_id, race_date, scheduled_for)
      VALUES (?, ?, ?)
    `);

    stmt.run(guild_id, race_date, scheduled_for, function(err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });

    stmt.finalize();
  });
}

module.exports = {
  initDiscordDatabase,
  upsertDiscordUser,
  getDiscordUserById,
  upsertDiscordConfig,
  getDiscordConfigByGuild,
  getDiscordConfigByChannelId,
  getDiscordConfigs,
  wasDiscordNotified,
  logDiscordNotification,
  addNotification,
  getNotificationsByGuild,
  deleteNotification,
  clearNotificationsByGuild,
  upsertWeatherConfig,
  getWeatherConfigByGuild,
  getWeatherConfigs,
  wasWeatherNotified,
  logWeatherNotification,
  wasRaceDayWeatherNotified,
  logRaceDayWeatherNotification
};
