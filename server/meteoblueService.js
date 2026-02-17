const axios = require('axios');

const METEOBLUE_SEARCH_URL = 'https://www.meteoblue.com/en/server/search/query3';
const METEOBLUE_PACKAGES_URL = 'https://my.meteoblue.com/packages';

function getApiKey() {
  const key = process.env.METEOBLUE_API_KEY;
  if (!key) {
    throw new Error('Missing METEOBLUE_API_KEY');
  }
  return key;
}

async function searchLocation(query) {
  const apikey = getApiKey();
  const response = await axios.get(METEOBLUE_SEARCH_URL, {
    params: {
      query,
      apikey,
      itemsPerPage: 1
    }
  });

  const result = response.data?.results?.[0];
  if (!result) {
    throw new Error('Location not found');
  }

  return result;
}

async function fetchBasicDayForecast({ lat, lon, asl, tz, name }) {
  const apikey = getApiKey();
  const params = {
    lat,
    lon,
    format: 'json',
    windspeed: 'kmh',
    apikey
  };

  if (asl !== undefined && asl !== null && asl !== '') {
    params.asl = asl;
  }
  if (tz) {
    params.tz = tz;
  }
  if (name) {
    params.name = name;
  }

  const response = await axios.get(`${METEOBLUE_PACKAGES_URL}/basic-day`, { params });
  return response.data;
}

function buildMeteogramImageUrl({ lat, lon, asl, tz, name, forecastDays = 1, time = null }) {
  const apikey = getApiKey();
  const params = new URLSearchParams({
    lat,
    lon,
    forecast_days: String(forecastDays),
    apikey
  });

  if (asl !== undefined && asl !== null && asl !== '') {
    params.set('asl', asl);
  }
  if (tz) {
    params.set('tz', tz);
  }
  if (name) {
    params.set('location_name', name);
  }
  if (time) {
    params.set('time', time);
  }

  return `https://my.meteoblue.com/images/meteogram?${params.toString()}`;
}

function pickDayForecast(forecast, dateString) {
  const dataDay = forecast?.data_day;
  if (!dataDay || !Array.isArray(dataDay.time)) {
    throw new Error('Forecast data missing');
  }

  const index = dataDay.time.findIndex((date) => date === dateString);
  if (index === -1) {
    return null;
  }

  const values = {};
  const pick = (key, alias = key) => {
    if (Array.isArray(dataDay[key])) {
      values[alias] = dataDay[key][index];
    }
  };

  pick('temperature_max');
  pick('temperature_min');
  pick('temperature_mean');
  pick('precipitation_sum');
  pick('precipitation');
  pick('precipitation_probability');
  pick('windspeed_mean');
  pick('windspeed_max');
  pick('winddirection_mean');
  pick('sunshine');
  pick('pictocode');

  return {
    values,
    units: forecast?.units || {},
    index
  };
}

module.exports = {
  searchLocation,
  fetchBasicDayForecast,
  pickDayForecast,
  buildMeteogramImageUrl
};
