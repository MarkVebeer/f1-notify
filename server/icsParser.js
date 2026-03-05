const axios = require('axios');
const ical = require('node-ical');
const db = require('./db');
const countries = require('i18n-iso-countries');
const tzLookup = require('tz-lookup');

// Register English language for country name lookups
countries.registerLocale(require('i18n-iso-countries/langs/en.json'));

const ICS_URL = 'https://ics.ecal.com/ecal-sub/697a869dcce5a200022989fc/Formula%201.ics';
const LOCATIONS_URL = process.env.F1_LOCATIONS_URL || 'https://raw.githubusercontent.com/bacinger/f1-circuits/refs/heads/master/f1-locations.json';

let cachedLocations = null;

async function fetchF1Locations() {
  if (cachedLocations) {
    return cachedLocations;
  }
  
  try {
    console.log('Fetching F1 circuit locations...');
    const response = await axios.get(LOCATIONS_URL);
    cachedLocations = response.data;
    console.log(`Loaded ${Array.isArray(cachedLocations) ? cachedLocations.length : 0} circuit locations`);
    return cachedLocations;
  } catch (error) {
    console.error('Failed to fetch F1 locations, using fallback:', error.message);
    return [];
  }
}

function matchLocation(eventName, eventLocation, locationsData) {
  // locationsData is an array: [{location: "Melbourne", name: "Albert Park Circuit", id: "au-1953"}, ...]
  // eventLocation is country name like "Australia", "Brazil", "Netherlands" etc from ICS
  // eventName is like "Australian Grand Prix - Race"
  
  if (!Array.isArray(locationsData) || locationsData.length === 0) {
    return {
      country: eventLocation,
      city: null,
      circuit_name: null
    };
  }
  
  // Get country code from country name using i18n-iso-countries
  // This works dynamically for any country, no hardcoded mappings needed
  let countryCode = countries.getAlpha2Code(eventLocation, 'en');
  
  if (!countryCode) {
    // If standard lookup fails, try some common aliases
    const aliases = {
      'uae': 'ae',
      'united arab emirates': 'ae'
    };
    countryCode = aliases[eventLocation.toLowerCase()];
  }
  
  if (!countryCode) {
    // Country not recognized, return original
    return {
      country: eventLocation,
      city: null,
      circuit_name: null
    };
  }
  
  // Match by country code from JSON id field
  for (const circuit of locationsData) {
    const circuitId = (circuit.id || '').toLowerCase();
    const circuitCountryCode = circuitId.substring(0, 2);
    
    if (circuitCountryCode === countryCode.toLowerCase()) {
      return {
        country: eventLocation,
        city: circuit.location,
        circuit_name: circuit.name,
        lat: circuit.lat,
        lon: circuit.lon
      };
    }
  }
  
  // Fallback to original location
  return {
    country: eventLocation,
    city: null,
    circuit_name: null,
    lat: null,
    lon: null
  };
}

async function syncCalendar() {
  try {
    console.log('Fetching calendar from:', ICS_URL);
    
    // Fetch F1 locations first
    const locationsData = await fetchF1Locations();
    
    // Fetch ICS file
    const response = await axios.get(ICS_URL);
    const icsData = response.data;
    
    // Parse ICS data
    const events = await ical.async.parseICS(icsData);
    
    console.log(`Found ${Object.keys(events).length} events in calendar`);
    
    // Process and group events immediately
    const processedRaces = processAndGroupEvents(Object.values(events), locationsData);
    
    // Clear old data and save processed races directly to database
    console.log(`Saving ${processedRaces.length} processed races to database`);
    await db.clearAllRaces();
    
    for (const race of processedRaces) {
      await db.addRace(race);
    }
    
    console.log('Calendar sync completed successfully');
    return processedRaces;
  } catch (error) {
    console.error('Error syncing calendar:', error.message);
    throw error;
  }
}

function processAndGroupEvents(events, locationsData = []) {
  const races = [];
  const groupedByDate = {};
  
  // First pass: filter and organize events
  for (const event of events) {
    if (event.type === 'VEVENT') {
      const summary = event.summary || '';
      
      // Skip unwanted events
      if (summary.toLowerCase().includes('in your calendar')) {
        continue;
      }
      
      const eventDate = event.start ? new Date(event.start) : new Date();
      const eventEndDate = event.end ? new Date(event.end) : null;
      const dateKey = eventDate.toISOString().split('T')[0]; // YYYY-MM-DD
      
      if (!groupedByDate[dateKey]) {
        groupedByDate[dateKey] = [];
      }
      
      // Clean event name - extract just the Grand Prix and event type
      const cleanedName = cleanEventName(summary);
      
      // Match location with F1 circuits data
      const originalLocation = (event.location || '').trim();
      const locationMatch = matchLocation(cleanedName, originalLocation, locationsData);
      
      let timezone = null;
      if (locationMatch.lat !== null && locationMatch.lat !== undefined && locationMatch.lon !== null && locationMatch.lon !== undefined) {
        try {
          timezone = tzLookup(locationMatch.lat, locationMatch.lon);
        } catch (error) {
          console.warn('Failed to determine timezone for location:', locationMatch.city || locationMatch.country, error.message);
        }
      }

      const race = {
        name: cleanedName,
        location: locationMatch.country,
        city: locationMatch.city,
        circuit_name: locationMatch.circuit_name,
        lat: locationMatch.lat ?? null,
        lon: locationMatch.lon ?? null,
        timezone,
        date: eventDate.toISOString(),
        end_date: eventEndDate ? eventEndDate.toISOString() : null,
        type: determineRaceType(summary),
        ics_uid: event.uid || `${Date.now()}-${Math.random()}`,
        raw_summary: summary
      };
      
      groupedByDate[dateKey].push(race);
    }
  }
  
  // Second pass: merge grouped events by date and create final races
  for (const [date, dayEvents] of Object.entries(groupedByDate)) {
    // Sort by type priority for better organization
    dayEvents.sort((a, b) => getTypePriority(a.type) - getTypePriority(b.type));
    
    for (const event of dayEvents) {
      races.push(event);
    }
  }
  
  // Sort final races by date
  races.sort((a, b) => new Date(a.date) - new Date(b.date));
  
  return races;
}

function cleanEventName(summary) {
  let name = summary;
  
  // Remove everything before the first letter (emojis, spaces, etc.)
  name = name.replace(/^[^A-Za-z0-9]+/, '').trim();
  
  // Remove "Formula 1" or "F1" prefix (case insensitive)
  name = name.replace(/^(Formula\s*1|F1)\s*/i, '').trim();
  
  // Remove event type suffixes and everything after them
  name = name.replace(/\s*-\s*(Practice|Qualifying|Sprint|Race|Quali|FP\d+).*$/gi, '');
  name = name.replace(/\s+(Practice|Qualifying|Sprint|Race|Quali|FP\d+).*$/gi, '');
  
  // Remove trailing numbers and extra whitespace
  name = name.replace(/\s+\d+\s*$/g, '').trim();
  
  return name || summary;
}

function determineRaceType(summary) {
  const lower = summary.toLowerCase();
  if (lower.includes('practice') || lower.includes('fp')) {
    return 'practice';
  } else if (lower.includes('qualifying') || lower.includes('quali')) {
    return 'qualifying';
  } else if (lower.includes('sprint')) {
    return 'sprint';
  } else if (lower.includes('race') || lower.includes('grand prix') || lower.includes('gp')) {
    return 'race';
  }
  return 'other';
}

function getTypePriority(type) {
  const priority = {
    'practice': 1,
    'qualifying': 2,
    'sprint': 3,
    'race': 4,
    'other': 5
  };
  return priority[type] || 5;
}

module.exports = {
  syncCalendar
};
