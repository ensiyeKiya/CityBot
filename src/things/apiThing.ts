/**
 * API Thing — aggregates live external feeds: OpenWeatherMap (current
 * conditions) and Nominatim (two-way geocoding). The multi-operator
 * environmental sensor network actions (loadSensors / filterSensors /
 * removeSensors) are currently disabled; their TD definitions are kept below
 * as comments and the handler implementations are preserved in git history
 * (src/index.ts before the Domain Things split).
 */

import fetch from 'node-fetch';
import { tracer, THING_IDS, SECURITY_SCHEME, USER_AGENT, httpForm, mqttEventForm } from './shared';

const TITLE = 'api';

// OpenWeatherMap API types
interface WeatherData {
  name: string;
  sys: {
    country: string;
  };
  main: {
    temp: number;
    feels_like: number;
    humidity: number;
    pressure: number;
  };
  weather: Array<{
    main: string;
    description: string;
  }>;
  wind: {
    speed: number;
  };
}

// Create a reusable function for fetching weather
async function fetchWeather(location: string) {
  const span = tracer.startSpan('fetchWeather', { attributes: { location } });
  try {
    // Use provided API key or fallback to environment variable or default
    const openWeatherApiKey = process.env.OPENWEATHER_API_KEY;

    // Call to OpenWeatherMap API with location name
    const weatherUrl = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&units=metric&appid=${openWeatherApiKey}`;
    const response = await fetch(weatherUrl);

    if (!response.ok) {
      if (response.status === 404) {
        return {
          error: true,
          message: `Location not found: ${location}`
        };
      }
      throw new Error(`OpenWeatherMap API error: ${response.status}`);
    }

    const data = await response.json() as WeatherData;

    // Format the response
    return {
      location: `${data.name}, ${data.sys.country}`,
      temperature: data.main.temp,
      feelsLike: data.main.feels_like,
      conditions: {
        main: data.weather[0].main,
        description: data.weather[0].description
      },
      humidity: data.main.humidity,
      windSpeed: data.wind.speed,
      pressure: data.main.pressure,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error("Error getting weather:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      error: true,
      message: `Failed to get weather: ${errorMessage}`
    };
  } finally {
    span.end();
  }
}

export async function exposeApiThing(WoT: any): Promise<any> {
  const thing = await WoT.produce({
    id: THING_IDS.api,
    title: TITLE,
    description: 'API Thing: live external feeds — OpenWeatherMap current conditions, Nominatim two-way geocoding, and the environmental sensor network',
    ...SECURITY_SCHEME,
    properties: {
      weather: {
        description: 'Get weather for a location',
        type: 'object',
        forms: httpForm(TITLE, 'properties', 'weather', ['readproperty'])
      }
    },
    events: {
      sensorsChanged: {
        title: "Sensors Changed",
        description: "Fires when environmental sensors are loaded, removed, or filtered on the map",
        data: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["load", "filter", "remove"], description: "Action performed on sensors" },
            operator: { type: "string", description: "Sensor operator (data source)" },
            parameter: { type: "string", description: "Environmental parameter being displayed" },
            sensors: { type: "array", description: "Array of sensor GeoJSON features with properties and coordinates" },
            filterType: { type: "string", description: "Type of filter applied" },
            filterValue: { type: "string", description: "Filter value" },
            sensorCount: { type: "number", description: "Number of sensors affected" },
            show: { type: "boolean", description: "Whether sensors should be visible" },
            timestamp: { type: "string", format: "date-time" }
          },
          required: ["action"]
        },
        forms: mqttEventForm(TITLE, 'sensorsChanged')
      }
    },
    actions: {
      getWeather: {
        description: 'Retrieves current weather conditions (temperature, humidity, wind, conditions) for a specified location. Accepts city names, addresses, or landmarks.',
        input: {
          type: 'object',
          properties: {
            location: { type: 'string' }
          },
          required: ['location']
        },
        output: { type: 'object' },
        forms: httpForm(TITLE, 'actions', 'getWeather', ['invokeaction'])
      },
      getCoordinates: {
        description: 'Converts a location name (city, landmark, address) into geographic coordinates (latitude, longitude). Call this before flyTo or setCameraView when you only have a location name. Returns coordinates with proper decimal formatting (e.g., 48.8566, not 48588897). Latitude range: -90 to 90. Longitude range: -180 to 180.',
        input: {
          type: 'object',
          properties: {
            location: { type: 'string' }
          },
          required: ['location']
        },
        output: { type: 'object' },
        forms: httpForm(TITLE, 'actions', 'getCoordinates', ['invokeaction'])
      },
      reverseGeocode: {
        description: 'Converts coordinates into a human-readable location name (city, country, address). Use this when the user asks about the current map location (e.g., "where are we?", "what location is this?"). Always use coordinates from currentMapState for current location queries.',
        input: {
          type: 'object',
          properties: {
            latitude: { type: 'number' },
            longitude: { type: 'number' }
          },
          required: ['latitude', 'longitude']
        },
        output: { type: 'object' },
        forms: httpForm(TITLE, 'actions', 'reverseGeocode', ['invokeaction'])
      }
      // loadSensors / filterSensors / removeSensors: disabled sensor-network
      // actions. TD definitions and handler implementations are preserved in
      // git history (src/index.ts prior to the Domain Things split).
    }
  });

  thing.setActionHandler('getWeather', async (params: any) => {
    const span = tracer.startSpan('getWeather');
    try {
      // Attempt to extract the actual input data via a helper function
      let input;
      if (params && typeof params.value === "function") {
        input = await params.value();
      } else {
        input = params;
      }

      if (!input || !input.location) {
        return { error: true, message: "Location parameter missing" };
      }

      // Enhanced input validation and sanitization
      const location = String(input.location).trim();
      if (location.length === 0) {
        return { error: true, message: "Location cannot be empty" };
      }

      if (location.length > 100) {
        return { error: true, message: "Location name too long (max 100 characters)" };
      }

      // Validate location format - allow Unicode characters for international location names
      const locationPattern = /^[\p{L}\p{N}\s,.-]+$/u;
      if (!locationPattern.test(location)) {
        return { error: true, message: "Invalid location format" };
      }

      return await fetchWeather(location);
    } catch (error) {
      console.error("Error in getWeather handler:", error);
      return { error: true, message: "Failed to get weather information" };
    } finally {
      span.end();
    }
  });

  thing.setActionHandler('getCoordinates', async (params: any) => {
    const span = tracer.startSpan('getCoordinates');
    try {
      let input;
      if (params && typeof params.value === "function") {
        input = await params.value();
      } else {
        input = params;
      }

      if (!input || !input.location) {
        return { error: true, message: "Location parameter missing" };
      }

      // Enhanced input validation and sanitization
      const location = String(input.location).trim();
      if (location.length === 0) {
        return { error: true, message: "Location cannot be empty" };
      }

      if (location.length > 100) {
        return { error: true, message: "Location name too long (max 100 characters)" };
      }

      // Validate location format - allow Unicode characters for international location names
      const locationPattern = /^[\p{L}\p{N}\s,.-]+$/u;
      if (!locationPattern.test(location)) {
        return { error: true, message: "Invalid location format" };
      }

      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(location)}`;
      const headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
      };

      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`OpenStreetMap API error: ${response.status}`);
      }

      const data = await response.json();

      if (!data || data.length === 0) {
        return {
          error: true,
          message: `No coordinates found for location: ${location}`
        };
      }

      const result = data[0];

      // Validate coordinate data from API response
      if (!result.lat || !result.lon ||
          isNaN(parseFloat(result.lat)) || isNaN(parseFloat(result.lon))) {
        return {
          error: true,
          message: "Invalid coordinate data received from geocoding service"
        };
      }

      const coordinates = {
        latitude: parseFloat(result.lat),
        longitude: parseFloat(result.lon),
        height: 100000 // Higher default height to avoid horizon clipping
      };

      return {
        success: true,
        location: location,
        displayName: result.display_name,
        coordinates: coordinates,
        formatted: `Latitude: ${coordinates.latitude.toFixed(4)}°N, Longitude: ${coordinates.longitude.toFixed(4)}°E`,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error("Error getting coordinates:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        error: true,
        message: `Failed to get coordinates: ${errorMessage}`
      };
    } finally {
      span.end();
    }
  });

  thing.setActionHandler('reverseGeocode', async (params: any) => {
    const span = tracer.startSpan('reverseGeocode');
    try {
      let input;
      if (params && typeof params.value === "function") {
        input = await params.value();
      } else {
        input = params;
      }

      if (!input || typeof input.latitude !== 'number' || typeof input.longitude !== 'number') {
        return { error: true, message: "Latitude and longitude are required" };
      }

      // Validate coordinate ranges
      if (input.latitude < -90 || input.latitude > 90) {
        return { error: true, message: "Latitude must be between -90 and 90 degrees" };
      }
      if (input.longitude < -180 || input.longitude > 180) {
        return { error: true, message: "Longitude must be between -180 and 180 degrees" };
      }

      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${input.latitude}&lon=${input.longitude}&zoom=10`;
      const headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
      };

      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`OpenStreetMap API error: ${response.status}`);
      }

      const data = await response.json();

      if (!data || !data.display_name) {
        return {
          error: true,
          message: `No location found for coordinates: ${input.latitude}, ${input.longitude}`
        };
      }

      return {
        success: true,
        coordinates: {
          latitude: input.latitude,
          longitude: input.longitude
        },
        location: data.display_name,
        city: data.address?.city || data.address?.town || data.address?.village || 'Unknown',
        country: data.address?.country || 'Unknown',
        formatted: `${data.address?.city || data.address?.town || data.address?.village || 'Unknown location'}, ${data.address?.country || 'Unknown country'}`,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error("Error reverse geocoding:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        error: true,
        message: `Failed to reverse geocode: ${errorMessage}`
      };
    } finally {
      span.end();
    }
  });

  thing.setPropertyReadHandler('weather', async () => {
    return { message: 'Use getWeather action to get weather data' };
  });

  await thing.expose();  return thing;
}
