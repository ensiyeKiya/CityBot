/**
 * Client for GATE CityLab 3D City Model sensor backend (3cm-server).
 *
 * Public GeoJSON API used by the CityLab 3D viewer — no API key required.
 * Base: https://citylab.gate-ai.eu/3cm-server
 */

import fetch from 'node-fetch';

export const CITYLAB_3CM_API_BASE =
  process.env.CITYLAB_3CM_API_BASE || 'https://citylab.gate-ai.eu/3cm-server';

/** Canonical operator names accepted by 3cm-server. */
export const OPERATOR_NAMES = [
  'Executive environmental agency (ExEA)',
  'Sofia municipality',
  'GATE Institute'
] as const;

export type OperatorName = (typeof OPERATOR_NAMES)[number];

/** Parameters available per operator (from CityLab sensorManager). */
export const OPERATOR_PARAMS: Record<OperatorName, readonly string[]> = {
  'Sofia municipality': ['PM10', 'T', 'p', 'RH', 'CO', 'NO2', 'SO2', 'O3', 'PM2.5'],
  'Executive environmental agency (ExEA)': [
    'PM10', 'T', 'RH', 'WD', 'WS', 'SI', 'CO', 'NO', 'NO2', 'SO2', 'C6H6'
  ],
  'GATE Institute': [
    'PM10', 'T', 'p', 'RH', 'WD', 'WS', 'R', 'CO2', 'NO2', 'SO2', 'O3', 'PM1', 'PM2.5'
  ]
};

/** Abbreviation → full parameter name. */
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

const MEASUREMENT_KEYS = new Set(Object.keys(PARAM_FULL_BY_ABBREV));

export interface SensorGeoJsonFeature {
  type: 'Feature';
  geometry: {
    type: 'Point';
    coordinates: [number, number];
  };
  properties: Record<string, unknown>;
}

interface OperatorStationsGeoJson {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: Record<string, unknown>;
  }>;
}

async function citylabFetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'CityBot/1.0'
    }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `CityLab 3cm-server ${response.status} for ${url}: ${body.slice(0, 300) || response.statusText}`
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

/** Guess operator from station id conventions used by CityLab. */
export function operatorForStationId(station: string): OperatorName {
  const id = station.trim().toUpperCase();
  if (id.startsWith('AT')) return 'Sofia municipality';
  if (id.startsWith('AE')) return 'Executive environmental agency (ExEA)';
  if (/^A\d+$/i.test(id)) return 'GATE Institute';
  // Fallback: search all operators
  return 'GATE Institute';
}

function operatorsForParameter(parameter: string | null): OperatorName[] {
  if (!parameter) return [...OPERATOR_NAMES];
  return OPERATOR_NAMES.filter((op) => OPERATOR_PARAMS[op].includes(parameter));
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && !Number.isNaN(value) ? value : null;
}

/** Pick a numeric measurement from feature properties (live scalars or {max,min,avg}). */
export function pickMeasurementValue(
  properties: Record<string, unknown> | undefined,
  abbrev: string | null,
  agr: 'max' | 'min' | 'avg' = 'avg'
): number | null {
  if (!properties || !abbrev) return null;
  const raw = properties[abbrev];
  if (typeof raw === 'number' && !Number.isNaN(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    return asNumber(obj[agr]) ?? asNumber(obj.avg) ?? asNumber(obj.max) ?? asNumber(obj.min);
  }
  return null;
}

function extractMeasurements(properties: Record<string, unknown>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const key of MEASUREMENT_KEYS) {
    if (!(key in properties)) continue;
    out[key] = pickMeasurementValue(properties, key);
  }
  return out;
}

/** Live stations for one operator as GeoJSON FeatureCollection. */
export async function fetchOperatorStations(operator: OperatorName): Promise<OperatorStationsGeoJson> {
  const url = `${CITYLAB_3CM_API_BASE}/api/operator-stations?operator=${encodeURIComponent(operator)}`;
  return citylabFetchJson<OperatorStationsGeoJson>(url);
}

/**
 * Historical aggregated (or hourly) stations for one operator/date.
 * mode: byAgr → properties[param] = {max,min,avg}; byHour → chart series payload.
 */
export async function fetchOperatorStationsByDate(options: {
  operator: OperatorName;
  date: string; // YYYY-MM-DD
  params?: string[];
  mode?: 'byAgr' | 'byHour';
  param?: string;
}): Promise<any> {
  const paramsList = options.params?.length
    ? options.params
    : [...OPERATOR_PARAMS[options.operator]];
  const url = new URL(`${CITYLAB_3CM_API_BASE}/api/operator-stations-by-date`);
  url.searchParams.set('operator', options.operator);
  url.searchParams.set('date', options.date);
  url.searchParams.set('params', paramsList.join(','));
  url.searchParams.set('mode', options.mode || 'byAgr');
  if (options.param) url.searchParams.set('param', options.param);
  return citylabFetchJson(url.toString());
}

function normalizeFeature(
  feature: OperatorStationsGeoJson['features'][number],
  operator: OperatorName,
  parameterAbbrev: string | null
): SensorGeoJsonFeature | null {
  const coords = feature.geometry?.coordinates;
  if (!coords || coords.length < 2) return null;
  const props = { ...(feature.properties || {}) };
  const object = String(props.object || props.station_name || 'Sensor');
  const currentValue = pickMeasurementValue(props, parameterAbbrev);
  const measurements = extractMeasurements(props);

  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [Number(coords[0]), Number(coords[1])]
    },
    properties: {
      ...measurements,
      object,
      station_name: props.station_name || object,
      operator,
      date_measured: props.date_measured ?? null,
      currentValue,
      coordinates: props.coordinates ?? coords
    }
  };
}

/**
 * Load live sensor pins for one or all operators.
 * When `parameter` is set, only operators that measure it are fetched,
 * and each feature gets `currentValue` for pin coloring.
 */
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

  const operators: OperatorName[] = operator
    ? [operator]
    : operatorsForParameter(parameter);

  if (operators.length === 0) {
    return {
      operator,
      parameter,
      parameterFull,
      sensors: [],
      sensorCount: 0
    };
  }

  const collections = await Promise.all(
    operators.map(async (op) => ({ op, geo: await fetchOperatorStations(op) }))
  );

  const sensors: SensorGeoJsonFeature[] = [];
  for (const { op, geo } of collections) {
    for (const feature of geo.features || []) {
      const normalized = normalizeFeature(feature, op, parameter);
      if (!normalized) continue;
      // If a parameter was requested, skip stations with no reading for it
      if (parameter && normalized.properties.currentValue == null) continue;
      sensors.push(normalized);
    }
  }

  return {
    operator,
    parameter,
    parameterFull,
    sensors,
    sensorCount: sensors.length
  };
}

/** Latest measurements for one station (searches the matching operator, then all). */
export async function fetchStationLastMeasurements(
  stationName: string
): Promise<{
  date_measured: string | null;
  station_name: string;
  operator: OperatorName;
  measurements: Record<string, number | null>;
  longitude: number | null;
  latitude: number | null;
}> {
  const station = stationName.trim().toUpperCase();
  const preferred = operatorForStationId(station);
  const searchOrder: OperatorName[] = [
    preferred,
    ...OPERATOR_NAMES.filter((op) => op !== preferred)
  ];

  for (const operator of searchOrder) {
    const geo = await fetchOperatorStations(operator);
    const match = (geo.features || []).find((f) => {
      const name = String(f.properties?.object || f.properties?.station_name || '').toUpperCase();
      return name === station;
    });
    if (!match) continue;

    const props = match.properties || {};
    const coords = match.geometry?.coordinates;
    return {
      date_measured: (props.date_measured as string) || null,
      station_name: station,
      operator,
      measurements: extractMeasurements(props),
      longitude: coords ? Number(coords[0]) : null,
      latitude: coords ? Number(coords[1]) : null
    };
  }

  throw new Error(`Station ${station} was not found in the CityLab sensor network.`);
}
