const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const adminDbPath = path.join(__dirname, '..', 'f1calendar-admin.db');
const adminDb = new sqlite3.Database(adminDbPath);

function initAdminDatabase() {
  return new Promise((resolve, reject) => {
    adminDb.run(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, async (err) => {
      if (err) return reject(err);

      try {
        await syncAdminFromEnv();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function syncAdminFromEnv() {
  return new Promise((resolve, reject) => {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin123';

    bcrypt.hash(password, 10)
      .then((password_hash) => {
        adminDb.run(
          `
            INSERT INTO admin_users (username, password_hash)
            VALUES (?, ?)
            ON CONFLICT(username)
            DO UPDATE SET password_hash = excluded.password_hash
          `,
          [username, password_hash],
          (upsertErr) => {
            if (upsertErr) return reject(upsertErr);
            console.log(`Admin user synced from env: ${username}`);
            resolve();
          }
        );
      })
      .catch(reject);
  });
}

function getAdminByUsername(username) {
  return new Promise((resolve, reject) => {
    adminDb.get('SELECT * FROM admin_users WHERE username = ?', [username], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function updateAdminPassword(username, password_hash) {
  return new Promise((resolve, reject) => {
    adminDb.run(
      'UPDATE admin_users SET password_hash = ? WHERE username = ?',
      [password_hash, username],
      function(err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

module.exports = {
  initAdminDatabase,
  getAdminByUsername,
  updateAdminPassword
};
