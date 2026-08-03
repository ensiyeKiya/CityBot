/**
 * Domain Things host.
 *
 * Starts one WoT servient (HTTP on WOT_SMARTBOT_PORT + MQTT) and exposes the
 * four Domain Things that give the Gateway — and through it, the LLM —
 * uniform access to the urban data:
 *
 *  - City Model Thing  (citymodel):  GATE Sofia tileset as Cesium 3D Tiles,
 *    camera navigation, visualization styles, building filters
 *  - AirQuality Thing  (airquality): historical PM10/PM2.5 grid data and ML
 *    forecasts from PostgreSQL
 *  - API Thing         (api):        OpenWeatherMap, Nominatim geocoding, and
 *    the environmental sensor network
 *  - Knowledge Thing   (knowledge):  building-level Wikipedia RAG pipeline
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import dotenv from 'dotenv';
import { initializeDatabase, closeDatabase } from './database';
import { initializeAirQualityDB, closeAirQualityDB, listAvailableModels, getPredictionHorizonByModel, listAvailableCities } from './airQualityDB';
import { startServient } from './things/shared';
import { exposeCityModelThing } from './things/cityModelThing';
import { exposeAirQualityThing } from './things/airQualityThing';
import { exposeApiThing } from './things/apiThing';
import { exposeKnowledgeThing } from './things/knowledgeThing';

// Initialize OpenTelemetry
new NodeSDK({}).start();

// Load environment variables
dotenv.config();

async function main() {
  // Initialize database connection
  console.log('🔌 Initializing database connection...');
  const dbInitialized = await initializeDatabase();
  if (!dbInitialized) {
    console.warn('⚠️ Database connection failed, some features may not work properly');
  }

  console.log('🔌 Initializing AirQuality database connection...');
  const aqDbInitialized = await initializeAirQualityDB();
  if (!aqDbInitialized) {
    console.warn('⚠️ AirQuality database connection failed, historical air quality queries will not work');
  }

  // Fetch real model list and forecast horizon from DB so the LLM tool description is always accurate
  let availableModels: string[] = [];
  let predictionHorizons: { model: string; hours: number; startDate: string; endDate: string }[] = [];
  if (aqDbInitialized) {
    try {
      availableModels = await listAvailableModels();
      console.log(`✅ Available prediction models: ${availableModels.join(', ') || '(none)'}`);
    } catch (e) {
      console.warn('⚠️ Could not fetch available models:', e);
    }
    try {
      predictionHorizons = await getPredictionHorizonByModel();
      predictionHorizons.forEach(h =>
        console.log(`✅ Model "${h.model}": ${h.hours}h forecast (${h.startDate} → ${h.endDate})`)
      );
    } catch (e) {
      console.warn('⚠️ Could not fetch prediction horizons:', e);
    }
  }

  // Build a human-readable summary of forecast availability for the tool description
  const horizonSummary = predictionHorizons.length > 0
    ? predictionHorizons.map(h => `"${h.model}": ${h.hours}h`).join(', ')
    : 'up to 24h (actual horizon fetched at runtime)';
  const maxPredictionHours = predictionHorizons.length > 0
    ? Math.max(...predictionHorizons.map(h => h.hours))
    : 24;

  const availableCities = listAvailableCities();

  // Start the servient hosting all Domain Things
  const { servient, WoT } = await startServient();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received. Shutting down WoT servient...`);
    try {
      await servient.shutdown();
      await closeDatabase();
      await closeAirQualityDB();
    } catch (e) { console.error('Shutdown error:', e); }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Expose the four Domain Things
  await exposeCityModelThing(WoT);
  await exposeAirQualityThing(WoT, { availableCities, availableModels, horizonSummary, maxPredictionHours });
  await exposeApiThing(WoT);
  await exposeKnowledgeThing(WoT);

  console.log(`✅ All Domain Things exposed at https://${process.env.SERVER_NAME}/{citymodel,airquality,api,knowledge}`);
}

main().catch((error) => {
  console.error(`Error: ${error}`);
});
