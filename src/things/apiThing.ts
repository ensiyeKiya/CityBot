/**
 * API Thing — aggregates live external feeds: OpenWeatherMap (current
 * conditions), Nominatim (two-way geocoding), and the GATE CityLab Sofia
 * Sensors environmental station network via GATE CityLab Sofia Sensors API
 * (load / filter / remove / query). Requires SOFIA_SENSORS_API_KEY.
 */

import fetch from 'node-fetch';
import { tracer, THING_IDS, SECURITY_SCHEME, USER_AGENT, createEmitEvent, httpForm, mqttEventForm } from './shared';
import { fetchBuildingCoordinatesByClass, fetchBuildingsNearPoint } from '../database';
import {
  OPERATOR_NAMES,
  QUALITY_CONFIG,
  loadSensorNetwork,
  resolveOperator,
  resolveParameterAbbrev,
  fetchStationLastMeasurements,
  evaluateSensorValueFilter,
  filterSensorsNearPoints,
  resolveBuildingClass,
  formatSensorNumber,
  findStationByName
} from '../sofiaSensors';

const TITLE = 'api';

function extractInput(params: any): Promise<any> {
  if (params && typeof params.value === 'function') {
    return params.value();
  }
  return Promise.resolve(params);
}

/** Short everyday labels for citygml building classes (spoken replies). */
function friendlyBuildingClassLabel(cls: string): string {
  const map: Record<string, string> = {
    healthcare: 'hospitals',
    'schools, education, research': 'schools',
    sport: 'sports centers',
    'business, trade': 'business buildings',
    habitation: 'residential buildings',
    'church institution': 'churches',
    administration: 'administrative buildings',
    industry: 'industrial buildings',
    storage: 'storage buildings',
    traffic: 'traffic buildings',
    culture: 'cultural buildings'
  };
  return map[cls] || cls;
}

function sensorUnit(parameter: string | null | undefined): string {
  if (!parameter) return '';
  return QUALITY_CONFIG[parameter]?.unit || '';
}

function formatReading(
  parameter: string,
  row: { station: string; value: number } | null | undefined
): string {
  if (!row) return '';
  const unit = sensorUnit(parameter);
  return `${formatSensorNumber(row.value)}${unit ? ` ${unit}` : ''} at ${row.station}`;
}

function toCesiumColorExpr(value: string): string {
  if (!value) return "color('white')";
  const trimmed = String(value).trim();
  return /^rgb(a)?\(/i.test(trimmed) ? trimmed : `color('${trimmed}')`;
}

/** Cesium 3D Tiles condition matching a list of building gml ids. */
function gmlIdMatchExpression(gmlIds: string[]): string {
  const parts = gmlIds
    .filter(Boolean)
    .map((id) => {
      const esc = String(id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return `(\${feature['gml_id']} === '${esc}' || \${feature['GMLID']} === '${esc}')`;
    });
  return parts.length ? parts.join(' || ') : 'false';
}

/** Natural user-facing text for value/quality/rank sensor filters. */
function sensorValueUserMessage(options: {
  filterType: string;
  filterValue: string;
  parameter: string;
  allCount: number;
  matching: Array<{ station: string; value: number }>;
  highest: { station: string; value: number } | null;
}): string {
  const { filterType, filterValue, parameter, allCount, matching, highest } = options;
  const lower = filterValue.trim().toLowerCase();
  const isRankWord = ['worst', 'best', 'highest', 'lowest', 'max', 'min', 'maximum', 'minimum'].includes(lower);
  const isTop = /^top\s*:?\s*\d+$/i.test(filterValue);
  const isBottom = /^(bottom|lowest)\s*:?\s*\d+$/i.test(filterValue);
  const wantHigh =
    isTop
    || ['worst', 'highest', 'max', 'maximum'].includes(lower)
    || (filterType === 'rank' && !isBottom && !['best', 'lowest', 'min', 'minimum'].includes(lower));

  if (allCount === 0) {
    return `No live ${parameter} readings are available right now.`;
  }

  if (matching.length === 0) {
    if (filterType === 'quality') {
      return highest
        ? `No stations currently report ${filterValue} ${parameter}. The highest right now is ${formatReading(parameter, highest)}.`
        : `No stations currently report ${filterValue} ${parameter}.`;
    }
    return highest
      ? `Nothing on the map matches that ${parameter} filter. The highest reading right now is ${formatReading(parameter, highest)}.`
      : `Nothing on the map matches that ${parameter} filter.`;
  }

  if (filterType === 'rank' || isRankWord || isTop || isBottom) {
    if (matching.length === 1) {
      return wantHigh
        ? `The highest ${parameter} right now is ${formatReading(parameter, matching[0])}.`
        : `The lowest ${parameter} right now is ${formatReading(parameter, matching[0])}.`;
    }
    const unit = sensorUnit(parameter);
    const list = matching
      .slice(0, 5)
      .map((r) => `${r.station} (${formatSensorNumber(r.value)}${unit ? ` ${unit}` : ''})`)
      .join(', ');
    return `Here are the ${wantHigh ? 'highest' : 'lowest'} ${parameter} readings: ${list}.`;
  }

  if (filterType === 'quality') {
    return matching.length === 1
      ? `One station currently reports ${filterValue} ${parameter}: ${formatReading(parameter, matching[0])}.`
      : `Stations with ${filterValue} ${parameter} are highlighted on the map.`
        + (highest ? ` Highest among them: ${formatReading(parameter, highest)}.` : '');
  }

  // Numeric / broad value filters — describe the map outcome, not the expression.
  if (matching.length >= allCount * 0.8) {
    return highest
      ? `${parameter} readings are now shown on the map. Highest right now: ${formatReading(parameter, highest)}.`
      : `${parameter} readings are now shown on the map.`;
  }

  const unit = sensorUnit(parameter);
  const sample = matching
    .slice(0, 3)
    .map((r) => `${r.station} (${formatSensorNumber(r.value)}${unit ? ` ${unit}` : ''})`)
    .join(', ');
  return `Stations matching that ${parameter} filter are highlighted`
    + (sample ? ` — for example ${sample}` : '')
    + '.'
    + (highest ? ` Highest overall: ${formatReading(parameter, highest)}.` : '');
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
            requestId: { oneOf: [{ type: "string" }, { type: "null" }] },
            toolCallId: { oneOf: [{ type: "string" }, { type: "null" }] },
            timestamp: { type: "string", format: "date-time" }
          },
          required: ["action"]
        },
        forms: mqttEventForm(TITLE, 'sensorsChanged')
      },
      visualizationStyleChanged: {
        title: "Visualization Style Changed",
        description: "Emitted when findBuildingsNearSensor highlights nearby buildings (same frontend contract as citymodel).",
        data: {
          type: "object",
          properties: {
            style: { type: "string" },
            styleName: { type: "string" },
            styleDefinition: { type: "object" },
            userId: { type: "string" },
            requestId: { oneOf: [{ type: "string" }, { type: "null" }] },
            toolCallId: { oneOf: [{ type: "string" }, { type: "null" }] },
            timestamp: { type: "string", format: "date-time" }
          }
        },
        forms: mqttEventForm(TITLE, 'visualizationStyleChanged')
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
        description: 'Converts a place name into latitude/longitude. Always call this before flyTo when you only have a name — never guess coordinates (even for well-known Sofia places). "Sofia" without a country means Sofia, Bulgaria. Returns decimal degrees (lat −90..90, lon −180..180).',
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
        description: `Loads Sofia environmental sensor stations as colored map pins (GATE CityLab). Use for "show sensors", "show PM2.5 sensors", "show PM10 sensors". Pass parameter (PM10, PM2.5, NO2, …) to show ONLY stations that currently report that reading (colored by value). Without parameter, loads all stations. Do NOT pass operator unless the user names one (GATE/City Lab, Sofia municipality/Airthings, ExEA). For worst/top-N/quality bands use filterSensors instead.`,
        input: {
          type: 'object',
          properties: {
            operator: {
              type: 'string',
              description: `Only when the user names an operator. Canonical: ${OPERATOR_NAMES.join(', ')}. Aliases: Airthings, City Lab, EXEA. Omit for all operators.`
            },
            parameter: {
              type: 'string',
              description: 'Optional environmental parameter abbreviation (PM10, PM2.5, NO2, O3, CO, CO2, SO2, T, RH, …) or full name. When set, only stations with a live reading for that parameter are shown.'
            },
            userId: { type: 'string' }
          }
        },
        output: { type: 'object' },
        forms: httpForm(TITLE, 'actions', 'loadSensors', ['invokeaction'])
      },
      filterSensors: {
        description: 'Filter Sofia sensor stations. ALWAYS pass filterType and filterValue.\n- Worst / top N / numeric: filterType rank|value + parameter. "worst"/"highest" → 1 station; "top:5" → five. Prefer rank/value over quality bands unless the user names a band (hazardous/poor/…). Hazardous ≠ worst.\n- nearBuildings: ONLY for SENSORS near a building class (hospitals, schools, …). Optional parameter + radiusMeters. To also highlight those buildings, call filterBuildings with the same class. Do NOT use for "schools close to sensor A1/it" — that is findBuildingsNearSensor.\n- operator/name: hide by operator or station id (not building types).\nReplaces pins with the matching set.',
        input: {
          type: 'object',
          properties: {
            filterType: {
              type: 'string',
              enum: ['quality', 'value', 'rank', 'nearBuildings', 'operator', 'name'],
              description: 'Required. quality/value/rank = evaluate readings; nearBuildings = sensors near buildings of a class; operator/name = pin metadata filters'
            },
            filterValue: {
              type: 'string',
              description: 'Required. quality level, numeric/rank expression, building class (for nearBuildings), operator name, or station id substring'
            },
            parameter: {
              type: 'string',
              description: 'Pollutant/metric abbreviation (PM10, PM2.5, NO2, …). Required for quality/value/rank; optional for nearBuildings (colors/filters by that reading).'
            },
            operator: {
              type: 'string',
              description: 'Optional sensor-operator scope (Airthings / City Lab / EXEA).'
            },
            radiusMeters: {
              type: 'number',
              description: 'For nearBuildings: distance threshold in meters (default 800).'
            },
            limit: {
              type: 'number',
              description: 'Optional. For rank: override how many stations to keep. Default is 1 for worst/best/highest/lowest; use filterValue "top:5" (or set limit) when the user asks for several.'
            },
            // Injected by the LLM gateway — listed so empty model args still validate
            userId: { oneOf: [{ type: 'string' }, { type: 'number' }] },
            _userId: { oneOf: [{ type: 'string' }, { type: 'number' }] },
            _requestId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            _toolCallId: { oneOf: [{ type: 'string' }, { type: 'null' }] }
          }
          // filterType/filterValue validated in the handler (not TD required) so a bad/empty
          // model call returns a clear error instead of a WoT DataSchema exception.
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
        description: 'Reads the latest measurement for one station (e.g. "what is the current PM10 at A1?"). Uses the same live network values as filterSensors/loadSensors (rounded). Does not change the map. Station ids: AT* (Sofia municipality), AE* (ExEA), A* (GATE/City Lab).',
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
      },
      findBuildingsNearSensor: {
        description: 'Find and highlight buildings of a class near ONE sensor station. Use for "which schools are close to it/A1?", "hospitals near the worst PM10 sensor". Pass station id from context (e.g. A1). Casual class names OK (schools, hospitals). Default radius 800m. Do NOT use filterSensors nearBuildings — that is the opposite direction (sensors near buildings).',
        input: {
          type: 'object',
          properties: {
            station: {
              type: 'string',
              description: 'Sensor station id from context (e.g. A1, AE5, AT12)'
            },
            buildingClass: {
              type: 'string',
              description: 'Building type to search (schools, hospitals/healthcare, habitation, sport, industry, business, …)'
            },
            radiusMeters: {
              type: 'number',
              description: 'Search radius in meters (default 800)'
            },
            color: {
              type: 'string',
              description: 'Highlight color for matching buildings (default red)'
            },
            limit: {
              type: 'number',
              description: 'Max buildings to return/highlight (default 10)'
            },
            userId: { oneOf: [{ type: 'string' }, { type: 'number' }] },
            _userId: { oneOf: [{ type: 'string' }, { type: 'number' }] },
            _requestId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            _toolCallId: { oneOf: [{ type: 'string' }, { type: 'null' }] }
          },
          required: ['station', 'buildingClass']
        },
        output: { type: 'object' },
        forms: httpForm(TITLE, 'actions', 'findBuildingsNearSensor', ['invokeaction'])
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

      let userMessage: string;
      if (loaded.sensorCount === 0) {
        userMessage = loaded.parameter
          ? `I couldn't find any stations measuring ${loaded.parameter} right now.`
          : `I couldn't find any environmental sensor stations to show.`;
      } else if (loaded.parameter) {
        userMessage = loaded.operator
          ? `${loaded.sensorCount} ${loaded.operator} stations with live ${loaded.parameter} are now on the map.`
          : `${loaded.sensorCount} stations with live ${loaded.parameter} are now on the map.`;
      } else {
        userMessage = loaded.operator
          ? `Sensor stations from ${loaded.operator} are now on the map.`
          : `Environmental sensor stations are now on the map.`;
      }

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
      if (!input?.filterType || input.filterValue === undefined || input.filterValue === null || input.filterValue === '') {
        return {
          error: true,
          message: 'filterType and filterValue are required. Examples: {filterType:"rank", filterValue:"top:5", parameter:"PM2.5"} or {filterType:"nearBuildings", filterValue:"healthcare", parameter:"PM2.5"}.'
        };
      }

      const filterType = String(input.filterType);
      let filterValue = String(input.filterValue);
      let parameter: string | null = null;
      if (input.parameter) {
        parameter = resolveParameterAbbrev(input.parameter);
      }

      // Value questions: fetch ALL live readings, evaluate server-side, reload matching pins.
      if (filterType === 'quality' || filterType === 'value' || filterType === 'rank') {
        if (!parameter) {
          return {
            error: true,
            message: `parameter is required for ${filterType} filters (e.g. PM2.5, NO2, PM10).`
          };
        }

        const evaluated = await evaluateSensorValueFilter({
          filterType: filterType as 'quality' | 'value' | 'rank',
          filterValue,
          parameter,
          operator: input.operator,
          rankLimit: typeof input.limit === 'number' ? input.limit : undefined
        });

        const userMessage = sensorValueUserMessage({
          filterType,
          filterValue,
          parameter: evaluated.parameter,
          allCount: evaluated.all.length,
          matching: evaluated.matching,
          highest: evaluated.highest
            ? { station: evaluated.highest.station, value: evaluated.highest.value }
            : null
        });

        await emitEvent('sensorsChanged', {
          action: 'load',
          userId,
          requestId: input?._requestId ?? null,
          toolCallId: input?._toolCallId ?? null,
          operator: evaluated.operator,
          parameter: evaluated.parameter,
          sensors: evaluated.matchingFeatures,
          sensorCount: evaluated.matchingFeatures.length,
          show: true,
          filterType,
          filterValue,
          appliedResult: { description: userMessage },
          timestamp: new Date().toISOString()
        });

        return {
          success: true,
          message: userMessage,
          userMessage,
          filterType,
          filterValue,
          parameter: evaluated.parameter,
          facts: {
            checkedCount: evaluated.all.length,
            matchCount: evaluated.matching.length,
            parameter: evaluated.parameter,
            highest: evaluated.highest
              ? { station: evaluated.highest.station, value: evaluated.highest.value }
              : null,
            lowest: evaluated.lowest
              ? { station: evaluated.lowest.station, value: evaluated.lowest.value }
              : null,
            matches: evaluated.matching.map((r) => ({
              station: r.station,
              value: r.value,
              operator: r.operator
            }))
          },
          uiEffect: {
            needsAck: true,
            timeoutMs: 8000,
            summary: `Show ${evaluated.matching.length} sensors matching ${filterType} ${filterValue}`
          }
        };
      }

      // Sensors near buildings of any class (generic spatial join).
      if (filterType === 'nearBuildings') {
        const buildingClass = resolveBuildingClass(filterValue);
        const radiusMeters = Number(input.radiusMeters) > 0 ? Number(input.radiusMeters) : 800;
        const loaded = await loadSensorNetwork({
          operator: input.operator,
          parameter
        });
        const buildingPoints = await fetchBuildingCoordinatesByClass(buildingClass);
        if (!buildingPoints.length) {
          return {
            error: true,
            message: `No buildings found for class "${buildingClass}". Use an exact citygml class or aliases like healthcare, schools, habitation, commercial, industrial, sports.`
          };
        }

        const nearby = filterSensorsNearPoints(loaded.sensors, buildingPoints, radiusMeters);
        const place = friendlyBuildingClassLabel(buildingClass);
        const unit = sensorUnit(parameter);
        const nearest = nearby
          .slice(0, 3)
          .map((f) => {
            const name = String(f.properties.object || 'Sensor');
            const dist = f.properties.nearestDistanceM;
            const val = parameter != null ? f.properties.currentValue : null;
            const valPart = typeof val === 'number'
              ? `, ${parameter} ${formatSensorNumber(val)}${unit ? ` ${unit}` : ''}`
              : '';
            return `${name} (${dist} m${valPart})`;
          })
          .join(', ');

        let userMessage: string;
        if (!nearby.length) {
          userMessage = `I couldn't find any sensors within about ${radiusMeters} m of ${place}.`;
        } else {
          userMessage = `Sensors near ${place} are now on the map.`
            + (nearest ? ` Closest: ${nearest}.` : '');
        }

        await emitEvent('sensorsChanged', {
          action: 'load',
          userId,
          requestId: input?._requestId ?? null,
          toolCallId: input?._toolCallId ?? null,
          operator: loaded.operator,
          parameter,
          sensors: nearby,
          sensorCount: nearby.length,
          show: true,
          filterType,
          filterValue: buildingClass,
          radiusMeters,
          appliedResult: { description: userMessage },
          timestamp: new Date().toISOString()
        });

        return {
          success: true,
          message: userMessage,
          userMessage,
          filterType,
          filterValue: buildingClass,
          parameter,
          facts: {
            buildingClass,
            buildingCount: buildingPoints.length,
            radiusMeters,
            checkedSensors: loaded.sensorCount,
            matchCount: nearby.length,
            matches: nearby.slice(0, 20).map((f) => ({
              station: f.properties.object,
              distanceM: f.properties.nearestDistanceM,
              value: parameter != null ? f.properties.currentValue ?? null : null
            }))
          },
          uiEffect: {
            needsAck: true,
            timeoutMs: 8000,
            summary: `Show ${nearby.length} sensors near ${buildingClass}`
          }
        };
      }

      // Pin-only filters (no live value re-fetch)
      if (filterType === 'operator') {
        filterValue = resolveOperator(filterValue) || filterValue;
      }

      let userMessage: string;
      if (filterType === 'operator') {
        userMessage = `Showing stations from ${filterValue} on the map.`;
      } else if (filterType === 'name') {
        userMessage = `Showing stations matching “${filterValue}” on the map.`;
      } else {
        userMessage = `Sensor pins are updated on the map.`;
      }

      await emitEvent('sensorsChanged', {
        action: 'filter',
        userId,
        requestId: input?._requestId ?? null,
        toolCallId: input?._toolCallId ?? null,
        filterType,
        filterValue,
        parameter,
        appliedResult: { description: userMessage },
        timestamp: new Date().toISOString()
      });

      return {
        success: true,
        message: userMessage,
        userMessage,
        filterType,
        filterValue,
        parameter,
        uiEffect: {
          needsAck: true,
          timeoutMs: 5000,
          summary: `Filter sensors by ${filterType}`
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
        return {
          error: true,
          message: 'station is required (e.g. AT12)',
          userMessage: 'Please name a sensor station (e.g. A1, AT12).'
        };
      }

      const station = String(input.station).trim().toUpperCase();
      const parameter = input.parameter ? resolveParameterAbbrev(input.parameter) : null;

      // Same live network path as filterSensors/loadSensors so values stay consistent.
      const info = await findStationByName(station);
      if (!info) {
        const userMessage = `I couldn't find sensor station ${station} in the Sofia Sensors network.`;
        return { error: true, message: userMessage, userMessage };
      }
      let operatorName: string | null = null;
      try {
        operatorName = resolveOperator(info.operator);
      } catch {
        operatorName = null;
      }

      const loaded = await loadSensorNetwork({
        operator: operatorName,
        parameter
      });
      const feature = loaded.sensors.find(
        (f) => String(f.properties.station_name || '').toUpperCase() === station
      );
      const dateMeasured =
        (feature?.properties.date_measured as string | null | undefined) || null;

      let userMessage: string;
      let value: number | null = null;
      if (parameter) {
        const raw = feature?.properties.currentValue;
        value = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
        const unit = sensorUnit(parameter);
        userMessage = value === null
          ? `No latest ${parameter} reading is available for station ${station}.`
          : `Latest ${parameter} at ${station} is ${formatSensorNumber(value)}${unit ? ` ${unit}` : ''}`
            + (dateMeasured ? ` (measured ${dateMeasured}).` : '.');
      } else {
        const data = await fetchStationLastMeasurements(station);
        const entries = Object.entries(data.measurements || {})
          .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
          .map(([k, v]) => `${k}: ${formatSensorNumber(v as number)}`);
        userMessage = entries.length
          ? `Latest readings at ${station}: ${entries.join(', ')}.`
          : `No latest measurements are available for station ${station}.`;
        return {
          success: true,
          message: userMessage,
          userMessage,
          station,
          operator: data.operator,
          parameter,
          value: null,
          date_measured: data.date_measured,
          measurements: data.measurements,
          facts: {
            station,
            operator: data.operator,
            parameter,
            value: null,
            date_measured: data.date_measured
          }
        };
      }

      return {
        success: true,
        message: userMessage,
        userMessage,
        station,
        operator: operatorName,
        parameter,
        value,
        date_measured: dateMeasured,
        facts: {
          station,
          operator: operatorName,
          parameter,
          value,
          date_measured: dateMeasured
        }
      };
    } catch (error) {
      console.error('Error in getSensorMeasurement handler:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        error: true,
        message: errorMessage,
        userMessage: 'I could not read that sensor measurement right now. Please try again.'
      };
    } finally {
      span.end();
    }
  });

  thing.setActionHandler('findBuildingsNearSensor', async (params: any) => {
    const span = tracer.startSpan('findBuildingsNearSensor');
    let stationName = '';
    let place = 'buildings';
    try {
      const input = await extractInput(params);
      const userId = input?._userId ?? input?.userId ?? null;
      if (!userId) {
        return {
          error: true,
          message: 'userId is required',
          userMessage: 'I could not look up buildings near that sensor (missing user session).'
        };
      }
      if (!input?.station) {
        return {
          error: true,
          message: 'station is required (e.g. A1)',
          userMessage: 'Please name a sensor station (e.g. A1) to find nearby buildings.'
        };
      }
      if (!input?.buildingClass) {
        return {
          error: true,
          message: 'buildingClass is required (e.g. schools, healthcare)',
          userMessage: 'Please say which building type to search for near the sensor (e.g. schools).'
        };
      }

      stationName = String(input.station).trim().toUpperCase();
      const buildingClass = resolveBuildingClass(String(input.buildingClass));
      place = friendlyBuildingClassLabel(buildingClass);
      const radiusMeters = Number(input.radiusMeters) > 0 ? Number(input.radiusMeters) : 800;
      const limit = Number(input.limit) > 0 ? Number(input.limit) : 10;
      const color = String(input.color || 'red').trim() || 'red';

      const station = await findStationByName(stationName);
      const lat = Number(station?.latitude);
      const lon = Number(station?.longitude);
      if (!station || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        const userMessage = `I couldn't find sensor station ${stationName} in the Sofia Sensors network.`;
        return { error: true, message: userMessage, userMessage };
      }

      const nearby = await fetchBuildingsNearPoint({
        latitude: lat,
        longitude: lon,
        radiusMeters,
        classDescription: buildingClass,
        limit
      });

      let userMessage: string;
      if (!nearby.length) {
        userMessage = `I couldn't find any ${place} within about ${radiusMeters} m of sensor ${stationName}.`;
      } else {
        const listed = nearby
          .slice(0, 5)
          .map((b) => `${b.label} (${b.distance_m} m)`)
          .join(', ');
        if (nearby.length === 1) {
          userMessage = `The closest ${place.replace(/s$/, '') || 'building'} to sensor ${stationName} is ${listed}.`;
        } else {
          userMessage = `${place.charAt(0).toUpperCase() + place.slice(1)} closest to sensor ${stationName}: ${listed}`
            + (nearby.length > 5 ? '…' : '')
            + '.';
        }
      }

      const gmlIds = nearby.map((b) => b.gml_id).filter((id): id is string => !!id);
      const uiEffect = {
        needsAck: true,
        timeoutMs: 5000,
        summary: `Highlight ${place} near sensor ${stationName}`
      };

      if (gmlIds.length) {
        const matchExpr = gmlIdMatchExpression(gmlIds);
        const styleDefinition = {
          color: {
            conditions: [
              [matchExpr, toCesiumColorExpr(color)],
              ['true', "color('white')"]
            ]
          }
        };
        const appliedResult = {
          action: 'findBuildingsNearSensor',
          station: stationName,
          buildingClass,
          radiusMeters,
          color,
          matchCount: nearby.length,
          description: userMessage
        };
        await emitEvent('visualizationStyleChanged', {
          userId,
          requestId: input?._requestId ?? null,
          toolCallId: input?._toolCallId ?? null,
          style: 'custom_filter',
          styleName: `Near sensor ${stationName}: ${place}`,
          styleDefinition,
          appliedResult,
          timestamp: new Date().toISOString()
        });
      }

      return {
        success: true,
        message: userMessage,
        userMessage,
        station: stationName,
        buildingClass,
        radiusMeters,
        color,
        facts: {
          station: stationName,
          latitude: lat,
          longitude: lon,
          buildingClass,
          radiusMeters,
          matchCount: nearby.length,
          buildings: nearby.map((b) => ({
            label: b.label,
            distance_m: b.distance_m,
            gml_id: b.gml_id
          }))
        },
        ...(gmlIds.length ? { uiEffect } : {})
      };
    } catch (error) {
      console.error('Error in findBuildingsNearSensor handler:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const userMessage = stationName
        ? `There was a problem finding ${place} near sensor ${stationName}. Please try again.`
        : `There was a problem finding nearby buildings. Please try again.`;
      return { error: true, message: errorMessage, userMessage };
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
