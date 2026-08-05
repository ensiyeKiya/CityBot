/**
 * Client for the GATE CityLab Sofia Sensors API
 * (https://citylab.gate-ai.eu/sofiasensors/api/docs).
 *
 * Requires SOFIA_SENSORS_API_KEY (sent as X-API-Key).
 */

import fetch from 'node-fetch';

export const SOFIA_SENSORS_API_BASE =
  process.env.SOFIA_SENSORS_API_BASE || 'https://citylab.gate-ai.eu/sofiasensors/api';

/** Canonical operator names accepted by the API. */
export const OPERATOR_NAMES = [
  'Executive environmental agency (ExEA)',
  'Sofia municipality',
  'GATE Institute'
] as const;

export type OperatorName = (typeof OPERATOR_NAMES)[number];

/** Abbreviation → full parameter name (API ParameterNameEnum). */
export const PARAM_FULL_BY_ABBREV: Record<string, string> = {
  T: 'Temperature',
  p: 'Pressure',
  RH: 'Relative humidity',
  WD: 'Wind direction',
  WS: 'Wind speed',
  R: 'Rainfall',
  SI: 'Solar irradiation',
  CO: 'Carbon monoxide',
  CO2: 'Carbon dioxide',
  NO: 'Nitrogen monoxide',
  NO2: 'Nitrogen dioxide',
  SO2: 'Sulphur dioxide',
  O3: 'Ozone',
  C6H6: 'Benzene',
  PM1: 'Particulate matter 1',
  'PM2.5': 'Particulate matter 2.5',
  PM10: 'Particulate matter 10'
};

/** Full name → abbreviation (for map pin coloring / frontend). */
export const PARAM_ABBREV_BY_FULL: Record<string, string> = Object.fromEntries(
  Object.entries(PARAM_FULL_BY_ABBREV).map(([abbr, full]) => [full.toLowerCase(), abbr])
);

const OPERATOR_ALIASES: Record<string, OperatorName> = {
  'executive environmental agency (exea)': 'Executive environmental agency (ExEA)',
  'executive environmental agency': 'Executive environmental agency (ExEA)',
  exea: 'Executive environmental agency (ExEA)',
  'sofia municipality': 'Sofia municipality',
  airthings: 'Sofia municipality',
  municipality: 'Sofia municipality',
  'gate institute': 'GATE Institute',
  gate: 'GATE Institute',
  'city lab': 'GATE Institute',
  citylab: 'GATE Institute'
};

export interface StationInfo {
  id: number;
  name: string;
  serialNumber?: string;
  model?: string | null;
  latitude: number;
  longitude: number;
  address?: string;
  operator: string;
  stationType?: string;
}

export interface StationMeasurement {
  date_measured: string;
  station_name: string;
  measurements: Record<string, number | null>;
}

export interface SensorGeoJsonFeature {
  type: 'Feature';
  geometry: {
    type: 'Point';
    coordinates: [number, number];
  };
  properties: Record<string, unknown>;
}

function getApiKey(): string {
  const key = process.env.SOFIA_SENSORS_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'SOFIA_SENSORS_API_KEY is not set. Obtain a key for the GATE CityLab Sofia Sensors API and set it in the environment.'
    );
  }
  return key;
}

async function sofiaSensorsFetch<T>(path: string, query?: Record<string, string>): Promise<T> {
  const url = new URL(path.replace(/^\//, ''), SOFIA_SENSORS_API_BASE.endsWith('/')
    ? SOFIA_SENSORS_API_BASE
    : `${SOFIA_SENSORS_API_BASE}/`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'X-API-Key': getApiKey(),
      'User-Agent': 'CityBot/1.0'
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Sofia Sensors API ${response.status} for ${url.pathname}: ${body.slice(0, 300) || response.statusText}`
    );
  }

  return (await response.json()) as T;
}

/** Resolve user-facing operator aliases to the API enum value. */
export function resolveOperator(input?: string | null): OperatorName | null {
  if (!input || !String(input).trim()) return null;
  const raw = String(input).trim();
  if ((OPERATOR_NAMES as readonly string[]).includes(raw)) return raw as OperatorName;
  const mapped = OPERATOR_ALIASES[raw.toLowerCase()];
  if (mapped) return mapped;
  throw new Error(
    `Unknown operator "${raw}". Use one of: ${OPERATOR_NAMES.join(', ')} (aliases: Airthings, City Lab, EXEA).`
  );
}

/**
 * Normalize a user/LLM parameter to an abbreviation used by the Cesium frontend
 * (PM10, NO2, …). Accepts abbreviations or full names.
 */
export function resolveParameterAbbrev(input?: string | null): string | null {
  if (!input || !String(input).trim()) return null;
  const raw = String(input).trim();

  if (PARAM_FULL_BY_ABBREV[raw]) return raw;
  const upper = raw.toUpperCase();
  if (PARAM_FULL_BY_ABBREV[upper]) return upper;
  // PM2.5 family
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  if (compact === 'PM2.5' || compact === 'PM25') return 'PM2.5';
  if (PARAM_FULL_BY_ABBREV[compact]) return compact;

  const byFull = PARAM_ABBREV_BY_FULL[raw.toLowerCase()];
  if (byFull) return byFull;

  throw new Error(
    `Unknown parameter "${raw}". Use abbreviations like PM10, PM2.5, NO2, O3, CO, T, RH.`
  );
}

export function parameterFullName(abbrev: string): string {
  return PARAM_FULL_BY_ABBREV[abbrev] || abbrev;
}

/** Pick a numeric measurement value from a station's measurements object. */
export function pickMeasurementValue(
  measurements: Record<string, number | null> | undefined,
  abbrev: string | null
): number | null {
  if (!measurements || !abbrev) return null;
  const full = PARAM_FULL_BY_ABBREV[abbrev];
  const candidates = [abbrev, full, abbrev.toLowerCase(), full?.toLowerCase()].filter(Boolean) as string[];
  for (const key of candidates) {
    if (key in measurements) {
      const v = measurements[key];
      return typeof v === 'number' && !Number.isNaN(v) ? v : null;
    }
  }
  // Case-insensitive scan
  const lowerMap = new Map(Object.entries(measurements).map(([k, v]) => [k.toLowerCase(), v]));
  for (const key of candidates) {
    const v = lowerMap.get(key.toLowerCase());
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
  }
  return null;
}

/** Flatten measurement keys onto feature properties using abbreviations when possible. */
function flattenMeasurements(
  measurements: Record<string, number | null> | undefined
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (!measurements) return out;
  for (const [key, value] of Object.entries(measurements)) {
    const abbrev = PARAM_FULL_BY_ABBREV[key]
      ? key
      : PARAM_ABBREV_BY_FULL[key.toLowerCase()] || key;
    out[abbrev] = value;
  }
  return out;
}

export async function fetchAllStations(): Promise<StationInfo[]> {
  return sofiaSensorsFetch<StationInfo[]>('stations/');
}

export async function fetchStationsByOperator(operator: OperatorName): Promise<StationInfo[]> {
  return sofiaSensorsFetch<StationInfo[]>('operator/stations', { operator_name: operator });
}

export async function fetchStationsByParameter(fullParameterName: string): Promise<StationInfo[]> {
  return sofiaSensorsFetch<StationInfo[]>('stations/measure/parameter/', {
    parameter_name: fullParameterName
  });
}

export async function fetchAllLastMeasurements(): Promise<StationMeasurement[]> {
  return sofiaSensorsFetch<StationMeasurement[]>('stations/lastmeasurements');
}

export async function fetchOperatorLastMeasurements(
  operator: OperatorName
): Promise<StationMeasurement[]> {
  return sofiaSensorsFetch<StationMeasurement[]>('operator/stations/lastmeasurements', {
    operator_name: operator
  });
}

export async function fetchStationLastMeasurements(
  stationName: string
): Promise<{ date_measured: string; measurements: Record<string, number | null> }> {
  return sofiaSensorsFetch('stations/station/lastmeasurements', {
    station_name: stationName.trim().toUpperCase()
  });
}

/**
 * Build GeoJSON features for the CityBot Cesium sensor renderer.
 * Frontend expects properties.object (label), optional per-param values,
 * and currentValue when a parameter is selected.
 */
export function buildSensorFeatures(
  stations: StationInfo[],
  measurementsByStation: Map<string, StationMeasurement>,
  parameterAbbrev: string | null
): SensorGeoJsonFeature[] {
  return stations
    .filter((s) => typeof s.longitude === 'number' && typeof s.latitude === 'number')
    .map((station) => {
      const meas = measurementsByStation.get(station.name.toUpperCase())
        || measurementsByStation.get(station.name);
      const flat = flattenMeasurements(meas?.measurements);
      const currentValue = pickMeasurementValue(meas?.measurements, parameterAbbrev);

      return {
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [station.longitude, station.latitude] as [number, number]
        },
        properties: {
          object: station.name,
          operator: station.operator,
          address: station.address || null,
          stationType: station.stationType || null,
          date_measured: meas?.date_measured || null,
          currentValue,
          ...flat
        }
      };
    });
}

export async function loadSensorNetwork(options: {
  operator?: string | null;
  parameter?: string | null;
}): Promise<{
  operator: OperatorName | null;
  parameter: string | null;
  parameterFull: string | null;
  sensors: SensorGeoJsonFeature[];
  sensorCount: number;
}> {
  const operator = resolveOperator(options.operator);
  const parameter = resolveParameterAbbrev(options.parameter);
  const parameterFull = parameter ? parameterFullName(parameter) : null;

  let stations: StationInfo[];
  if (operator) {
    stations = await fetchStationsByOperator(operator);
  } else if (parameterFull) {
    stations = await fetchStationsByParameter(parameterFull);
  } else {
    stations = await fetchAllStations();
  }

  // When both operator and parameter are set, intersect operator stations with parameter stations
  if (operator && parameterFull) {
    const byParam = await fetchStationsByParameter(parameterFull);
    const allowed = new Set(byParam.map((s) => s.name.toUpperCase()));
    stations = stations.filter((s) => allowed.has(s.name.toUpperCase()));
  }

  const measurements = operator
    ? await fetchOperatorLastMeasurements(operator)
    : await fetchAllLastMeasurements();

  const measurementsByStation = new Map<string, StationMeasurement>();
  for (const m of measurements) {
    measurementsByStation.set(m.station_name.toUpperCase(), m);
    measurementsByStation.set(m.station_name, m);
  }

  const sensors = buildSensorFeatures(stations, measurementsByStation, parameter);
  return {
    operator,
    parameter,
    parameterFull,
    sensors,
    sensorCount: sensors.length
  };
}
