const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'f1calendar.db');
const db = new sqlite3.Database(dbPath);

// Initialize database
function initDatabase() {
  return new Promise((resolve, reject) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS races (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        location TEXT,
        city TEXT,
        circuit_name TEXT,
        lat REAL,
        lon REAL,
        timezone TEXT,
        date TEXT NOT NULL,
        end_date TEXT,
        type TEXT,
        ics_uid TEXT UNIQUE,
        raw_summary TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) return reject(err);

      db.run(`
        CREATE TABLE IF NOT EXISTS custom_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          location TEXT,
          date TEXT NOT NULL,
          end_date TEXT,
          type TEXT DEFAULT 'custom',
          description TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (customErr) => {
        if (customErr) return reject(customErr);

        // Add raw_summary column if it doesn't exist
        addRawSummaryColumn();
        // Add city and circuit_name columns if they don't exist
        addCityAndCircuitColumns();
        // Add lat/lon/timezone columns if they don't exist
        addLatLonTimezoneColumns();
        // Add end_date column if it doesn't exist
        addEndDateColumn();
        // Add end_date column to custom_events if it doesn't exist
        addCustomEndDateColumn();
        resolve();
      });
    });
  });
}

function addEndDateColumn() {
  db.all("PRAGMA table_info(races)", (err, columns) => {
    if (err) {
      console.error('Error checking table structure:', err);
      return;
    }

    const hasEndDate = columns.some(col => col.name === 'end_date');
    if (!hasEndDate) {
      db.run("ALTER TABLE races ADD COLUMN end_date TEXT", (alterErr) => {
        if (alterErr) {
          console.error('Error adding end_date column:', alterErr);
        } else {
          console.log('Successfully added end_date column');
        }
      });
    }
  });
}

function addCustomEndDateColumn() {
  db.all("PRAGMA table_info(custom_events)", (err, columns) => {
    if (err) {
      console.error('Error checking custom_events table structure:', err);
      return;
    }

    const hasEndDate = columns.some(col => col.name === 'end_date');
    if (!hasEndDate) {
      db.run("ALTER TABLE custom_events ADD COLUMN end_date TEXT", (alterErr) => {
        if (alterErr) {
          console.error('Error adding end_date column to custom_events:', alterErr);
        } else {
          console.log('Successfully added end_date column to custom_events');
        }
      });
    }
  });
}

// Add raw_summary column if it doesn't exist
function addRawSummaryColumn() {
  db.all("PRAGMA table_info(races)", (err, columns) => {
    if (err) {
      console.error('Error checking table structure:', err);
      return;
    }
    
    const hasRawSummary = columns.some(col => col.name === 'raw_summary');
    if (!hasRawSummary) {
      db.run("ALTER TABLE races ADD COLUMN raw_summary TEXT", (err) => {
        if (err) {
          console.error('Error adding raw_summary column:', err);
        } else {
          console.log('Successfully added raw_summary column');
        }
      });
    }
  });
}

// Add city and circuit_name columns if they don't exist
function addCityAndCircuitColumns() {
  db.all("PRAGMA table_info(races)", (err, columns) => {
    if (err) {
      console.error('Error checking table structure:', err);
      return;
    }
    
    const hasCity = columns.some(col => col.name === 'city');
    const hasCircuitName = columns.some(col => col.name === 'circuit_name');
    
    if (!hasCity) {
      db.run("ALTER TABLE races ADD COLUMN city TEXT", (err) => {
        if (err) {
          console.error('Error adding city column:', err);
        } else {
          console.log('Successfully added city column');
        }
      });
    }
    
    if (!hasCircuitName) {
      db.run("ALTER TABLE races ADD COLUMN circuit_name TEXT", (err) => {
        if (err) {
          console.error('Error adding circuit_name column:', err);
        } else {
          console.log('Successfully added circuit_name column');
        }
      });
    }
  });
}

// Add lat, lon, and timezone columns if they don't exist
function addLatLonTimezoneColumns() {
  db.all("PRAGMA table_info(races)", (err, columns) => {
    if (err) {
      console.error('Error checking table structure:', err);
      return;
    }

    const hasLat = columns.some(col => col.name === 'lat');
    const hasLon = columns.some(col => col.name === 'lon');
    const hasTimezone = columns.some(col => col.name === 'timezone');

    if (!hasLat) {
      db.run("ALTER TABLE races ADD COLUMN lat REAL", (err) => {
        if (err) {
          console.error('Error adding lat column:', err);
        } else {
          console.log('Successfully added lat column');
        }
      });
    }

    if (!hasLon) {
      db.run("ALTER TABLE races ADD COLUMN lon REAL", (err) => {
        if (err) {
          console.error('Error adding lon column:', err);
        } else {
          console.log('Successfully added lon column');
        }
      });
    }

    if (!hasTimezone) {
      db.run("ALTER TABLE races ADD COLUMN timezone TEXT", (err) => {
        if (err) {
          console.error('Error adding timezone column:', err);
        } else {
          console.log('Successfully added timezone column');
        }
      });
    }
  });
}

// Get all races
function getAllRaces() {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM races ORDER BY date ASC', (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Get all events (races + custom events)
function getAllEvents() {
  return new Promise((resolve, reject) => {
    db.all(
      `
        SELECT id, name, location, city, circuit_name, lat, lon, timezone, date, end_date, type, created_at, 'race' as source
        FROM races
        UNION ALL
        SELECT id, name, location, NULL as city, NULL as circuit_name, NULL as lat, NULL as lon, NULL as timezone, date, end_date, type, created_at, 'custom' as source
        FROM custom_events
        ORDER BY date ASC
      `,
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

// Add a race
function addRace({ name, location, date, end_date, type, ics_uid, raw_summary, city, circuit_name, lat, lon, timezone }) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO races (name, location, date, end_date, type, ics_uid, raw_summary, city, circuit_name, lat, lon, timezone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(name, location, date, end_date || null, type, ics_uid, raw_summary || null, city || null, circuit_name || null, lat ?? null, lon ?? null, timezone || null, function(err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });
    
    stmt.finalize();
  });
}

// Add a custom event
function addCustomEvent({ name, location, date, end_date, type, description }) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(`
      INSERT INTO custom_events (name, location, date, end_date, type, description)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(name, location, date, end_date || null, type || 'custom', description || null, function(err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });

    stmt.finalize();
  });
}

function getUpcomingRaces(windowHours = 72) {
  return new Promise((resolve, reject) => {
    const now = new Date();
    const until = new Date(now.getTime() + windowHours * 60 * 60 * 1000);
    db.all(
      'SELECT * FROM races WHERE type = ? AND date BETWEEN ? AND ? ORDER BY date ASC',
      ['race', now.toISOString(), until.toISOString()],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

function getUpcomingEvents(windowHours = 72) {
  return new Promise((resolve, reject) => {
    // Look back 5 minutes to catch events that are about to happen or just starting
    const now = new Date();
    const lookbackMs = 5 * 60 * 1000; // 5 minutes back
    const from = new Date(now.getTime() - lookbackMs);
    const until = new Date(now.getTime() + windowHours * 60 * 60 * 1000);
    db.all(
      `
        SELECT id, name, location, city, circuit_name, lat, lon, timezone, date, end_date, type, created_at, 'race' as source
        FROM races
        WHERE date BETWEEN ? AND ?
        UNION ALL
        SELECT id, name, location, NULL as city, NULL as circuit_name, NULL as lat, NULL as lon, NULL as timezone, date, end_date, type, created_at, 'custom' as source
        FROM custom_events
        WHERE date BETWEEN ? AND ?
        ORDER BY date ASC
      `,
      [from.toISOString(), until.toISOString(), from.toISOString(), until.toISOString()],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

// Delete a custom event
function deleteCustomEvent(id) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM custom_events WHERE id = ?', id, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Delete a race
function deleteRace(id) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM races WHERE id = ?', id, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Clear all races (for sync)
function clearAllRaces() {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM races', (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

module.exports = {
  initDatabase,
  getAllRaces,
  getAllEvents,
  addRace,
  addCustomEvent,
  deleteRace,
  deleteCustomEvent,
  clearAllRaces,
  getUpcomingRaces,
  getUpcomingEvents
};
