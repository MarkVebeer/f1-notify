const cron = require('node-cron');
const { syncCalendar } = require('./icsParser');
const { runDiscordNotifications } = require('./discordWorker');
const { runWeatherNotifications, runRaceDayWeatherNotifications } = require('./weatherWorker');

function startScheduler() {
  // Run calendar sync every hour at minute 0
  cron.schedule('0 * * * *', async () => {
    console.log('Running scheduled calendar sync...');
    try {
      await syncCalendar();
      console.log('Scheduled sync completed');
    } catch (error) {
      console.error('Scheduled sync failed:', error);
    }
  });

  // Run Discord notifications check every minute
  cron.schedule('* * * * *', async () => {
    try {
      await runDiscordNotifications();
      await runWeatherNotifications();
      await runRaceDayWeatherNotifications();
    } catch (error) {
      console.error('Discord notification check failed:', error);
    }
  });
  
  console.log('Cron scheduler initialized - calendar sync hourly, Discord notifications every minute');
}

module.exports = {
  startScheduler
};
