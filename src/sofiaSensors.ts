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

/** Parameters available per operator (CityLab / API). */
export const OPERATOR_PARAMS: Record<OperatorName, readonly string[]> = {
  'Sofia municipality': ['PM10', 'T', 'p', 'RH', 'CO', 'NO2', 'SO2', 'O3', 'PM2.5'],
  'Executive environmental agency (ExEA)': [
    'PM10', 'T', 'RH', 'WD', 'WS', 'SI', 'CO', 'NO', 'NO2', 'SO2', 'C6H6'
  ],
  'GATE Institute': [
    'PM10', 'T', 'p', 'RH', 'WD', 'WS', 'R', 'CO2', 'NO2', 'SO2', 'O3', 'PM1', 'PM2.5'
  ]
};

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

const MEASUREMENT_KEYS = new Set(Object.keys(PARAM_FULL_BY_ABBREV));

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
      'SOFIA_SENSORS_API_KEY is not set. Add your GATE CityLab Sofia Sensors X-API-Key to the environment.'
    );
  }
  return key;
}

async function sofiaSensorsFetch<T>(path: string, query?: Record<string, string>): Promise<T> {
  const base = SOFIA_SENSORS_API_BASE.endsWith('/')
    ? SOFIA_SENSORS_API_BASE
    : `${SOFIA_SENSORS_API_BASE}/`;
  const url = new URL(path.replace(/^\//, ''), base);
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
  return 'GATE Institute';
}

function operatorsForParameter(parameter: string | null): OperatorName[] {
  if (!parameter) return [...OPERATOR_NAMES];
  return OPERATOR_NAMES.filter((op) => OPERATOR_PARAMS[op].includes(parameter));
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && !Number.isNaN(value) ? value : null;
}

/** Pick a numeric measurement from properties or a measurements map. */
export function pickMeasurementValue(
  properties: Record<string, unknown> | undefined,
  abbrev: string | null,
  agr: 'max' | 'min' | 'avg' = 'avg'
): number | null {
  if (!properties || !abbrev) return null;
  const full = PARAM_FULL_BY_ABBREV[abbrev];
  const candidates = [abbrev, full, abbrev.toLowerCase(), full?.toLowerCase()].filter(Boolean) as string[];

  for (const key of candidates) {
    if (!(key in properties)) continue;
    const raw = properties[key];
    if (typeof raw === 'number' && !Number.isNaN(raw)) return raw;
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      const n = asNumber(obj[agr]) ?? asNumber(obj.avg) ?? asNumber(obj.max) ?? asNumber(obj.min);
      if (n != null) return n;
    }
  }

  const lowerMap = new Map(
    Object.entries(properties).map(([k, v]) => [k.toLowerCase(), v])
  );
  for (const key of candidates) {
    const raw = lowerMap.get(key.toLowerCase());
    if (typeof raw === 'number' && !Number.isNaN(raw)) return raw;
  }
  return null;
}

function flattenMeasurements(
  measurements: Record<string, number | null> | undefined
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (!measurements) return out;
  for (const [key, value] of Object.entries(measurements)) {
    const abbrev = MEASUREMENT_KEYS.has(key)
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
      const currentValue = pickMeasurementValue(
        { ...flat, ...(meas?.measurements || {}) } as Record<string, unknown>,
        parameterAbbrev
      );

      return {
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [station.longitude, station.latitude] as [number, number]
        },
        properties: {
          object: station.name,
          station_name: station.name,
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

/**
 * Load live sensor pins for one or all operators from the Sofia Sensors API.
 * When `parameter` is set, stations without that reading are omitted and
 * each feature gets `currentValue` for pin coloring.
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

  // Always load the full station list (per operator or all). The
  // /stations/measure/parameter endpoint is incomplete vs lastmeasurements,
  // so we filter by which stations actually have a reading for `parameter`.
  let stations: StationInfo[] = operator
    ? await fetchStationsByOperator(operator)
    : await fetchAllStations();

  if (!operator && parameter) {
    const allowedOps = new Set(operatorsForParameter(parameter));
    stations = stations.filter((s) => {
      try {
        const op = resolveOperator(s.operator);
        return op != null && allowedOps.has(op);
      } catch {
        return true;
      }
    });
  }

  const measurements = operator
    ? await fetchOperatorLastMeasurements(operator)
    : await fetchAllLastMeasurements();

  const measurementsByStation = new Map<string, StationMeasurement>();
  for (const m of measurements) {
    measurementsByStation.set(m.station_name.toUpperCase(), m);
    measurementsByStation.set(m.station_name, m);
  }

  let sensors = buildSensorFeatures(stations, measurementsByStation, parameter);
  if (parameter) {
    sensors = sensors.filter((f) => f.properties.currentValue != null);
  }

  return {
    operator,
    parameter,
    parameterFull,
    sensors,
    sensorCount: sensors.length
  };
}

/** CAQI-style bands — keep in sync with static/js/citybot/events.js airQualityConfig. */
export const QUALITY_CONFIG: Record<string, { thresholds: number[]; labels: string[]; unit: string }> = {
  PM10: { thresholds: [25, 50, 75, 100], labels: ['Good', 'Moderate', 'Poor', 'Very Poor', 'Hazardous'], unit: 'µg/m³' },
  'PM2.5': { thresholds: [15, 30, 55, 110], labels: ['Good', 'Moderate', 'Poor', 'Very Poor', 'Hazardous'], unit: 'µg/m³' },
  PM1: { thresholds: [10, 20, 35, 50], labels: ['Good', 'Moderate', 'Poor', 'Very Poor', 'Hazardous'], unit: 'µg/m³' },
  CO: { thresholds: [1, 2, 4], labels: ['Good', 'Moderate', 'Poor', 'Very Poor'], unit: 'mg/m³' },
  CO2: { thresholds: [400, 1000, 2000], labels: ['Good', 'Moderate', 'Poor', 'Very Poor'], unit: 'ppm' },
  NO2: { thresholds: [50, 100, 200], labels: ['Good', 'Moderate', 'Poor', 'Very Poor'], unit: 'µg/m³' },
  O3: { thresholds: [60, 120, 180], labels: ['Good', 'Moderate', 'Poor', 'Very Poor'], unit: 'µg/m³' },
  SO2: { thresholds: [50, 100, 200], labels: ['Good', 'Moderate', 'Poor', 'Very Poor'], unit: 'µg/m³' },
  NO: { thresholds: [50, 100, 200], labels: ['Good', 'Moderate', 'Poor', 'Very Poor'], unit: 'µg/m³' },
  C6H6: { thresholds: [2, 5, 10], labels: ['Good', 'Moderate', 'Poor', 'Very Poor'], unit: 'µg/m³' }
};

export interface SensorValueRow {
  station: string;
  operator: string | null;
  value: number;
  feature: SensorGeoJsonFeature;
}

export function sensorStationName(feature: SensorGeoJsonFeature): string {
  return String(feature.properties.object || feature.properties.station_name || 'Sensor');
}

export function sensorNumericValue(feature: SensorGeoJsonFeature, parameter: string): number | null {
  return pickMeasurementValue(feature.properties as Record<string, unknown>, parameter);
}

export function listSensorValues(
  sensors: SensorGeoJsonFeature[],
  parameter: string
): SensorValueRow[] {
  const rows: SensorValueRow[] = [];
  for (const feature of sensors) {
    const value = sensorNumericValue(feature, parameter);
    if (value == null) continue;
    rows.push({
      station: sensorStationName(feature),
      operator: (feature.properties.operator as string) || null,
      value,
      feature
    });
  }
  return rows;
}

export function matchesQualityLevel(value: number, parameter: string, qualityLevel: string): boolean {
  const config = QUALITY_CONFIG[parameter];
  if (!config) return false;
  const level = qualityLevel.toLowerCase().replace(/\s+/g, '');
  const labels = config.labels.map((l) => l.toLowerCase().replace(/\s+/g, ''));
  const labelIndex = labels.indexOf(level);
  if (labelIndex === -1) return false;
  const { thresholds } = config;
  if (labelIndex === 0) return value <= thresholds[0];
  if (labelIndex === labels.length - 1) return value > thresholds[thresholds.length - 1];
  return value > thresholds[labelIndex - 1] && value <= thresholds[labelIndex];
}

export function matchesValueExpression(value: number, filterValue: string): boolean {
  const match = String(filterValue).trim().match(/^(>=|<=|>|<|==|=)\s*(.+)$/);
  if (!match) return false;
  const op = match[1];
  const threshold = parseFloat(match[2]);
  if (Number.isNaN(threshold)) return false;
  if (op === '>') return value > threshold;
  if (op === '>=') return value >= threshold;
  if (op === '<') return value < threshold;
  if (op === '<=') return value <= threshold;
  if (op === '==' || op === '=') return value === threshold;
  return false;
}

/**
 * Evaluate a value-related filter against ALL live station readings for a parameter.
 * Supports quality bands, numeric comparisons, and rank (worst/best/top:N).
 */
export async function evaluateSensorValueFilter(options: {
  filterType: 'quality' | 'value' | 'rank';
  filterValue: string;
  parameter: string;
  operator?: string | null;
  rankLimit?: number;
}): Promise<{
  parameter: string;
  parameterFull: string;
  operator: OperatorName | null;
  all: SensorValueRow[];
  matching: SensorValueRow[];
  matchingFeatures: SensorGeoJsonFeature[];
  highest: SensorValueRow | null;
  lowest: SensorValueRow | null;
}> {
  const parameter = resolveParameterAbbrev(options.parameter);
  if (!parameter) {
    throw new Error('parameter is required for value filters');
  }
  const loaded = await loadSensorNetwork({
    operator: options.operator,
    parameter
  });
  const all = listSensorValues(loaded.sensors, parameter);
  const highest = all.length
    ? all.reduce((a, b) => (b.value > a.value ? b : a))
    : null;
  const lowest = all.length
    ? all.reduce((a, b) => (b.value < a.value ? b : a))
    : null;

  let matching: SensorValueRow[] = [];
  const raw = String(options.filterValue).trim();
  const lower = raw.toLowerCase();

  if (options.filterType === 'quality') {
    matching = all.filter((row) => matchesQualityLevel(row.value, parameter, raw));
  } else if (options.filterType === 'value') {
    if (['worst', 'highest', 'max', 'maximum'].includes(lower)) {
      matching = [...all].sort((a, b) => b.value - a.value).slice(0, options.rankLimit ?? 1);
    } else if (['best', 'lowest', 'min', 'minimum'].includes(lower)) {
      matching = [...all].sort((a, b) => a.value - b.value).slice(0, options.rankLimit ?? 1);
    } else {
      matching = all.filter((row) => matchesValueExpression(row.value, raw));
    }
  } else {
    const topMatch = lower.match(/^top\s*:?\s*(\d+)$/);
    const bottomMatch = lower.match(/^(bottom|lowest)\s*:?\s*(\d+)$/);
    const limit = options.rankLimit
      ?? (topMatch ? parseInt(topMatch[1], 10) : bottomMatch ? parseInt(bottomMatch[2], 10) : 5);
    const n = Math.max(1, Math.min(limit || 5, all.length || 1));
    if (['worst', 'highest', 'max', 'maximum'].includes(lower) || topMatch) {
      matching = [...all].sort((a, b) => b.value - a.value).slice(0, n);
    } else if (['best', 'lowest', 'min', 'minimum'].includes(lower) || bottomMatch) {
      matching = [...all].sort((a, b) => a.value - b.value).slice(0, n);
    } else {
      throw new Error(
        `Unknown rank filter "${raw}". Use worst/highest, best/lowest, top:N, or bottom:N.`
      );
    }
  }

  return {
    parameter,
    parameterFull: parameterFullName(parameter),
    operator: loaded.operator,
    all,
    matching,
    matchingFeatures: matching.map((row) => ({
      ...row.feature,
      properties: {
        ...row.feature.properties,
        currentValue: row.value
      }
    })),
    highest,
    lowest
  };
}

/** Haversine distance in meters between two WGS84 points. */
export function distanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export interface LonLat {
  latitude: number;
  longitude: number;
}

/**
 * Keep sensors within `radiusMeters` of ANY reference point (building centroids, etc.).
 * Generic spatial filter — callers supply the points for whatever building class/query they need.
 */
export function filterSensorsNearPoints(
  sensors: SensorGeoJsonFeature[],
  points: LonLat[],
  radiusMeters: number
): Array<SensorGeoJsonFeature & { properties: Record<string, unknown> & { nearestDistanceM: number } }> {
  if (!points.length) return [];
  const out: Array<SensorGeoJsonFeature & { properties: Record<string, unknown> & { nearestDistanceM: number } }> = [];
  for (const feature of sensors) {
    const [lon, lat] = feature.geometry.coordinates;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    let nearest = Infinity;
    for (const p of points) {
      const d = distanceMeters(lat, lon, p.latitude, p.longitude);
      if (d < nearest) nearest = d;
    }
    if (nearest <= radiusMeters) {
      out.push({
        ...feature,
        properties: {
          ...feature.properties,
          nearestDistanceM: Math.round(nearest)
        }
      });
    }
  }
  out.sort(
    (a, b) =>
      (a.properties.nearestDistanceM as number) - (b.properties.nearestDistanceM as number)
  );
  return out;
}

/** Resolve casual class names to exact citygml_class_description values. */
export function resolveBuildingClass(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('building class is required');
  const key = raw.toLowerCase();
  const aliases: Record<string, string> = {
    school: 'schools, education, research',
    schools: 'schools, education, research',
    education: 'schools, education, research',
    research: 'schools, education, research',
    'schools, education, research': 'schools, education, research',
    hospital: 'healthcare',
    hospitals: 'healthcare',
    healthcare: 'healthcare',
    clinic: 'healthcare',
    clinics: 'healthcare',
    residential: 'habitation',
    habitation: 'habitation',
    housing: 'habitation',
    commercial: 'business, trade',
    business: 'business, trade',
    trade: 'business, trade',
    'business, trade': 'business, trade',
    office: 'business, trade',
    offices: 'business, trade',
    industrial: 'industry',
    industry: 'industry',
    sport: 'sport',
    sports: 'sport',
    recreation: 'sport',
    administration: 'administration',
    culture: 'culture',
    church: 'church institution',
    'church institution': 'church institution',
    storage: 'storage',
    traffic: 'traffic'
  };
  return aliases[key] || raw;
}

export function formatSensorNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return String(value);
  return String(Number(value.toFixed(digits)));
}

/** Latest measurements for one station via Sofia Sensors API. */
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
  const data = await sofiaSensorsFetch<{
    date_measured: string;
    measurements: Record<string, number | null>;
  }>('stations/station/lastmeasurements', { station_name: station });

  let longitude: number | null = null;
  let latitude: number | null = null;
  let operator = operatorForStationId(station);
  try {
    const stations = await fetchStationsByOperator(operator);
    const info = stations.find((s) => s.name.toUpperCase() === station);
    if (info) {
      longitude = info.longitude;
      latitude = info.latitude;
      try {
        operator = resolveOperator(info.operator) || operator;
      } catch {
        // keep guessed operator
      }
    }
  } catch {
    // coordinates optional
  }

  return {
    date_measured: data.date_measured || null,
    station_name: station,
    operator,
    measurements: flattenMeasurements(data.measurements),
    longitude,
    latitude
  };
}
