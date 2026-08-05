/**
 * API Thing — aggregates live external feeds: OpenWeatherMap (current
 * conditions), Nominatim (two-way geocoding), and the GATE CityLab Sofia
 * Sensors environmental station network (load / filter / remove / query).
 */

import fetch from 'node-fetch';
import { tracer, THING_IDS, SECURITY_SCHEME, USER_AGENT, createEmitEvent, httpForm, mqttEventForm } from './shared';
import {
  OPERATOR_NAMES,
  loadSensorNetwork,
  resolveOperator,
  resolveParameterAbbrev,
  parameterFullName,
  pickMeasurementValue,
  fetchStationLastMeasurements
} from '../sofiaSensors';

const TITLE = 'api';

function extractInput(params: any): Promise<any> {
  if (params && typeof params.value === 'function') {
    return params.value();
  }
  return Promise.resolve(params);
}

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
    description: 'API Thing: live external feeds — OpenWeatherMap current conditions, Nominatim two-way geocoding, and the GATE CityLab Sofia Sensors environmental station network',
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
            parameter: { type: "string", description: "Environmental parameter being displayed (abbreviation, e.g. PM10, NO2)" },
            sensors: { type: "array", description: "Array of sensor GeoJSON features with properties and coordinates" },
            filterType: { type: "string", description: "Type of filter applied" },
            filterValue: { type: "string", description: "Filter value" },
            sensorCount: { type: "number", description: "Number of sensors affected" },
            show: { type: "boolean", description: "Whether sensors should be visible" },
            userId: { type: "string" },
            requestId: { type: ["string", "null"] },
            toolCallId: { type: ["string", "null"] },
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
      },
      loadSensors: {
        description: `Loads Sofia environmental sensor stations onto the 3D map as colored pins (GATE CityLab Sofia Sensors). Operators: ${OPERATOR_NAMES.join('; ')} (aliases: Airthings=Sofia municipality, City Lab=GATE Institute, EXEA=ExEA). Optional parameter colors pins by that reading (PM10, PM2.5, NO2, O3, CO, T, RH, …). Omit operator to show all operators; omit parameter to show stations without value-based coloring. Use for "show sensors", "show PM2.5 sensors", "show ExEA stations".`,
        input: {
          type: 'object',
          properties: {
            operator: {
              type: 'string',
              description: `Optional operator filter. Canonical: ${OPERATOR_NAMES.join(', ')}. Aliases: Airthings, City Lab, EXEA.`
            },
            parameter: {
              type: 'string',
              description: 'Optional environmental parameter abbreviation (PM10, PM2.5, NO2, O3, CO, CO2, SO2, T, RH, …) or full name.'
            },
            userId: { type: 'string' }
          }
        },
        output: { type: 'object' },
        forms: httpForm(TITLE, 'actions', 'loadSensors', ['invokeaction'])
      },
      filterSensors: {
        description: 'Filters already-loaded sensor pins on the map without refetching. filterType: quality (good/moderate/poor/very poor/hazardous), value (e.g. ">50", "<20"), operator, or name (station id like AT12). Prefer loadSensors when changing operator/parameter.',
        input: {
          type: 'object',
          properties: {
            filterType: {
              type: 'string',
              enum: ['quality', 'value', 'operator', 'name'],
              description: 'Which filter to apply'
            },
            filterValue: {
              type: 'string',
              description: 'Filter criterion (quality level, numeric expression, operator name, or station name substring)'
            },
            parameter: {
              type: 'string',
              description: 'Parameter abbreviation for quality/value filters (required for those types)'
            },
            userId: { type: 'string' }
          },
          required: ['filterType', 'filterValue']
        },
        output: { type: 'object' },
        forms: httpForm(TITLE, 'actions', 'filterSensors', ['invokeaction'])
      },
      removeSensors: {
        description: 'Removes all environmental sensor pins from the map. Use when the user asks to clear/hide/remove sensors.',
        input: {
          type: 'object',
          properties: {
            userId: { type: 'string' }
          }
        },
        output: { type: 'object' },
        forms: httpForm(TITLE, 'actions', 'removeSensors', ['invokeaction'])
      },
      getSensorMeasurement: {
        description: 'Reads the latest measurement for one Sofia Sensors station (e.g. AT12, AE1, A5). Use for questions like "what is the current NO2 at AT12?". Does not change the map unless also followed by loadSensors. Station ids: AT* (Airthings/Sofia municipality), AE* (ExEA), A* (GATE/City Lab).',
        input: {
          type: 'object',
          properties: {
            station: {
              type: 'string',
              description: 'Station name/id (e.g. AT12, AE3, A1)'
            },
            parameter: {
              type: 'string',
              description: 'Optional parameter abbreviation or full name. If omitted, returns all latest measurements for the station.'
            }
          },
          required: ['station']
        },
        output: { type: 'object' },
        forms: httpForm(TITLE, 'actions', 'getSensorMeasurement', ['invokeaction'])
      }
    }
  });

  const emitEvent = createEmitEvent(thing);

  thing.setActionHandler('getWeather', async (params: any) => {
    const span = tracer.startSpan('getWeather');
    try {
      const input = await extractInput(params);

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
      const input = await extractInput(params);

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
      const input = await extractInput(params);

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

  thing.setActionHandler('loadSensors', async (params: any) => {
    const span = tracer.startSpan('loadSensors');
    try {
      const input = await extractInput(params);
      const userId = input?._userId ?? input?.userId ?? null;
      if (!userId) {
        return { error: true, message: 'userId is required' };
      }

      const loaded = await loadSensorNetwork({
        operator: input?.operator,
        parameter: input?.parameter
      });

      const operatorLabel = loaded.operator || 'all operators';
      const paramLabel = loaded.parameter
        ? `${loaded.parameter} (${loaded.parameterFull})`
        : 'all parameters';
      const userMessage = loaded.sensorCount === 0
        ? `No Sofia Sensors stations matched for ${operatorLabel}${loaded.parameter ? ` measuring ${paramLabel}` : ''}.`
        : `Showing ${loaded.sensorCount} Sofia Sensors station${loaded.sensorCount === 1 ? '' : 's'} on the map (${operatorLabel}${loaded.parameter ? `, colored by ${loaded.parameter}` : ''}).`;

      const uiEffect = {
        needsAck: true,
        timeoutMs: 8000,
        summary: `Load ${loaded.sensorCount} sensor pins`
      };

      await emitEvent('sensorsChanged', {
        action: 'load',
        userId,
        requestId: input?._requestId ?? null,
        toolCallId: input?._toolCallId ?? null,
        operator: loaded.operator,
        parameter: loaded.parameter,
        sensors: loaded.sensors,
        sensorCount: loaded.sensorCount,
        show: true,
        appliedResult: { description: userMessage },
        timestamp: new Date().toISOString()
      });

      return {
        success: true,
        message: userMessage,
        userMessage,
        operator: loaded.operator,
        parameter: loaded.parameter,
        sensorCount: loaded.sensorCount,
        facts: {
          sensorCount: loaded.sensorCount,
          operator: loaded.operator,
          parameter: loaded.parameter
        },
        uiEffect
      };
    } catch (error) {
      console.error('Error in loadSensors handler:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { error: true, message: errorMessage };
    } finally {
      span.end();
    }
  });

  thing.setActionHandler('filterSensors', async (params: any) => {
    const span = tracer.startSpan('filterSensors');
    try {
      const input = await extractInput(params);
      const userId = input?._userId ?? input?.userId ?? null;
      if (!userId) {
        return { error: true, message: 'userId is required' };
      }
      if (!input?.filterType || input.filterValue === undefined || input.filterValue === null) {
        return { error: true, message: 'filterType and filterValue are required' };
      }

      let parameter: string | null = null;
      if (input.parameter) {
        parameter = resolveParameterAbbrev(input.parameter);
      }
      let filterValue = String(input.filterValue);
      if (input.filterType === 'operator') {
        filterValue = resolveOperator(filterValue) || filterValue;
      }

      const userMessage = `Sensor pins are now filtered by ${input.filterType}: ${filterValue}${parameter ? ` (${parameter})` : ''}.`;

      await emitEvent('sensorsChanged', {
        action: 'filter',
        userId,
        requestId: input?._requestId ?? null,
        toolCallId: input?._toolCallId ?? null,
        filterType: input.filterType,
        filterValue,
        parameter,
        appliedResult: { description: userMessage },
        timestamp: new Date().toISOString()
      });

      return {
        success: true,
        message: userMessage,
        userMessage,
        filterType: input.filterType,
        filterValue,
        parameter,
        uiEffect: {
          needsAck: true,
          timeoutMs: 5000,
          summary: `Filter sensors by ${input.filterType}`
        }
      };
    } catch (error) {
      console.error('Error in filterSensors handler:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { error: true, message: errorMessage };
    } finally {
      span.end();
    }
  });

  thing.setActionHandler('removeSensors', async (params: any) => {
    const span = tracer.startSpan('removeSensors');
    try {
      const input = await extractInput(params);
      const userId = input?._userId ?? input?.userId ?? null;
      if (!userId) {
        return { error: true, message: 'userId is required' };
      }

      const userMessage = 'Environmental sensor pins have been removed from the map.';

      await emitEvent('sensorsChanged', {
        action: 'remove',
        userId,
        requestId: input?._requestId ?? null,
        toolCallId: input?._toolCallId ?? null,
        sensors: [],
        sensorCount: 0,
        show: false,
        appliedResult: { description: userMessage },
        timestamp: new Date().toISOString()
      });

      return {
        success: true,
        message: userMessage,
        userMessage,
        uiEffect: {
          needsAck: true,
          timeoutMs: 5000,
          summary: 'Remove sensor pins from map'
        }
      };
    } catch (error) {
      console.error('Error in removeSensors handler:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { error: true, message: errorMessage };
    } finally {
      span.end();
    }
  });

  thing.setActionHandler('getSensorMeasurement', async (params: any) => {
    const span = tracer.startSpan('getSensorMeasurement');
    try {
      const input = await extractInput(params);
      if (!input?.station) {
        return { error: true, message: 'station is required (e.g. AT12)' };
      }

      const station = String(input.station).trim().toUpperCase();
      const parameter = input.parameter ? resolveParameterAbbrev(input.parameter) : null;
      const data = await fetchStationLastMeasurements(station);
      const value = parameter
        ? pickMeasurementValue(data.measurements, parameter)
        : null;

      let userMessage: string;
      if (parameter) {
        const full = parameterFullName(parameter);
        userMessage = value === null
          ? `No latest ${parameter} (${full}) reading is available for station ${station}.`
          : `The latest ${parameter} (${full}) at station ${station} is ${value}${data.date_measured ? ` (measured ${data.date_measured})` : ''}.`;
      } else {
        const entries = Object.entries(data.measurements || {})
          .filter(([, v]) => v !== null && v !== undefined)
          .map(([k, v]) => `${k}: ${v}`);
        userMessage = entries.length
          ? `Latest measurements at station ${station}${data.date_measured ? ` (${data.date_measured})` : ''}: ${entries.join(', ')}.`
          : `No latest measurements are available for station ${station}.`;
      }

      return {
        success: true,
        message: userMessage,
        userMessage,
        station,
        parameter,
        value,
        date_measured: data.date_measured,
        measurements: data.measurements,
        facts: { station, parameter, value, date_measured: data.date_measured }
      };
    } catch (error) {
      console.error('Error in getSensorMeasurement handler:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { error: true, message: errorMessage };
    } finally {
      span.end();
    }
  });

  thing.setPropertyReadHandler('weather', async () => {
    return { message: 'Use getWeather action to get weather data' };
  });

  await thing.expose();
  return thing;
}
