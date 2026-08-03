/**
 * AirQuality PostgreSQL Database Connection
 * Connects to the AirQuality database for historical pollution data queries
 */

import { Pool } from 'pg';

const AQ_DB_CONFIG = {
  host: process.env.AQ_DB_HOST || '10.2.0.51',
  port: parseInt(process.env.AQ_DB_PORT || '5432'),
  database: process.env.AQ_DB_NAME || 'AirQuality',
  user: process.env.AQ_DB_USER || 'diversea',
  password: process.env.AQ_DB_PASSWORD || 'diversea',
  connectionTimeoutMillis: 10000,
  query_timeout: 30000,
  max: 5,
  idleTimeoutMillis: 60000,
};

let aqPool: Pool | null = null;

export async function initializeAirQualityDB(): Promise<boolean> {
  try {
    aqPool = new Pool(AQ_DB_CONFIG);
    const client = await aqPool.connect();
    client.release();
    console.log('✅ AirQuality database connected successfully');
    return true;
  } catch (error) {
    console.error('❌ Failed to connect to AirQuality database:', error);
    return false;
  }
}

export function getAirQualityPool(): Pool {
  if (!aqPool) {
    throw new Error('AirQuality database not initialized. Call initializeAirQualityDB() first.');
  }
  return aqPool;
}

export async function closeAirQualityDB(): Promise<void> {
  if (aqPool) {
    await aqPool.end();
    aqPool = null;
    console.log('✅ AirQuality database connection closed');
  }
}

export interface PollutionReplayParams {
  startDate: string;
  hours: number;
  polygonId?: number;
  parameter?: 'PM10' | 'PM2.5';
}

/**
 * Fetches grid-point pollution data for replay visualization.
 * Returns data grouped by hour — each entry has an array of values (weighted_p1 for PM10,
 * weighted_p2 for PM2.5) ordered by grid_point_id to map 1:1 with the cloud primitives.
 */
export async function fetchPollutionReplayData(params: PollutionReplayParams): Promise<{
  hours: { hour: string; values: number[] }[];
  gridPointCount: number;
  hoursReturned: number;
}> {
  const pool = getAirQualityPool();
  const { startDate, hours, polygonId = 1, parameter = 'PM10' } = params;
  const maxHours = Math.min(hours, 168); // cap at 7 days

  const column = parameter === 'PM2.5' ? 'weighted_p2' : 'weighted_p1';

  const query = `
    SELECT gpm.measurement_hour, gpm.grid_point_id, gpm.${column} AS value
    FROM grid_point_measurements gpm
    JOIN grid_points gp ON gp.id = gpm.grid_point_id
    WHERE gp.polygon_id = $1
      AND gpm.measurement_hour >= $2::timestamptz
      AND gpm.measurement_hour < ($2::timestamptz + ($3 || ' hours')::interval)
    ORDER BY gpm.measurement_hour, gpm.grid_point_id
  `;

  const result = await pool.query(query, [polygonId, startDate, maxHours]);

  const hourMap = new Map<string, number[]>();
  for (const row of result.rows) {
    const hourKey = new Date(row.measurement_hour).toISOString();
    if (!hourMap.has(hourKey)) {
      hourMap.set(hourKey, []);
    }
    hourMap.get(hourKey)!.push(row.value);
  }

  const hourEntries = Array.from(hourMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, values]) => ({ hour, values }));

  return {
    hours: hourEntries,
    gridPointCount: hourEntries[0]?.values.length ?? 0,
    hoursReturned: hourEntries.length,
  };
}

export async function fetchGridPoints(polygonId: number = 1): Promise<any[]> {
  const pool = getAirQualityPool();
  const query = `
    SELECT id, latitude, longitude, altitude
    FROM grid_points
    WHERE polygon_id = $1
    ORDER BY id
  `;
  const result = await pool.query(query, [polygonId]);
  return result.rows;
}

const CITY_POLYGON_MAP: { polygonId: number; name: string; aliases: string[] }[] = [
  { polygonId: 1,  name: 'Sofia',  aliases: ['sofia', 'софія', 'софия'] },
  { polygonId: 15, name: 'Burgas', aliases: ['burgas', 'bourgas', 'бургас'] },
];

export function resolvePolygonByCity(cityName: string): { polygonId: number; name: string } | null {
  const needle = cityName.toLowerCase().trim();
  const match = CITY_POLYGON_MAP.find(
    c => c.name.toLowerCase() === needle || c.aliases.includes(needle)
  );
  return match ? { polygonId: match.polygonId, name: match.name } : null;
}

export function listAvailableCities(): string[] {
  return CITY_POLYGON_MAP.map(c => c.name);
}

export interface PredictionReplayParams {
  polygonId?: number;
  model?: string;
  /** Limit the number of forecast hours returned (default: all available) */
  hours?: number;
}

/**
 * Fetches forecast grid-point data from current_forecast_grid_points.
 * Supports both PM10 (p1) and PM2.5 (p2) columns where available.
 * Returns data grouped by hour, values ordered by point_id for 1:1 cloud mapping.
 */
export async function fetchPredictionReplayData(params: PredictionReplayParams): Promise<{
  hours: { hour: string; values: number[] }[];
  gridPointCount: number;
  hoursReturned: number;
  model: string;
  startDate: string;
  endDate: string;
}> {
  const pool = getAirQualityPool();
  const { polygonId = 1, model, hours } = params;
  // Predictions are PM10 only (p2 / PM2.5 does not exist in current_forecast_grid_points)
  const column = 'cfgp.p1';

  const conditions: string[] = ['gp.polygon_id = $1'];
  const queryParams: any[] = [polygonId];

  if (model) {
    queryParams.push(model);
    conditions.push(`cfgp.model = $${queryParams.length}`);
  }

  // If a horizon limit is requested, restrict to the first N distinct timestamps
  let limitClause = '';
  if (hours && hours > 0) {
    queryParams.push(hours);
    limitClause = `
      AND cfgp.timestamp IN (
        SELECT DISTINCT timestamp FROM current_forecast_grid_points
        WHERE model = cfgp.model
        ORDER BY timestamp ASC
        LIMIT $${queryParams.length}
      )`;
  }

  const query = `
    SELECT cfgp.timestamp, cfgp.point_id, ${column} AS value, cfgp.model
    FROM current_forecast_grid_points cfgp
    JOIN grid_points gp ON gp.id = cfgp.point_id
    WHERE ${conditions.join(' AND ')}${limitClause}
    ORDER BY cfgp.timestamp, cfgp.point_id
  `;

  const result = await pool.query(query, queryParams);

  let detectedModel = model || '';
  const hourMap = new Map<string, number[]>();
  for (const row of result.rows) {
    if (!detectedModel) detectedModel = row.model;
    const hourKey = new Date(row.timestamp).toISOString();
    if (!hourMap.has(hourKey)) hourMap.set(hourKey, []);
    hourMap.get(hourKey)!.push(row.value);
  }

  const hourEntries = Array.from(hourMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, values]) => ({ hour, values }));

  return {
    hours: hourEntries,
    gridPointCount: hourEntries[0]?.values.length ?? 0,
    hoursReturned: hourEntries.length,
    model: detectedModel,
    startDate: hourEntries[0]?.hour ?? '',
    endDate: hourEntries[hourEntries.length - 1]?.hour ?? '',
  };
}

export async function listAvailableModels(): Promise<string[]> {
  const pool = getAirQualityPool();
  const result = await pool.query('SELECT DISTINCT model FROM current_forecast_grid_points ORDER BY model');
  return result.rows.map((r: any) => r.model);
}

/**
 * Returns the number of distinct forecast hours available per model.
 * Used to populate tool descriptions accurately at startup.
 */
export async function getPredictionHorizonByModel(): Promise<{ model: string; hours: number; startDate: string; endDate: string }[]> {
  const pool = getAirQualityPool();
  const result = await pool.query(`
    SELECT
      model,
      COUNT(DISTINCT timestamp)                   AS hours,
      MIN(timestamp)::text                        AS start_date,
      MAX(timestamp)::text                        AS end_date
    FROM current_forecast_grid_points
    GROUP BY model
    ORDER BY model
  `);
  return result.rows.map((r: any) => ({
    model:     r.model,
    hours:     Number(r.hours),
    startDate: r.start_date,
    endDate:   r.end_date,
  }));
}
