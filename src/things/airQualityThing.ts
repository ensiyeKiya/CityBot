/**
 * AirQuality Thing — serves historical PM10 / PM2.5 grid data together with
 * machine-learning forecasts from the AirQuality PostgreSQL database, replayed
 * on the 3D map as animated colored clouds.
 */

import {
  fetchPollutionReplayData,
  fetchPredictionReplayData,
  fetchGridPoints,
  resolvePolygonByCity,
  listAvailableCities
} from '../airQualityDB';
import { tracer, THING_IDS, SECURITY_SCHEME, createEmitEvent, httpForm, mqttEventForm } from './shared';

const TITLE = 'airquality';

export interface AirQualityThingOptions {
  availableCities: string[];
  availableModels: string[];
  horizonSummary: string;
  maxPredictionHours: number;
}

export async function exposeAirQualityThing(WoT: any, options: AirQualityThingOptions): Promise<any> {
  const { availableCities, availableModels, horizonSummary, maxPredictionHours } = options;

  const thing = await WoT.produce({
    id: THING_IDS.airquality,
    title: TITLE,
    description: 'AirQuality Thing: historical PM10/PM2.5 grid data and machine-learning forecasts from a PostgreSQL database',
    ...SECURITY_SCHEME,
    properties: {},
    events: {
      pollutionReplay: {
        title: "Pollution Replay",
        description: "Fires when a pollution replay is started, providing grid-point pollution data per hour for cloud coloring animation",
        data: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["start", "stop"], description: "Whether to start or stop the replay" },
            gridPoints: {
              type: "array",
              description: "Grid point positions (id, latitude, longitude, altitude) — sent once with 'start' action",
              items: {
                type: "object",
                properties: {
                  id: { type: "number" },
                  latitude: { type: "number" },
                  longitude: { type: "number" },
                  altitude: { type: "number" }
                }
              }
            },
            hours: {
              type: "array",
              description: "Array of hourly snapshots, each containing an ISO hour string and an array of weighted_p1 values ordered by grid_point_id",
              items: {
                type: "object",
                properties: {
                  hour: { type: "string", format: "date-time" },
                  values: { type: "array", items: { type: "number" } }
                }
              }
            },
            hoursCount: { type: "number" },
            gridPointCount: { type: "number" },
            startDate: { type: "string" },
            intervalMs: { type: "number", description: "Milliseconds between each hour frame in the frontend animation" },
            timestamp: { type: "string", format: "date-time" }
          },
          required: ["action"]
        },
        forms: mqttEventForm(TITLE, 'pollutionReplay')
      }
    },
    actions: {
      replayPollution: {
        description: `Replays measured (historical) air pollution on the 3D map as animated colored clouds. Requires a startDate in the past; data available from 2017-02-20. Colors follow CAQI daily standard (green=good … dark red=hazardous). Available cities: ${availableCities.join(', ')}. Defaults to Sofia.`,
        input: {
          type: 'object',
          properties: {
            startDate: {
              type: 'string',
              description: 'Start date/time in ISO format for HISTORICAL data only (e.g. "2024-01-15T08:00:00"). Must not be in the future. Data available from 2017-02-20 to present.'
            },
            hours: {
              type: 'number',
              description: 'Number of hours to replay (1-168, max 7 days). Default: 24.',
              default: 24
            },
            intervalMs: {
              type: 'number',
              description: 'Animation speed — milliseconds between each hour frame on the frontend. Default: 1000 (1 second per hour).',
              default: 1000
            },
            city: {
              type: 'string',
              description: `City name for which to replay pollution data. Available: ${availableCities.join(', ')}. Defaults to "Sofia" if not specified.`
            },
            parameter: {
              type: 'string',
              enum: ['PM10', 'PM2.5'],
              description: 'Pollution parameter to replay. PM10 (particulate matter 10µm) or PM2.5 (particulate matter 2.5µm). Default: PM10.'
            }
          },
          required: ['startDate']
        },
        output: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            hoursCount: { type: 'number' },
            gridPointCount: { type: 'number' },
            startDate: { type: 'string' },
            endDate: { type: 'string' }
          }
        },
        forms: httpForm(TITLE, 'actions', 'replayPollution', ['invokeaction'])
      },
      replayPrediction: {
        description: `Replays ML-forecast PM10 air pollution as animated clouds. Playback starts from the current forecast hour (past forecast hours are skipped automatically); do not pass startDate. Hours 1–${maxPredictionHours}. Available cities: ${availableCities.join(', ')}. Forecast horizons: ${horizonSummary}. Defaults to Sofia.`,
        input: {
          type: 'object',
          properties: {
            city: {
              type: 'string',
              description: `City name for which to show prediction. Available: ${availableCities.join(', ')}. Defaults to "Sofia" if not specified.`
            },
            model: {
              type: 'string',
              ...(availableModels.length > 0 ? { enum: availableModels } : {}),
              description: availableModels.length > 0
                ? `ML model name to use for predictions. Available models: ${availableModels.join(', ')}. If not specified, uses the latest available model.`
                : 'ML model name to use for predictions. If not specified, uses the latest available model.'
            },
            hours: {
              type: 'number',
              description: `Number of forecast hours to show (1–${maxPredictionHours}). Defaults to all available hours (${maxPredictionHours}). Use a smaller value if the user only wants to see the next few hours.`,
              default: maxPredictionHours
            },
            intervalMs: {
              type: 'number',
              description: 'Animation speed — milliseconds between each hour frame. Default: 1000 (1 second per hour).',
              default: 1000
            }
          }
        },
        output: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            model: { type: 'string' },
            hoursCount: { type: 'number' },
            gridPointCount: { type: 'number' },
            startDate: { type: 'string' },
            endDate: { type: 'string' }
          }
        },
        forms: httpForm(TITLE, 'actions', 'replayPrediction', ['invokeaction'])
      },
      clearPollutionClouds: {
        description: 'Removes/clears all pollution or prediction clouds from the 3D map. Use this when the user asks to "remove clouds", "clear pollution", "stop replay", "hide clouds", or "clear the map" after a pollution or prediction replay has finished.',
        input: { type: 'object', properties: {} },
        output: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' }
          }
        },
        forms: httpForm(TITLE, 'actions', 'clearPollutionClouds', ['invokeaction'])
      }
    }
  });

  const emitEvent = createEmitEvent(thing);

  thing.setActionHandler('replayPollution', async (params: any) => {
    const span = tracer.startSpan('replayPollution');
    try {
      let input: any;
      if (params && typeof params.value === "function") {
        input = await params.value();
      } else {
        input = params || {};
      }
      const userId = input?._userId ?? null;
      const startDate = input.startDate;
      if (!startDate) {
        return { error: true, message: 'startDate is required (ISO format, e.g. "2024-01-15T08:00:00")' };
      }

      const startMs = Date.parse(startDate);
      if (!Number.isNaN(startMs) && startMs > Date.now() + 60 * 60 * 1000) {
        const userMessage =
          'That looks like a future time. Historical pollution replay cannot show forecasts — use the prediction tool for the next hours instead.';
        return {
          success: false,
          message: userMessage,
          userMessage,
          hint: 'Call replayPrediction (city Sofia, optional hours) instead of replayPollution for forecasts.'
        };
      }

      const hours = Math.min(Math.max(input.hours || 24, 1), 168);
      const intervalMs = input.intervalMs || 1000;
      const parameter = input.parameter || 'PM10';

      let polygonId = 1;
      const cityName = input.city;
      if (cityName) {
        const resolved = resolvePolygonByCity(cityName);
        if (!resolved) {
          const available = listAvailableCities();
          return {
            error: true,
            message: `No pollution data found for city "${cityName}". Available cities: ${available.join(', ')}`
          };
        }
        polygonId = resolved.polygonId;      }

      const [replayData, gridPoints] = await Promise.all([
        fetchPollutionReplayData({ startDate, hours, polygonId, parameter }),
        fetchGridPoints(polygonId),
      ]);

      if (replayData.hoursReturned === 0) {
        const userMessage = `I couldn't find historical pollution data starting ${startDate}. Try a past date, or ask for a forecast with the prediction tool.`;
        return {
          success: false,
          message: userMessage,
          userMessage,
        };
      }

      const endHour = replayData.hours[replayData.hours.length - 1].hour;
      const cityLabel = cityName || 'Sofia';
      const userMessage =
        `Historical ${parameter} pollution for ${cityLabel} is now playing on the map (${replayData.hoursReturned} hours from ${startDate}).`;

      await emitEvent('pollutionReplay', {
        action: 'start',
        userId,
        gridPoints: gridPoints.map((gp: any) => ({
          id: gp.id,
          latitude: Number(gp.latitude),
          longitude: Number(gp.longitude),
          altitude: gp.altitude ? Number(gp.altitude) : null,
        })),
        hours: replayData.hours,
        hoursCount: replayData.hoursReturned,
        gridPointCount: replayData.gridPointCount,
        parameter,
        startDate,
        intervalMs,
        appliedResult: { description: userMessage },
        timestamp: new Date().toISOString(),
      });
      return {
        success: true,
        message: userMessage,
        userMessage,
        hoursReturned: replayData.hoursReturned,
        gridPointCount: replayData.gridPointCount,
        startDate,
        endDate: endHour,
      };
    } catch (error) {
      console.error("❌ Error in replayPollution handler:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { error: true, message: `Failed to replay pollution: ${errorMessage}` };
    } finally {
      span.end();
    }
  });

  thing.setActionHandler('replayPrediction', async (params: any) => {
    const span = tracer.startSpan('replayPrediction');
    try {
      let input: any;
      if (params && typeof params.value === "function") {
        input = await params.value();
      } else {
        input = params || {};
      }
      const userId = input?._userId ?? null;
      const intervalMs = input.intervalMs || 1000;
      const model = input.model;
      const hours: number | undefined = input.hours ? Math.max(1, Math.round(input.hours)) : undefined;

      let polygonId = 1;
      const cityName = input.city;
      if (cityName) {
        const resolved = resolvePolygonByCity(cityName);
        if (!resolved) {
          const available = listAvailableCities();
          return {
            error: true,
            message: `No prediction data found for city "${cityName}". Available cities: ${available.join(', ')}`
          };
        }
        polygonId = resolved.polygonId;      }

      const [predictionData, gridPoints] = await Promise.all([
        fetchPredictionReplayData({ polygonId, model, hours }),
        fetchGridPoints(polygonId),
      ]);

      if (predictionData.hoursReturned === 0) {
        const userMessage = 'No air-quality forecast is available right now. The prediction may not have been generated yet.';
        return {
          success: false,
          message: userMessage,
          userMessage,
        };
      }

      const cityLabel = cityName || 'Sofia';
      let userMessage =
        `PM10 forecast for ${cityLabel} is now playing on the map`
        + ` — ${predictionData.hoursReturned} hours from ${predictionData.startDate}.`;

      await emitEvent('pollutionReplay', {
        action: 'start',
        userId,
        isPrediction: true,
        model: predictionData.model,
        gridPoints: gridPoints.map((gp: any) => ({
          id: gp.id,
          latitude: Number(gp.latitude),
          longitude: Number(gp.longitude),
          altitude: gp.altitude ? Number(gp.altitude) : null,
        })),
        hours: predictionData.hours,
        hoursCount: predictionData.hoursReturned,
        gridPointCount: predictionData.gridPointCount,
        parameter: 'PM10',
        startDate: predictionData.startDate,
        intervalMs,
        appliedResult: { description: userMessage },
        timestamp: new Date().toISOString(),
      });
      return {
        success: true,
        message: userMessage,
        userMessage,
        model: predictionData.model,
        hoursReturned: predictionData.hoursReturned,
        gridPointCount: predictionData.gridPointCount,
        startDate: predictionData.startDate,
        endDate: predictionData.endDate,
      };
    } catch (error) {
      console.error("❌ Error in replayPrediction handler:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { error: true, message: `Failed to replay prediction: ${errorMessage}` };
    } finally {
      span.end();
    }
  });

  thing.setActionHandler('clearPollutionClouds', async (params: any) => {
    const span = tracer.startSpan('clearPollutionClouds');
    try {
      let input: any = {};
      if (params && typeof params.value === 'function') input = await params.value();
      else if (params) input = params;
      const userId = input?._userId ?? null;
      await emitEvent('pollutionReplay', {
        action: 'stop',
        userId,
        timestamp: new Date().toISOString(),
      });      return { success: true, message: 'Pollution clouds cleared from the map.' };
    } catch (error) {
      console.error("❌ Error in clearPollutionClouds handler:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { error: true, message: `Failed to clear clouds: ${errorMessage}` };
    } finally {
      span.end();
    }
  });

  await thing.expose();  return thing;
}
