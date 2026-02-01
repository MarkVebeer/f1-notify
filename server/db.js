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
        date TEXT NOT NULL,
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
        resolve();
      });
    });
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
        SELECT id, name, location, city, circuit_name, date, type, created_at, 'race' as source
        FROM races
        UNION ALL
        SELECT id, name, location, NULL as city, NULL as circuit_name, date, type, created_at, 'custom' as source
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
function addRace({ name, location, date, type, ics_uid, raw_summary, city, circuit_name }) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO races (name, location, date, type, ics_uid, raw_summary, city, circuit_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(name, location, date, type, ics_uid, raw_summary || null, city || null, circuit_name || null, function(err) {
      if (err) reject(err);
      else resolve(this.lastID);
    });
    
    stmt.finalize();
  });
}

// Add a custom event
function addCustomEvent({ name, location, date, type, description }) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(`
      INSERT INTO custom_events (name, location, date, type, description)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(name, location, date, type || 'custom', description || null, function(err) {
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
        SELECT id, name, location, date, type, created_at, 'race' as source
        FROM races
        WHERE date BETWEEN ? AND ?
        UNION ALL
        SELECT id, name, location, date, type, created_at, 'custom' as source
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
