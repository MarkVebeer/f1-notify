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
        await ensureDefaultAdmin();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function ensureDefaultAdmin() {
  return new Promise((resolve, reject) => {
    adminDb.get('SELECT COUNT(*) as count FROM admin_users', async (err, row) => {
      if (err) return reject(err);

      if (row.count > 0) return resolve();

      const username = process.env.ADMIN_USERNAME || 'admin';
      const password = process.env.ADMIN_PASSWORD || 'admin123';
      const password_hash = await bcrypt.hash(password, 10);

      adminDb.run(
        'INSERT INTO admin_users (username, password_hash) VALUES (?, ?)',
        [username, password_hash],
        (insertErr) => {
          if (insertErr) return reject(insertErr);
          console.warn('Default admin created. Set ADMIN_USERNAME and ADMIN_PASSWORD in env for production.');
          resolve();
        }
      );
    });
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
