process.env.NODE_ENV = 'production';

require('dotenv').config();

const requiredEnvVars = [
  'PORT',
  'FRONTEND_URL',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_BOT_TOKEN',
  'DISCORD_REDIRECT_URI',
  'METEOBLUE_API_KEY'
];

const missingVars = requiredEnvVars.filter((key) => !process.env[key] || !String(process.env[key]).trim());

if (missingVars.length > 0) {
  console.error('Missing required environment variables for production:');
  missingVars.forEach((key) => console.error(`- ${key}`));
  process.exit(1);
}

if (process.env.ADMIN_USERNAME === 'admin' || process.env.ADMIN_PASSWORD === 'admin123') {
  console.error('Refusing to start in production with default admin credentials.');
  process.exit(1);
}

if (!process.env.CORS_ORIGIN) {
  process.env.CORS_ORIGIN = process.env.FRONTEND_URL;
}

const { startServer } = require('./server/index');

startServer().catch((error) => {
  console.error('Fatal production startup error:', error);
  process.exit(1);
});
