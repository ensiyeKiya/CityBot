/**
 * LLM Thing — AI core gateway: consumes the four Domain Things, exposes the
 * `llm` WoT Thing (conversation, STT, TTS), and serves the web UI + auth API.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { trace } from '@opentelemetry/api';
import { Servient, Helpers } from '@node-wot/core';
import { HttpClientFactory, HttpsClientFactory, HttpServer } from '@node-wot/binding-http';
import { ConsumedThing } from 'wot-typescript-definitions';
import * as dotenv from 'dotenv';
import OpenAI from 'openai';
import http from 'http';
import fetch from 'node-fetch';
import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from "fs";
import https from 'https';
import cors from "cors";
import { Request, Response } from 'express';
import { MqttClientFactory, MqttBrokerServer } from '@node-wot/binding-mqtt';
import { authenticateUser, createUser, initializeDefaultUser } from './auth';
import { initializeDatabase, getDatabaseClient, saveChatMessage, getChatHistory, clearUserChatHistory, getUserSessions, getSessionMessages, saveConversationTrace, saveUserFeedback, ConversationTrace, TraceStep } from './database';
import { THING_IDS } from './things/shared';

// Extend session data interface
declare module 'express-session' {
  interface SessionData {
    userId?: number;   // numeric PK from the users table
    email?: string;
    name?: string;
    authenticated?: boolean;
  }
}

// Authentication middleware
function requireAuth(req: Request, res: Response, next: Function) {
  if (req.session && req.session.authenticated) {
    next();
  } else {
    res.status(401).json({ success: false, message: 'Authentication required' });
  }
}

/** Numeric user PK from session — the sole identity key for chat data. */
function sessionUserId(req: Request): number | null {
  const id = req.session?.userId;
  return typeof id === 'number' && Number.isFinite(id) ? id : null;
}

function parseUserId(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

// Function to load system prompt from JSON file
function loadSystemPrompt(currentMapState: any, selectedBuildingParam?: any): string {
  try {
    const promptData = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/system-prompt.json'), 'utf8'));
    // Build separate enriched objects for map state and selected building
    const enrichedCurrentMapState = currentMapState ? {
      latitude: currentMapState.latitude,
      longitude: currentMapState.longitude,
      height: currentMapState.height,
      heading: currentMapState.heading,
      pitch: currentMapState.pitch,
      roll: currentMapState.roll,
      timestamp: currentMapState.timestamp
    } : null;

    const sb = selectedBuildingParam || null;
    const enrichedSelectedBuilding = sb ? {
      gmlId: sb.gmlId,
      name: sb.name,
      class: sb.class,
      function: sb.function,
      addr: sb.addr,
      latitude: sb.latitude,
      longitude: sb.longitude,
      height: sb.height,
      wiki_title_bg: sb.wiki_title_bg,
      wiki_pageid: sb.wiki_pageid,
      wikidata_instances: sb.wikidata_instances,
      walk_access_index: sb.walk_access_index,
      sunhrs_int_avg: sb.sunhrs_int_avg,
      timestamp: sb.timestamp
    } : null;

    const today = new Date().toISOString().slice(0, 10); // e.g. "2026-07-28"
    return promptData.systemPrompt
      .replace('{{TODAY}}', today)
      .replace('{{CURRENT_MAP_STATE}}', JSON.stringify(enrichedCurrentMapState))
      .replace('{{SELECTED_BUILDING}}', JSON.stringify(enrichedSelectedBuilding));
  } catch (error) {
    console.error('Error loading system prompt from JSON:', error);
    return `error loading system prompt from JSON: ${error}`;
  }
  }

/** Last assistant message in the conversation array. */
function getLastAssistantMessage(conversation: any[]): any | null {
  for (let i = conversation.length - 1; i >= 0; i--) {
    if (conversation[i]?.role === 'assistant') return conversation[i];
  }
  return null;
}

/**
 * When the last planning turn already returned a text answer with no tool calls,
 * reuse it and skip the extra final model call.
 */
function getDirectPlanningAnswer(conversation: any[]): string | null {
  const lastAssistant = getLastAssistantMessage(conversation);
  if (!lastAssistant) return null;
  const hasToolCalls = Array.isArray(lastAssistant.tool_calls) && lastAssistant.tool_calls.length > 0;
  const content = String(lastAssistant.content ?? '').trim();
  if (!hasToolCalls && content) return content;
  return null;
}

// Extend OpenAI params with Qwen‑specific options
type QwenChatCompletionParams =
  OpenAI.ChatCompletionCreateParamsNonStreaming & {
    chat_template_kwargs?: { enable_thinking?: boolean };
  };

type QwenChatCompletionParamsStream =
  OpenAI.ChatCompletionCreateParamsStreaming & {
        chat_template_kwargs?: { enable_thinking?: boolean };
  };

// Initialize OpenTelemetry
new NodeSDK({}).start();

// Get tracer
const tracer = trace.getTracer('llm-thing');

// Load environment variables
dotenv.config();

/** Parse OpenAI 429 retry delay from headers or error message body. */
function parseRateLimitWaitMs(error: any): number {
  const headerMs = error?.headers?.['retry-after-ms'];
  if (headerMs != null) {
    const n = parseInt(String(headerMs), 10);
    if (!isNaN(n)) return Math.min(n + 200, 60_000);
  }
  const retryAfter = error?.headers?.['retry-after'];
  if (retryAfter != null) {
    const sec = parseFloat(String(retryAfter));
    if (!isNaN(sec)) return Math.min(sec * 1000 + 200, 60_000);
  }
  const msg = String(error?.message ?? '');
  const msMatch = msg.match(/try again in (\d+)\s*ms/i);
  if (msMatch) return Math.min(parseInt(msMatch[1], 10) + 200, 60_000);
  const secMatch = msg.match(/try again in ([\d.]+)\s*s(?:ec)?/i);
  if (secMatch) return Math.min(parseFloat(secMatch[1]) * 1000 + 200, 60_000);
  return 2000;
}

/** Limits concurrent OpenAI calls so multi-user traffic stays under TPM burst. */
class ConcurrencyLimiter {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

const OPENAI_MAX_CONCURRENT = Math.max(1, Number(process.env.OPENAI_MAX_CONCURRENT ?? 2));
const openAiCallLimiter = new ConcurrencyLimiter(OPENAI_MAX_CONCURRENT);

async function withOpenAiRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 5
): Promise<T> {
  return openAiCallLimiter.run(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (e: any) {
        lastError = e;
        if (e?.status === 429 && attempt < maxAttempts - 1) {
          const waitMs = parseRateLimitWaitMs(e);
          console.warn(`⚠️ ${label} — 429 TPM rate limit, waiting ${waitMs}ms (attempt ${attempt + 1}/${maxAttempts})`);
          await new Promise((res) => setTimeout(res, waitMs));
          continue;
        }
        throw e;
      }
    }
    throw lastError;
  });
}


// Port configurations
const WOT_LLM_PORT = Number(process.env.WOT_LLM_PORT);
const WOT_SMARTBOT_PORT = Number(process.env.WOT_SMARTBOT_PORT);
const LOCAL_MODEL_PORT = Number(process.env.LOCAL_MODEL_PORT);
const WEB_PORT = Number(process.env.WEB_PORT);
const API_KEY = process.env.API_KEY;
const model_base_url = process.env.MODEL_BASE_URL;
const model_name = process.env.MODEL_NAME;
const temperature = Number(process.env.TEMPERATURE);
const max_tokens = Number(process.env.MAX_TOKENS);




/**
 * LLM Conversation Processing WoT Thing
 * This service consumes the main smartbot WoT thing and provides AI conversation capabilities
 */
async function main() {
  const insecureAgent = new https.Agent({ rejectUnauthorized: false });

  // Create servient for both client and server functionality
  const servient = new Servient();
  servient.addClientFactory(new HttpClientFactory());
  servient.addClientFactory(new HttpsClientFactory({ allowSelfSigned: true }));
  servient.addClientFactory(new MqttClientFactory());
  
  // Define MQTT connection parameters (same as smartbot service)
  const mqttUser = process.env.MQTT_USER;
  const mqttPass = process.env.MQTT_PASS;
  const mqttUri = `mqtt://${mqttUser}:${mqttPass}@${process.env.SERVER_NAME}:${process.env.MQTT_PORT || 1883}`;

  // Register MQTT credentials
  servient.addCredentials({
    [mqttUri]: {
      username: mqttUser,
      password: mqttPass
    }
  });
  
  // --- create the WoT HTTP server ---
  const httpServer = new HttpServer({
    address: '0.0.0.0',
    port: WOT_LLM_PORT,
    baseUri: `https://${process.env.SERVER_NAME}`,
    security: [{
      scheme: 'basic',
      cors: {
        origin: "*", // For development only, restrict in production
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "Accept"],
        credentials: true
      }
    }],
  });

  servient.addServer(httpServer);
  
  // Add MQTT server (same pattern as smartbot service)
  let mqttServer: MqttBrokerServer | null = null;
  
  // Only create MQTT server if credentials are available
  if (!mqttUser || !mqttPass) {
    console.warn('⚠️ MQTT credentials not set (MQTT_USER or MQTT_PASS missing). Skipping MQTT server.');
  } else {
    try {      mqttServer = new MqttBrokerServer({
        uri: mqttUri,
        clientId: 'smartbot-llm-server',
        rejectUnauthorized: false // Allow self-signed certificates
      });    } catch (error) {
      console.error('❌ MQTT server creation failed for LLM service:', error);
      console.error('❌ MQTT Error details:', {
        code: (error as any)?.code,
        message: (error as any)?.message,
        uri: mqttUri.replace(/:.*@/, ':***@') // Hide password in logs
      });
      console.warn('⚠️ Continuing without MQTT support. Some features may not work properly.');
      // Don't exit, try to continue without MQTT
    }
  }
  
  if (mqttServer) {
    servient.addServer(mqttServer);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    try { await servient.shutdown(); } catch (e) { console.error('Shutdown error:', e); }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  
  // Register credentials for consuming the four Domain Things
  servient.addCredentials(
    Object.fromEntries(
      Object.values(THING_IDS).map((id) => [id, {
        username: process.env.WOT_USERNAME,
        password: process.env.WOT_PASSWORD
      }])
    )
  );
  
  // Also register credentials for this LLM service to accept
  servient.addCredentials({
    "urn:dev:wot:com:smartbot:llm": {
      username: process.env.WOT_USERNAME,
      password: process.env.WOT_PASSWORD
    }
  });
  
  // Start servient
  const WoT = await servient.start();
  
  // Consume the four Domain Things with retry logic
  const DOMAIN_THING_TITLES = ['citymodel', 'airquality', 'api', 'knowledge'] as const;
  type DomainThingTitle = typeof DOMAIN_THING_TITLES[number];

  /** Canonical action list per Domain Thing — used to verify TD ↔ client alignment at startup. */
  const EXPECTED_DOMAIN_ACTIONS: Record<DomainThingTitle, readonly string[]> = {
    citymodel: ['flyTo', 'setCameraView', 'setVisualizationStyle', 'filterBuildings', 'loadTiles', 'removeTiles'],
    airquality: ['replayPollution', 'replayPrediction', 'clearPollutionClouds'],
    api: ['getWeather', 'getCoordinates', 'reverseGeocode'],
    knowledge: ['getWikipediaSummary']
  };

  const domainThings = new Map<DomainThingTitle, ConsumedThing>();
  const actionToThing = new Map<string, ConsumedThing>();
  const actionToDomain = new Map<string, DomainThingTitle>();
  let originalCityModelTD: any = null; // Original TD with external hrefs (for per-user TD generation)
  const maxRetries = 10;

  async function consumeDomainThing(title: DomainThingTitle): Promise<{ thing: ConsumedThing; td: any }> {
    const serverUrl = `http://localhost:${WOT_SMARTBOT_PORT}/${title}`;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const td = await WoT.requestThingDescription(serverUrl);
        const rewrittenTd = JSON.parse(
          JSON.stringify(td).replace(
            new RegExp(`https://${process.env.SERVER_NAME}`, 'g'),
            `http://localhost:${WOT_SMARTBOT_PORT}`
          )
        );
        const thing = await WoT.consume(rewrittenTd);        return { thing, td };
      } catch (error) {        if (attempt === maxRetries) {
          console.error(`❌ Failed to connect to ${title} Thing after all retries (${serverUrl})`);
          throw error;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error(`Failed to connect to ${title}`);
  }

  try {
    for (const title of DOMAIN_THING_TITLES) {
      const { thing, td } = await consumeDomainThing(title);
      domainThings.set(title, thing);
      if (title === 'citymodel') originalCityModelTD = td;
      const actions = td.actions || {};
      const actionNames = Object.keys(actions);
      for (const actionName of actionNames) {
        if (actionToThing.has(actionName)) {
          console.error(`❌ Duplicate action "${actionName}" on ${title} (already registered)`);
          process.exit(1);
        }
        actionToThing.set(actionName, thing);
        actionToDomain.set(actionName, title);
      }

      const expected = EXPECTED_DOMAIN_ACTIONS[title];
      const missing = expected.filter((a) => !actionNames.includes(a));
      const extra = actionNames.filter((a) => !expected.includes(a));
      if (missing.length > 0) {
        console.error(`❌ ${title} missing actions in TD: ${missing.join(', ')}`);
        process.exit(1);
      }
      if (extra.length > 0) {
        console.warn(`⚠️ ${title} has unexpected actions in TD: ${extra.join(', ')}`);
      }
    }    for (const title of DOMAIN_THING_TITLES) {
      const names = [...actionToDomain.entries()]
        .filter(([, t]) => t === title)
        .map(([a]) => a);    }  } catch (error) {
    console.error('❌ Failed to establish connection to Domain Things');    process.exit(1);
  }

  const citymodelThing = domainThings.get('citymodel')!;

  /** Route an LLM tool call to the Domain Thing that owns the action. */
  async function invokeDomainAction(toolName: string, args: any): Promise<any> {
    const thing = actionToThing.get(toolName);
    const domain = actionToDomain.get(toolName);
    if (!thing || !domain) {
      throw new Error(
        `Unknown action "${toolName}" — not found on any Domain Thing. ` +
        `Available (${actionToThing.size}): ${[...actionToThing.keys()].sort().join(', ')}`
      );
    }    return thing.invokeAction(toolName, args);
  }
  
  // Initialize local Qwen model client
  const localModel = new OpenAI({
    apiKey: API_KEY || "",
    baseURL: model_base_url || `http://localhost:${LOCAL_MODEL_PORT}/v1`
  });  
  type MapState = {
    latitude: number;
    longitude: number;
    height: number;
    heading: number;
    pitch: number;
    roll: number;
    timestamp: string;
  };

  type SelectedBuildingState = {
    gmlId: string | null;
    class: string | null;
    function: string | null;
    addr: string | null;
    latitude: number | null;
    longitude: number | null;
    height: number | string | null;
    wiki_title_bg: string | null;
    wiki_pageid: number | null;
    wikidata_instances: string | null;
    walk_access_index: number | null;
    sunhrs_int_avg?: number | null;
    timestamp: string | null;
  };

  const DEFAULT_MAP_STATE = (): MapState => ({
    latitude: 42.6977,
    longitude: 23.3219,
    height: 10000,
    heading: 0,
    pitch: -90,
    roll: 0,
    timestamp: new Date().toISOString()
  });

  const EMPTY_SELECTED_BUILDING = (): SelectedBuildingState => ({
    gmlId: null,
    class: null,
    function: null,
    addr: null,
    latitude: null,
    longitude: null,
    height: null,
    wiki_title_bg: null,
    wiki_pageid: null,
    wikidata_instances: null,
    walk_access_index: null,
    timestamp: null
  });

  const perUserMapState = new Map<string, MapState>();
  const perUserSelectedBuilding = new Map<string, SelectedBuildingState>();
  const sessionOwners = new Map<string, number>();

  function userContextKey(userId: number | string | null | undefined): string {
    if (userId == null || userId === '') return 'anonymous';
    return String(userId);
  }

  function getUserMapState(userKey: string): MapState {
    return perUserMapState.get(userKey) ?? DEFAULT_MAP_STATE();
  }

  function getUserSelectedBuilding(userKey: string): SelectedBuildingState {
    return perUserSelectedBuilding.get(userKey) ?? EMPTY_SELECTED_BUILDING();
  }

  function parseBuildingFromEvent(b: any): SelectedBuildingState {
    return {
      gmlId: b?.gmlId ?? null,
      class: b?.class ?? null,
      function: b?.function ?? null,
      addr: b?.addr ?? null,
      latitude: b?.coordinates?.latitude ?? null,
      longitude: b?.coordinates?.longitude ?? null,
      height: b?.coordinates?.height ?? b?.height ?? null,
      wiki_title_bg: b?.wiki_title_bg ?? null,
      wiki_pageid: b?.wiki_pageid ?? null,
      wikidata_instances: b?.wikidata_instances ?? null,
      walk_access_index: b?.walk_access_index ?? null,
      sunhrs_int_avg: b?.sunhrs_int_avg ?? null,
      timestamp: b?.timestamp || new Date().toISOString()
    };
  }

  function registerSessionOwner(sessionId: string, userId: number): void {
    sessionOwners.set(sessionId, userId);
  }

  function clearInMemorySessionsForUser(userId: number): void {
    for (const [sessionId, owner] of sessionOwners) {
      if (owner === userId) {
        userConversationHistories.delete(sessionId);
      }
    }
  }

  async function clearHistoryForUser(userId: number): Promise<void> {
    clearInMemorySessionsForUser(userId);
    await clearUserChatHistory(userId);
  }

  function applyMapViewEvent(mapEvent: any): void {
    const userKey = userContextKey(mapEvent?.userId);
    if (!mapEvent?.userId) {
      return;
    }
    if (mapEvent && typeof mapEvent === 'object' && 'coordinates' in mapEvent) {
      const nextState: MapState = {
        latitude: mapEvent.coordinates.latitude,
        longitude: mapEvent.coordinates.longitude,
        height: mapEvent.coordinates.height,
        heading: mapEvent.camera?.heading || 0,
        pitch: mapEvent.camera?.pitch || -90,
        roll: mapEvent.camera?.roll || 0,
        timestamp: mapEvent.time || new Date().toISOString()
      };
      perUserMapState.set(userKey, nextState);    }
  }

  async function applyBuildingSelectedEvent(b: any): Promise<void> {
    const userKey = userContextKey(b?.userId);
    if (!b?.userId) {
      return;
    }

    const previousGmlId = getUserSelectedBuilding(userKey).gmlId;
    const nextBuilding = parseBuildingFromEvent(b);
    const newGmlId = nextBuilding.gmlId;

    perUserSelectedBuilding.set(userKey, nextBuilding);
    if (previousGmlId && newGmlId && previousGmlId !== newGmlId) {      const ownerUserId = parseUserId(b?.userId);
      if (ownerUserId != null) {
        await clearHistoryForUser(ownerUserId);
      }
    }
  }

  function syncContextFromClientInput(userKey: string, input: any): { mapState: MapState; building: SelectedBuildingState } {
    if (input?.selectedBuilding && typeof input.selectedBuilding === 'object') {
      const building = parseBuildingFromEvent(input.selectedBuilding);
      perUserSelectedBuilding.set(userKey, building);    }
    if (input?.mapState && typeof input.mapState === 'object') {
      const ms = input.mapState;
      if (ms.latitude != null && ms.longitude != null) {
        const nextState: MapState = {
          latitude: ms.latitude,
          longitude: ms.longitude,
          height: ms.height ?? 10000,
          heading: ms.heading ?? 0,
          pitch: ms.pitch ?? -90,
          roll: ms.roll ?? 0,
          timestamp: ms.timestamp || new Date().toISOString()
        };
        perUserMapState.set(userKey, nextState);      }
    }
    return {
      mapState: getUserMapState(userKey),
      building: getUserSelectedBuilding(userKey)
    };
  }

  // Maintain conversation history per session (sessionId -> history array)
  const userConversationHistories = new Map<string, any[]>();

  // Load history from DB into the in-memory cache (no-op if already cached for this session)
  async function loadUserHistory(sessionId: string): Promise<void> {
    if (!userConversationHistories.has(sessionId)) {
      const dbHistory = await getChatHistory(sessionId, 20);
      userConversationHistories.set(sessionId, dbHistory);
    }
  }

  // Helper to get conversation history for a session (call loadUserHistory first)
  function getUserHistory(sessionId: string): any[] {
    if (!userConversationHistories.has(sessionId)) {
      userConversationHistories.set(sessionId, []);
    }
    return userConversationHistories.get(sessionId)!;
  }

  function getReusableConversationHistory(history: any[], maxMessages: number): any[] {
    return history
      .filter((message) => message?.role === 'user' || (message?.role === 'assistant' && !message?.tool_calls))
      .slice(-maxMessages);
  }

  function trimConversationHistory(history: any[], maxMessages: number): any[] {
    const reusableHistory = getReusableConversationHistory(history, maxMessages);
    while (reusableHistory.length > 0 && reusableHistory[0]?.role !== 'user') {
      reusableHistory.shift();
    }
    return reusableHistory;
  }

  try {
    await citymodelThing.subscribeEvent('mapView', async (data) => {
      const eventData = typeof data.value === 'function' ? await data.value() : data;
      applyMapViewEvent(eventData);
    });  } catch (error) {
    console.error('❌ Failed to subscribe to mapView events:', error);
  }

  try {
    await citymodelThing.subscribeEvent('buildingSelected' as any, async (data) => {      const eventData = typeof (data as any).value === 'function' ? await (data as any).value() : data;
      await applyBuildingSelectedEvent(eventData);
    });  } catch (error) {
    console.error('❌ Failed to subscribe to buildingSelected events:', error);
  }

  const BUILDING_CONTEXT_SCHEMA = {
    type: 'object' as const,
    properties: {
      gmlId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      coordinates: {
        type: 'object',
        properties: {
          latitude: { type: 'number' },
          longitude: { type: 'number' },
          height: { oneOf: [{ type: 'number' }, { type: 'string' }] }
        }
      },
      class: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      function: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      addr: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      wiki_title_bg: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      wiki_pageid: { oneOf: [{ type: 'number' }, { type: 'null' }] },
      wikidata_instances: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      walk_access_index: { oneOf: [{ type: 'number' }, { type: 'null' }] },
      sunhrs_int_avg: { oneOf: [{ type: 'number' }, { type: 'null' }] },
      timestamp: { type: 'string' }
    }
  };

  const CONVERSATION_ACTION_INPUT = {
    type: 'object' as const,
    properties: {
      message: {
        type: 'string',
        minLength: 1,
        maxLength: 1000,
        description: 'Message to process'
      },
      userId: {
        type: 'number',
        description: 'Numeric user PK from the users table'
      },
      sessionId: {
        type: 'string',
        description: 'Browser chat session id'
      },
      selectedBuilding: {
        oneOf: [
          BUILDING_CONTEXT_SCHEMA,
          { type: 'null' }
        ],
        description: 'Currently selected building from the browser (null if none selected)'
      },
      mapState: {
        oneOf: [
          {
            type: 'object',
            description: 'Current camera state from the browser',
            properties: {
              latitude: { type: 'number' },
              longitude: { type: 'number' },
              height: { type: 'number' },
              heading: { type: 'number' },
              pitch: { type: 'number' },
              roll: { type: 'number' },
              timestamp: { type: 'string' }
            }
          },
          { type: 'null' }
        ]
      }
    },
    required: ['message', 'userId']
  };
  
  // Create our LLM conversation processing WoT Thing
  const llmThing = await WoT.produce({
    id: "urn:dev:wot:com:smartbot:llm",
    title: 'llm',
    description: 'AI conversation processing service that interfaces with the SmartBot map system',
    securityDefinitions: {
      basic_sc: {
        scheme: "basic",
        in: "header"
      }
    },
    security: ["basic_sc"],
    properties: {
      status: {
        description: 'Current status of the LLM service',
        type: 'object',
        readOnly: true,
        properties: {
          modelConnected: { type: 'boolean' },
          smartbotConnected: { type: 'boolean' },
          currentMapState: { type: 'object' }
        }
      }
    },
    events: {
      conversationStream: {
        description: 'Token stream for a conversation request',
        data: {
          type: 'object',
          properties: {
            requestId: { type: 'string' },
            token: { type: 'string' },
            isFinal: { type: 'boolean' },
            metadata: { type: 'object' }
          }
        },
        forms: [
          {
            href: `mqtt://${process.env.SERVER_NAME}:1883/llm/events/conversationStream`,
            contentType: "application/json",
            subprotocol: "mqtt",
            op: ["subscribeevent", "unsubscribeevent"]
          }
        ]
      },
      sttProgress: {
        description: 'Speech-to-text transcription progress and results',
        data: {
          type: 'object',
          properties: {
            requestId: { type: 'string' },
            status: { 
              type: 'string', 
              enum: ['processing', 'completed', 'error'],
              description: 'Current status of the transcription'
            },
            text: { 
              type: 'string', 
              description: 'Transcribed text (available when status is completed)'
            },
            confidence: { 
              type: 'number', 
              minimum: 0, 
              maximum: 1,
              description: 'Confidence score of the transcription'
            },
            processingTime: { 
              type: 'number',
              description: 'Processing time in milliseconds'
            },
            error: { 
              type: 'string',
              description: 'Error message if status is error'
            }
          },
          required: ['requestId', 'status', 'text', 'processingTime', 'error']
        },
        forms: [
          {
            href: `mqtt://${process.env.SERVER_NAME}:1883/llm/events/sttProgress`,
            contentType: "application/json",
            subprotocol: "mqtt",
            op: ["subscribeevent", "unsubscribeevent"]
          }
        ]
      }
    },
    actions: {
      processConversation: {
        title: 'Process Conversation',
        description: 'Process a conversation message and return a final response (non-streaming). Includes timing breakdown (model vs tools).',
        input: CONVERSATION_ACTION_INPUT as any,
        output: {
          type: 'object',
          properties: {
            response: { type: 'string' },
            toolsUsed: { type: 'array', items: { type: 'string' } },
            processingTime: { type: 'number', description: 'Total server processing time in milliseconds' },
            processingTimeSeconds: { type: 'string' },
            modelTimeMs: { type: 'number', description: 'Time spent waiting on hosted model calls (ms)' },
            toolTimeMs: { type: 'number', description: 'Time spent executing tools (ms)' },
            otherServerTimeMs: { type: 'number', description: 'Server overhead time (ms) = processingTime - modelTimeMs - toolTimeMs' },
            modelSharePct: { type: 'number', description: 'Percent of server processing time spent in model calls (0-100)' },
            modelCalls: { type: 'number' },
            toolCalls: { type: 'number' },
            planningTurns: { type: 'number' },
            requestId: { type: 'string' },
            error: { type: 'boolean' },
            message: { type: 'string' }
          }
        },
        forms: [{
          href: `https://${process.env.SERVER_NAME}/llm/actions/processConversation`,
          contentType: 'application/json',
          op: ['invokeaction']
        }]
      },
      processConversationStream: {
        title: 'Process Conversation (Streaming)',
        description: 'Process a conversation message and emit tokens via conversationStream event',
        input: CONVERSATION_ACTION_INPUT as any,
        output: {
          type: 'object',
          properties: {
            requestId: { type: 'string' },
            started: { type: 'boolean' }
          },
          required: ['requestId', 'started']
        }
      },
      transcribeAudio: {
        title: 'Transcribe Audio (STT)',
        description: 'Transcribe audio to text using Whisper STT service with progress events',
        input: {
          type: 'object',
          properties: {
            audio: {
              type: 'string',
              description: 'Base64 encoded audio data (WebM, MP3, or WAV format)',
              minLength: 1
            },
            language: {
              type: 'string',
              description: 'Language code for transcription (default: en)',
              default: 'en'
            },
            task: {
              type: 'string',
              enum: ['transcribe', 'translate'],
              description: 'Task type: transcribe or translate to English',
              default: 'transcribe'
            },
            suppressNonSpeechTokens: {
              type: 'boolean',
              description: 'Suppress non-speech tokens in output',
              default: true
            },
            clientRequestId: {
              type: 'string',
              description: 'Optional client-generated request ID for tracking'
            }
          },
          required: ['audio']
        },
        output: {
          type: 'object',
          properties: {
            requestId: { type: 'string' },
            started: { type: 'boolean' },
            message: { type: 'string' }
          },
          required: ['requestId', 'started']
        }
      },
      textToSpeech: {
        title: 'Text to Speech (TTS)',
        description: 'Convert text to speech audio using Kokoro TTS model. Returns base64 encoded WAV audio data.',
        input: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'Text to convert to speech',
              minLength: 1,
              maxLength: 5000
            },
            language: {
              type: 'string',
              description: 'Language code (default: en)',
              default: 'en',
              enum: ['en', 'bg']
            },
            voice: {
              type: 'string',
              description: 'Voice ID for TTS. Male voices: am_adam (strong), am_michael (warm), am_fenrir (deep), am_puck (energetic), bm_george (British), bm_lewis (British), bm_daniel (British). Female voices: af_sarah, af_nicole, af_sky, bf_emma, bf_isabella. Default: am_adam',
              default: 'am_adam',
              enum: ['am_adam', 'am_michael', 'am_fenrir', 'am_puck', 'bm_george', 'bm_lewis', 'bm_daniel', 'bm_fable', 'af_sarah', 'af_nicole', 'af_sky', 'af_bella', 'bf_emma', 'bf_isabella']
            }
          },
          required: ['text']
        },
        output: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            audio: { 
              type: 'string',
              description: 'Base64 encoded WAV audio data'
            },
            format: { 
              type: 'string',
              description: 'Audio format (wav)'
            },
            processingTime: { 
              type: 'number',
              description: 'Processing time in milliseconds'
            },
            error: { type: 'string' }
          },
          required: ['success']
        },
        forms: [{
          href: `https://${process.env.SERVER_NAME}/llm/actions/textToSpeech`,
          contentType: 'application/json',
          op: ['invokeaction']
        }]
      }
    }
  });

  // Per-user MQTT client — publishes LLM events and subscribes to domain map/building events
  let llmMqttClient: any = null;
  try {
    const MqttLib = await import('mqtt');
    const pubUri = `mqtt://${process.env.SERVER_NAME || 'localhost'}:${process.env.MQTT_PORT || 1883}`;
    llmMqttClient = MqttLib.connect(pubUri, {
      username: process.env.MQTT_USER,
      password: process.env.MQTT_PASS,
      clientId: 'llm-mqtt-client',
      clean: true,
      rejectUnauthorized: false,
      reconnectPeriod: 5000
    });
    llmMqttClient.on('connect', () => {
      llmMqttClient.subscribe(
        ['smartbot/events/mapView', 'smartbot/events/buildingSelected'],
        { qos: 0 },
        (err: Error | null) => {
          if (err) {
            console.error('❌ Failed to subscribe to domain MQTT events:', err.message);
          }
        }
      );
    });
    llmMqttClient.on('message', (topic: string, payload: Buffer) => {
      try {
        const data = JSON.parse(payload.toString());
        if (topic.endsWith('buildingSelected')) {
          void applyBuildingSelectedEvent(data);
        } else if (topic.endsWith('mapView')) {
          applyMapViewEvent(data);
        }
      } catch (err: any) {
        console.warn(`⚠️ Invalid MQTT payload on ${topic}:`, err.message || String(err));
      }
    });
    llmMqttClient.on('error', (err: any) => console.error('❌ LLM MQTT client error:', err.message));
  } catch (err) {
    console.error('❌ Failed to create LLM MQTT client:', err);
  }

  /**
   * Emits an LLM event on the shared WoT topic and, when userId is provided,
   * also publishes to the per-user topic `llm/user/{userId}/events/{eventName}`.
   */
  function emitLLMEvent(userId: number | string | null | undefined, eventName: string, data: any): void {
    llmThing.emitEvent(eventName, data);
    if (userId != null && llmMqttClient?.connected) {
      const topic = `llm/user/${userId}/events/${eventName}`;
      llmMqttClient.publish(topic, JSON.stringify(data), { qos: 0 });
    }
  }

  // Build tool specifications from all Domain Thing Descriptions (one tool per action)
  const toolSpecs = DOMAIN_THING_TITLES.flatMap((title) => {
    const thing = domainThings.get(title)!;
    const td = thing.getThingDescription();
    if (!td.actions) return [];
    return Object.entries(td.actions).map(([name, action]: [string, any]) => ({
      type: 'function' as const,
      function: {
        name,
        description: `[${title}] ${action.description ?? ''}`.trim(),
        parameters: action.input ?? { type: 'object' },
      },
    }));
  });
  if (toolSpecs.length !== actionToThing.size) {
    console.warn(`⚠️ toolSpecs count (${toolSpecs.length}) ≠ action registry (${actionToThing.size})`);
  }
  llmThing.setActionHandler('processConversation', async (params: any) => {
    const span = tracer.startSpan('processConversation');
    try {
      let input: any;
      if (params && typeof params.value === "function") {
        input = await params.value();
      } else {
        input = params;
      }

      const message = String(input?.message ?? '').trim();
      const userId = parseUserId(input?.userId);
      const sessionId = String(input?.sessionId ?? `${userId ?? 'anon'}-${Date.now()}`).trim();

      if (!message) return { error: true, message: 'Message cannot be empty' };
      if (message.length > 1000) return { error: true, message: 'Message too long (max 1000 characters)' };
      if (userId == null) return { error: true, message: 'userId is required' };

      const userKey = userContextKey(userId);
      registerSessionOwner(sessionId, userId);

      const requestId = `llm-conv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const startTime = Date.now();

      const { mapState: userMapState, building: userSelectedBuilding } = syncContextFromClientInput(userKey, input);

      // Conversation context (scoped to this user)
      const systemPrompt = loadSystemPrompt(userMapState, userSelectedBuilding);
      await loadUserHistory(sessionId);
      const conversationHistory = getUserHistory(sessionId);
      const recentHistory = getReusableConversationHistory(conversationHistory, 10);

      const conversation: any[] = [
        { role: "system", content: systemPrompt },
        ...recentHistory,
        { role: "user", content: message }
      ];

      // Timing breakdown
      const toolsUsed: string[] = [];
      let modelTimeMs = 0;
      let toolTimeMs = 0;
      let modelCalls = 0;
      let toolCalls = 0;
      let planningTurns = 0;

      const maxPlanningTurns = 5;
      while (planningTurns < maxPlanningTurns) {
        planningTurns++;
        const planningStartMs = Date.now();        
        const planningResponse = await withOpenAiRetry(
          `planning turn ${planningTurns}`,
          () => localModel.chat.completions.create({
            model: model_name,
            messages: conversation,
            max_tokens: max_tokens,
            temperature: temperature,
            tools: toolSpecs,
            stream: false,
          } as QwenChatCompletionParams)
        );

        const planningElapsedMs = Date.now() - planningStartMs;
        modelTimeMs += planningElapsedMs;
        modelCalls += 1;

        const planMsg = planningResponse.choices?.[0]?.message;
        const assistantMsg: any = { role: "assistant", content: planMsg?.content || "" };
        if (planMsg?.tool_calls && planMsg.tool_calls.length > 0) {
          assistantMsg.tool_calls = planMsg.tool_calls;
        }
        conversation.push(assistantMsg);

        if (planMsg?.tool_calls && planMsg.tool_calls.length > 0) {
          for (const toolCall of planMsg.tool_calls) {
            const toolName = toolCall.function?.name;
            if (!toolName) continue;
            toolsUsed.push(toolName);
            toolCalls += 1;

            try {
              const args = JSON.parse(toolCall.function?.arguments || '{}');
              const toolStart = Date.now();
              const result = await invokeDomainAction(toolName, { ...args, _userId: userId });
              const toolElapsed = Date.now() - toolStart;
              toolTimeMs += toolElapsed;
              const toolResult = typeof result?.value === 'function' ? await result.value() : result;

              conversation.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: toolName,
                content: JSON.stringify(toolResult)
              });
            } catch (err) {
              conversation.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: toolName,
                content: JSON.stringify({ error: true, message: String(err) })
              });
            }
          }
          continue;
        }

        // No more tool calls needed
        break;
      }

      let finalContent = getDirectPlanningAnswer(conversation);
      let finalReasoning: string | null = null;

      if (finalContent) {      } else {
        // Tools ran or planning returned empty — generate final answer in a separate call
        const finalConversation = [
          ...conversation,
          {
            role: 'system',
            content: 'Now provide your final answer to the user. Do not use any tools. Give a clear, natural response based on the tool results you already have.'
          }
        ];

        const finalStartMs = Date.now();
        const finalResponse = await withOpenAiRetry(
          'final response',
          () => localModel.chat.completions.create({
            model: model_name,
            messages: finalConversation,
            max_tokens: max_tokens,
            temperature: temperature,
            stream: false,
          } as QwenChatCompletionParams)
        );
        const finalElapsedMs = Date.now() - finalStartMs;
        modelTimeMs += finalElapsedMs;
        modelCalls += 1;

        const finalMessage = finalResponse.choices?.[0]?.message as any;
        finalContent = String(finalMessage?.content ?? '').trim();
        finalReasoning = finalMessage?.reasoning_content ?? null;
      }
      if (!finalContent) {
        const processingTime = Date.now() - startTime;
        return {
          error: true,
          message: 'Empty model response',
          toolsUsed,
          processingTime,
          processingTimeSeconds: (processingTime / 1000).toFixed(2),
          modelTimeMs,
          toolTimeMs,
          otherServerTimeMs: Math.max(0, processingTime - modelTimeMs - toolTimeMs),
          modelSharePct: processingTime > 0 ? Math.round((modelTimeMs / processingTime) * 1000) / 10 : 0,
          modelCalls,
          toolCalls,
          planningTurns,
          requestId
        };
      }

      const processingTime = Date.now() - startTime;
      const otherServerTimeMs = Math.max(0, processingTime - modelTimeMs - toolTimeMs);
      const modelSharePct = processingTime > 0 ? Math.round((modelTimeMs / processingTime) * 1000) / 10 : 0;

      // Persist exchange to DB and update in-memory cache
      conversationHistory.push({ role: 'user', content: message }, { role: 'assistant', content: finalContent });
      userConversationHistories.set(sessionId, trimConversationHistory(conversationHistory, 6));
      await saveChatMessage(userId, sessionId, 'user', message);
      await saveChatMessage(userId, sessionId, 'assistant', finalContent);
      await saveConversationTrace({
        request_id: requestId,
        session_id: sessionId,
        user_id: userId,
        user_message: message,
        system_prompt: systemPrompt,
        planning_steps: [],
        final_response: finalContent,
        final_reasoning: finalReasoning,
        tools_used: toolsUsed,
        planning_turns: planningTurns,
        processing_time_ms: Date.now() - startTime,
        model_name: model_name ?? ''
      });

      return {
        response: finalContent,
        toolsUsed,
        processingTime,
        processingTimeSeconds: (processingTime / 1000).toFixed(2),
        modelTimeMs,
        toolTimeMs,
        otherServerTimeMs,
        modelSharePct,
        modelCalls,
        toolCalls,
        planningTurns,
        requestId,
        error: false
      };
    } catch (error: any) {
      return { error: true, message: String(error?.message || error) };
    } finally {
      span.end();
    }
  });

  llmThing.setActionHandler('processConversationStream', async (params: any) => {
    const span = tracer.startSpan('processConversationStream');
    try {
      let input;
      if (params && typeof params.value === "function") {
        input = await params.value();
      } else {
        input = params;
      }

      const message = String(input?.message ?? '').trim();
      const userId = parseUserId(input?.userId);
      const sessionId = String(input?.sessionId ?? `${userId ?? 'anon'}-${Date.now()}`).trim();
      
      if (!message) return { started: false, requestId: '', error: 'Message cannot be empty' };
      if (message.length > 1000) return { started: false, requestId: '', error: 'Message too long (max 1000 characters)' };
      if (userId == null) return { started: false, requestId: '', error: 'userId is required' };

      const userKey = userContextKey(userId);
      registerSessionOwner(sessionId, userId);

      const requestId = `llm-stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const startTime = Date.now();

      const { mapState: userMapState, building: userSelectedBuilding } = syncContextFromClientInput(userKey, input);

      // Build conversation with system prompt + history + new message
      const systemPrompt = loadSystemPrompt(userMapState, userSelectedBuilding);      
      // Load history from DB into cache on first access, then get in-memory ref
      await loadUserHistory(sessionId);
      const conversationHistory = getUserHistory(sessionId);
      
      // Limit conversation history to prevent token overflow and timeouts
      const maxHistoryMessages = 10;
      
      const recentHistory = getReusableConversationHistory(conversationHistory, maxHistoryMessages);
      
      const conversation: any[] = [
        { role: "system", content: systemPrompt },
        ...recentHistory,
        { role: "user", content: message }
      ];
      // Fire-and-forget streaming task
      (async () => {
        try {          
          // Multi-turn planning phase - execute tools until we get a final response
          const toolsUsed: string[] = [];
          let maxPlanningTurns = 5;
          let planningTurn = 0;

          // Trace object — grows turn-by-turn for fine-tuning / analysis
          const traceSteps: TraceStep[] = [];
          let currentTraceStep: TraceStep | null = null;

          let inputMessagesSnapshot: any[] = [];

          while (planningTurn < maxPlanningTurns) {
            planningTurn++;
            const planningStartMs = Date.now();

            // Emit planning progress update
            emitLLMEvent(userId, 'conversationStream', { 
              requestId, 
              token: '', 
              isFinal: false, 
              metadata: { 
                planningUpdate: `🧠 Planning turn ${planningTurn}/${maxPlanningTurns}...`,
                currentTurn: planningTurn,
                maxTurns: maxPlanningTurns
              } 
            });
            
            // Add progress indicator for long-running calls (only in interactive terminals)
            let progressInterval: NodeJS.Timeout | null = null;
            const isTTY = process.stdout.isTTY; // Only show progress in actual terminals
            const startProgressIndicator = () => {
              if (!isTTY) return; // Skip if not in a terminal (e.g., PM2, Docker logs)
              let dots = 0;
              progressInterval = setInterval(() => {
                dots = (dots + 1) % 4;
                process.stdout.write(`\r🧪 Calling model for planning turn${'.'.repeat(dots)}${' '.repeat(3-dots)}`);
              }, 500);
            };
            
            const stopProgressIndicator = () => {
              if (progressInterval) {
                clearInterval(progressInterval);
                if (isTTY) {
                  process.stdout.write('\r'); // Clear the line (only in TTY)
                }
              }
            };
            
            let planningResponse: any;
            try {
              // Start progress indicator after 2 seconds (only if in TTY)
              if (isTTY) {
                setTimeout(startProgressIndicator, 2000);
              }
              
              const planningTimeout = 60000;
              const abortController = new AbortController();
              const timeoutId = setTimeout(() => abortController.abort(), planningTimeout);
              
              const payloadSize = JSON.stringify(conversation).length;
              const msgRoles = conversation.map((m: any) => m.role + (m.tool_calls ? `(${m.tool_calls.length} calls)` : '')).join(', ');
              // Snapshot the full input context for the trace BEFORE the model call
              inputMessagesSnapshot = conversation.map((m: any) => ({
                role: m.role,
                content: m.content ?? null,
                ...(m.tool_calls   ? { tool_calls: m.tool_calls }     : {}),
                ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
                ...(m.name         ? { name: m.name }                 : {})
              }));
              
              try {
                planningResponse = await withOpenAiRetry(
                  `stream planning turn ${planningTurn}`,
                  () => localModel.chat.completions.create({
                    model: model_name,
                    messages: conversation,
                    max_tokens: max_tokens,
                    temperature: temperature,
                    tools: toolSpecs,
                    stream: false,
                  } as QwenChatCompletionParams, { signal: abortController.signal })
                );
              } catch (e: any) {
                if (e.name === 'AbortError' || abortController.signal.aborted) {
                  throw new Error(`Planning model call timeout after ${planningTimeout / 1000} seconds`);
                }
                throw e;
              } finally {
                clearTimeout(timeoutId);
              }
              
              // Stop progress indicator
              stopProgressIndicator();
              
            } catch (modelError: any) {
              // Stop progress indicator
              stopProgressIndicator();
              
              const planningElapsedMs = Date.now() - planningStartMs;
              console.error(`❌ Model failed | Turn ${planningTurn} | ${planningElapsedMs}ms | ${modelError?.message || 'Unknown error'}`);
              
              // Emit error event to client
              emitLLMEvent(userId, 'conversationStream', { 
                requestId, 
                token: '', 
                isFinal: true, 
                error: true,
                metadata: { 
                  error: `Model call failed on planning turn ${planningTurn}: ${modelError?.message || 'Unknown error'}`,
                  errorType: typeof modelError,
                  errorCode: modelError?.code,
                  errorStatus: modelError?.status,
                  planningTurn: planningTurn,
                  maxTurns: maxPlanningTurns
                } 
              });
              
              throw new Error(`Model call failed on planning turn ${planningTurn}: ${modelError?.message || 'Unknown error'}`);
            }
            
            const planningElapsedMs = Date.now() - planningStartMs;
            const planMsg = planningResponse.choices[0].message;
            const toolCallsCount = planMsg.tool_calls?.length || 0;
            const tokensUsed = planningResponse.usage?.total_tokens || 'N/A';            if (toolCallsCount > 0) {              planMsg.tool_calls?.forEach((tc: any, idx: number) => {              });
            }

            // Detect repeated plans that could indicate a loop
            const planSignature = JSON.stringify({
              content: (planMsg.content || '').trim(),
              tools: (planMsg.tool_calls || []).map((t: any) => ({ name: t.function?.name, args: t.function?.arguments }))
            });
            (global as any).__lastPlanSignature = (global as any).__lastPlanSignature || '';
            (global as any).__repeatPlanCount = (global as any).__repeatPlanCount || 0;
            if ((global as any).__lastPlanSignature === planSignature) {
              (global as any).__repeatPlanCount += 1;
              console.warn(`⚠️ Planning produced an identical response ${ (global as any).__repeatPlanCount } time(s) in a row.`);
            } else {
              (global as any).__repeatPlanCount = 0;
              (global as any).__lastPlanSignature = planSignature;
            }

            // Add assistant message to conversation
            const assistantMsg: any = { role: "assistant", content: planMsg.content || "" };
            if (planMsg.tool_calls && planMsg.tool_calls.length > 0) {
              assistantMsg.tool_calls = planMsg.tool_calls;
            }
            conversation.push(assistantMsg);

            // Start a trace step for this planning turn
            currentTraceStep = {
              turn: planningTurn,
              input_messages: inputMessagesSnapshot,
              assistant_content: planMsg.content || '',
              reasoning_content: (planMsg as any).reasoning_content ?? null,
              tool_calls: (planMsg.tool_calls || []).map((tc: any) => ({
                id: tc.id,
                name: tc.function?.name,
                args: (() => { try { return JSON.parse(tc.function?.arguments || '{}'); } catch { return {}; } })()
              })),
              tool_results: [],
              tokens_used: planningResponse.usage?.total_tokens ?? null,
              time_ms: planningElapsedMs
            };

            // Check if tools were called
            if (planMsg.tool_calls && planMsg.tool_calls.length > 0) {              
              // Execute all tool calls for this planning turn
              for (const toolCall of planMsg.tool_calls) {
                const toolName = toolCall.function.name;
                toolsUsed.push(toolName);
                
                try {
              const args = JSON.parse(toolCall.function.arguments || '{}');
              // Inject caller identity so the smartbot can scope events to this user
              const enrichedArgs = { ...args, _userId: userId };
              
              // Log tool call details              
              // Emit tool execution update
              emitLLMEvent(userId, 'conversationStream', { 
                requestId, 
                token: '', 
                isFinal: false, 
                metadata: { 
                  planningUpdate: `🔧 Executing ${toolName}...`,
                  toolExecution: toolName
                } 
              });
              
              const toolStart = Date.now();
              const result = await invokeDomainAction(toolName, enrichedArgs);
                  const toolElapsed = Date.now() - toolStart;
                  const toolResult = typeof result?.value === 'function' ? await result.value() : result;
                  
                  // Log tool result                  
                  // Add tool result to conversation
                  conversation.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    name: toolName,
                    content: JSON.stringify(toolResult)
                  });

                  // Record in trace
                  currentTraceStep?.tool_results.push({
                    tool_call_id: toolCall.id,
                    name: toolName,
                    args,
                    result: toolResult,
                    time_ms: toolElapsed
                  });
                  
                } catch (err) {
                  console.error(`  ❌ Tool ${toolName} error:`, err);
                  console.error(`  ❌ Error details:`, {
                    message: err instanceof Error ? err.message : String(err),
                    stack: err instanceof Error ? err.stack : 'No stack'
                  });
                  conversation.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    name: toolName,
                    content: JSON.stringify({ error: true, message: String(err) })
                  });
                  currentTraceStep?.tool_results.push({
                    tool_call_id: toolCall.id,
                    name: toolName,
                    args: {},
                    result: { error: String(err) },
                    time_ms: 0
                  });
                }
              }              if (currentTraceStep) traceSteps.push(currentTraceStep);

              // Continue planning - LLM can now use tool results for next turn
              continue;
              
            } else {
              // No more tool calls - planning is complete              if (currentTraceStep) traceSteps.push(currentTraceStep);
              break;
            }
          }

          if (planningTurn >= maxPlanningTurns) {          }

          const directPlanningAnswer = getDirectPlanningAnswer(conversation);
          let finalContent = '';

          if (directPlanningAnswer) {
            finalContent = directPlanningAnswer;            emitLLMEvent(userId, 'conversationStream', {
              requestId,
              token: '',
              isFinal: false,
              metadata: {
                planningUpdate: '✅ Planning complete, using direct answer...',
                planningComplete: true,
                skippedFinalCall: true
              }
            });
            emitLLMEvent(userId, 'conversationStream', { requestId, token: finalContent, isFinal: false });
          } else {
            // Emit completion of planning phase
            emitLLMEvent(userId, 'conversationStream', {
              requestId,
              token: '',
              isFinal: false,
              metadata: {
                planningUpdate: '✅ Planning complete, generating response...',
                planningComplete: true
              }
            });

            // Stream the final message to clients via WoT event
            const streamTimeout = 60000; // 60 second timeout
            const streamStartTime = Date.now();
            let streamCreated = false;

            try {
              const finalConversation = [
                ...conversation,
                {
                  role: 'system',
                  content: 'Now provide your final answer to the user. Do not use any tools. Give a clear, natural response based on the tool results you already have, and offer helpful follow-up suggestions.'
                }
              ];

              const streamAbort = new AbortController();
              const streamTimeoutId = setTimeout(() => streamAbort.abort(), 10000);
              let stream: any;
              try {
                stream = await withOpenAiRetry(
                  'final stream',
                  () => localModel.chat.completions.create({
                    model: model_name,
                    messages: finalConversation,
                    max_tokens: max_tokens,
                    temperature: temperature,
                    stream: true,
                  } as QwenChatCompletionParamsStream, { signal: streamAbort.signal })
                );
              } catch (e: any) {
                if (e.name === 'AbortError' || streamAbort.signal.aborted) {
                  throw new Error('Stream creation timeout');
                }
                throw e;
              } finally {
                clearTimeout(streamTimeoutId);
              }

              streamCreated = true;
              let chunkCount = 0;
              let lastChunkTime = Date.now();

              for await (const chunk of stream) {
                const now = Date.now();

                if (now - streamStartTime > streamTimeout) {
                  console.error('❌ Stream timeout exceeded');
                  throw new Error('Stream processing timeout exceeded');
                }

                if (now - lastChunkTime > 30000) {
                  console.error('❌ Chunk timeout (30s)');
                  throw new Error('Stream chunk timeout');
                }

                const token = chunk.choices?.[0]?.delta?.content;
                if (token) {
                  chunkCount++;
                  lastChunkTime = now;
                  finalContent += token;
                  emitLLMEvent(userId, 'conversationStream', { requestId, token, isFinal: false });

                  if (chunkCount === 1) {                  }
                }
              }
            } catch (streamError) {
              console.error('❌ Streaming error:', streamError);

              if (finalContent.length > 0) {              } else if (streamCreated) {
                finalContent = 'The operation completed successfully, but I encountered an issue generating the response. The action has been executed.';
              } else {
                finalContent = 'I successfully executed your request (loaded the tiles), though I had trouble connecting to the response generator.';
              }
            }

            finalContent = finalContent.trim();
          }

          const processingTime = Date.now() - startTime;
          const processingTimeSeconds = (processingTime / 1000).toFixed(2);
          // Emit final metadata and save conversation history
          emitLLMEvent(userId, 'conversationStream', { 
            requestId, 
            token: '', 
            isFinal: true, 
            metadata: { 
              response: finalContent, 
              toolsUsed, 
              processingTime: processingTime,
              processingTimeSeconds: processingTimeSeconds
            } 
          });

          // Store only the user message and the final streamed answer.
          // Intermediate planning messages must NOT be stored: the last planning
          // message duplicates finalContent, producing [assistant, assistant]
          // pairs in history that teach the model to answer action requests
          // without tool calls (tool messages are filtered out of history).
          conversationHistory.push(
            { role: 'user', content: message },
            { role: 'assistant', content: finalContent }
          );

          // Persist user message and final assistant response to DB
          await saveChatMessage(userId, sessionId, 'user', message);
          await saveChatMessage(userId, sessionId, 'assistant', finalContent);

          // Save full reasoning trace for fine-tuning / analysis
          const trace: ConversationTrace = {
            request_id: requestId,
            session_id: sessionId,
            user_id: userId,
            user_message: message,
            system_prompt: systemPrompt,
            planning_steps: traceSteps,
            final_response: finalContent,
            final_reasoning: null, // streaming mode: reasoning not available chunk-by-chunk
            tools_used: toolsUsed,
            planning_turns: planningTurn,
            processing_time_ms: processingTime,
            model_name: model_name ?? ''
          };
          await saveConversationTrace(trace);
          
          // Enhanced cleanup to prevent token overflow
          // Keep fewer messages since Wikipedia now returns FULL complete articles
          const maxStoredMessages = 6;
          if (conversationHistory.length > maxStoredMessages) {
            const trimmedHistory = trimConversationHistory(conversationHistory, maxStoredMessages);
            userConversationHistories.set(sessionId, trimmedHistory);          } else {
            userConversationHistories.set(sessionId, trimConversationHistory(conversationHistory, maxStoredMessages));
          }
          
          // Log current conversation history size with breakdown
          const historyLength = JSON.stringify(conversationHistory).length;
          const toolMsgCount = conversationHistory.filter(m => m.role === 'tool').length;
        } catch (err) {
          emitLLMEvent(userId, 'conversationStream', { requestId, token: '', isFinal: true, metadata: { error: String(err) } });
        }
      })();

      return { started: true, requestId };
    } catch (error) {
      console.error('processConversationStream error:', error);
      return { started: false, requestId: '', error: 'Failed to start streaming' };
    } finally {
      span.end();
    }
  });

  // Set up transcribeAudio action handler
  llmThing.setActionHandler('transcribeAudio', async (params: any) => {
    const span = tracer.startSpan('transcribeAudio');
    
    try {
      let input;
      if (params && typeof params.value === "function") {
        input = await params.value();
      } else {
        input = params;
      }


      const audio = String(input?.audio ?? '').trim();
      const sttUserId: number | string | null = input?.userId ?? null;

      if (!audio) {
        return { started: false, requestId: '', message: 'Audio data cannot be empty' };
      }

      const language = String(input?.language ?? 'en');
      const task = String(input?.task ?? 'transcribe');
      const suppressNonSpeechTokens = Boolean(input?.suppressNonSpeechTokens ?? true);
      
      // Use clientRequestId from frontend if provided, otherwise generate one
      const requestId = String(input?.clientRequestId ?? '') || `stt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const startTime = Date.now();

      // Fire-and-forget transcription task
      (async () => {
        
        try {
          // Emit processing status
          emitLLMEvent(sttUserId, 'sttProgress', {
            requestId: requestId,
            status: 'processing',
            text: '', // Always include text field
            confidence: 0, // Default confidence for processing status
            processingTime: 0,
            error: '' // Always include error field
          });

          // Convert base64 audio to buffer
          let audioBuffer: Buffer;
          try {
            
            // Handle data URLs (data:audio/webm;base64,...)
            const base64Data = audio.includes(',') ? audio.split(',')[1] : audio;
            
            audioBuffer = Buffer.from(base64Data, 'base64');
          } catch (err) {
            throw new Error('Invalid base64 audio data');
          }
          // Call Whisper API
          const apiCallStart = performance.now();
          const response = await fetch("https://api.deepinfra.com/v1/inference/openai/whisper-large-v3-turbo", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.DEEPINFRA_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              audio: audioBuffer.toString('base64'),
              language: language,
              task: task,
              suppress_non_speech_tokens: suppressNonSpeechTokens
            })
          });

          const apiCallTime = performance.now() - apiCallStart;
          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`STT API error: ${response.status} - ${errorText}`);
          }

          const result = await response.json();
          const totalProcessingTime = Date.now() - startTime;
          // Emit completion status
          emitLLMEvent(sttUserId, 'sttProgress', {
            requestId: requestId,
            status: 'completed',
            text: result.text || '',
            confidence: result.confidence || 0,
            processingTime: totalProcessingTime,
            error: '' // Always include error field
          });

        } catch (err) {
          const totalProcessingTime = Date.now() - startTime;
          
          // Emit error status
          emitLLMEvent(sttUserId, 'sttProgress', {
            requestId: requestId,
            status: 'error',
            text: '', // Always include text field
            confidence: 0, // Default confidence for error status
            processingTime: totalProcessingTime,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      })();

      return { started: true, requestId, message: 'Transcription started' };
    } catch (error) {
      return { started: false, requestId: '', message: 'Failed to start transcription' };
    } finally {
      span.end();
    }
  });

  // Shared TTS processing function
  const processTextToSpeech = async (text: string, language: string = 'en', voice: string = 'am_adam') => {
    const requestStart = performance.now();
    
    try {      
      // Validation
      if (!text || text.trim().length === 0) {
        return { success: false, error: 'Text parameter is required' };
      }
      if (text.length > 5000) {
        return { success: false, error: 'Text too long (max 5000 characters)' };
      }
      // Call DeepInfra Kokoro API
      const apiCallStart = performance.now();
      
      // Try different voice parameters for Kokoro TTS
      // Based on documentation, Kokoro supports voice selection
      const requestBody = { 
        text, 
        language,
        preset_voice: voice,
        speed: 1.0
      };
      
      const response = await fetch("https://api.deepinfra.com/v1/inference/hexgrad/Kokoro-82M", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.DEEPINFRA_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      });

      logServerTiming('TTS API Call', apiCallStart);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ TTS API error: ${response.status} - ${errorText}`);
        return { 
          success: false, 
          error: `TTS API error: ${response.status} - ${errorText}` 
        };
      }

      const processingStart = performance.now();
      const responseText = await response.text();

      let parsed;
      try {
        parsed = JSON.parse(responseText);
      } catch (err) {
        console.error("❌ TTS JSON parse failed:", err);
        return { 
          success: false, 
          error: "Invalid JSON in TTS response" 
        };
      }

      const audioBase64 = parsed.audio;
      
      if (!audioBase64 || typeof audioBase64 !== "string" || audioBase64.length < 100) {
        console.error("❌ Invalid or missing audio base64 string");
        return { 
          success: false, 
          error: "No or bad audio data from TTS service" 
        };
      }

      // Extract base64 content (remove data URL prefix if present)
      const base64Content = audioBase64.includes(',') ? audioBase64.split(',')[1] : audioBase64;

      logServerTiming('TTS Processing', processingStart);
      const totalTime = performance.now() - requestStart;
      logServerTiming('TTS Total', requestStart);
      return {
        success: true,
        audio: base64Content,
        format: 'wav',
        processingTime: totalTime
      };

    } catch (err) {
      logServerTiming('TTS Error', requestStart);
      console.error("❌ TTS error:", err);
      console.error("❌ TTS error stack:", err instanceof Error ? err.stack : 'No stack trace');
      console.error("❌ TTS error type:", typeof err);
      return { 
        success: false, 
        error: err instanceof Error ? err.message : String(err) 
      };
    }
  };

  // Text-to-Speech action handler
  llmThing.setActionHandler('textToSpeech', async (params: any) => {
    const span = tracer.startSpan('textToSpeech');
    
    try {
      
      let input;
      if (params && typeof params.value === "function") {
        input = await params.value();
      } else {
        input = params;
      }

      const text = String(input?.text ?? '').trim();
      const language = input?.language || 'en';
      const voice = input?.voice || 'am_adam'; // Default to male voice
      
      const result = await processTextToSpeech(text, language, voice);
      
      return result;

    } catch (err) {
      console.error("❌ TTS action handler error:", err);
      console.error("❌ TTS action handler error stack:", err instanceof Error ? err.stack : 'No stack trace');
      console.error("❌ TTS action handler error type:", typeof err);
      return { 
        success: false, 
        error: err instanceof Error ? err.message : String(err) 
      };
    } finally {
      span.end();
    }
  });

  // Set up status property handler
  llmThing.setPropertyReadHandler('status', async () => {
    return {
      modelConnected: true, // Could add actual health check
      smartbotConnected: domainThings.size === DOMAIN_THING_TITLES.length,
      domainThings: Object.fromEntries(
        DOMAIN_THING_TITLES.map((title) => [
          title,
          {
            connected: domainThings.has(title),
            actions: [...actionToDomain.entries()]
              .filter(([, t]) => t === title)
              .map(([a]) => a)
          }
        ])
      ),
      multiUserContext: true,
      activeUserContexts: perUserMapState.size,
      timestamp: new Date().toISOString()
    };
  });

  // Expose the LLM Thing
  try {    const td = llmThing.getThingDescription();    
    
    await llmThing.expose();
    const thingId = td.id?.split(':').pop() || 'llm';  
  } catch (error) {
    console.error('❌ Failed to expose LLM Thing:', error);
    throw error;
  }
  
  // Initialize database connection
  const dbConnected = await initializeDatabase();
  if (!dbConnected) {
    console.error('⚠️ Database connection failed. Authentication features will not work properly.');
  }
  
  // // Initialize default admin user
  // await initializeDefaultUser();
  
  // ------------------- Web Server Setup -------------------
  const app = express();
  
  // Trust proxy - required for secure cookies behind Nginx reverse proxy
  app.set('trust proxy', 1);
  
  // Session configuration — PostgreSQL store (survives restarts, safe for production)
  const sessionSecret = process.env.SESSION_SECRET || 'change-this-secret-in-production';
  const PgSession = connectPgSimple(session);
  const sessionStore = dbConnected
    ? new PgSession({
        pool: getDatabaseClient(),
        tableName: 'session',
        pruneSessionInterval: 60 * 15 // drop expired rows every 15 minutes
      })
    : undefined;

  if (!dbConnected) {
    console.error('❌ Session store unavailable — database not connected');
  }

  app.use(cookieParser());
  app.use(session({
    store: sessionStore,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: true, // Secure cookies for HTTPS - requires trust proxy and X-Forwarded-Proto
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      sameSite: 'lax' // Allow cookies to be sent on same-site requests
    },
    proxy: true // Trust the reverse proxy
  }));
  
  app.use(express.json());

  // Serve static assets
  const templatesDir = path.join(__dirname, '../templates');
  const staticDir = path.join(__dirname, '../static');
  app.use(express.static(staticDir));

  app.use(express.raw({ type: 'audio/webm', limit: '25mb' }));

  app.use(cors({
    origin: "https://chatbot.gate-ai.eu",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
  }));

  // ------------------- Authentication Endpoints -------------------
  
  // Register new user
  app.post('/api/auth/register', async (req: Request, res: Response) => {
    try {
      const { name, email, password } = req.body;
      
      // Validate required fields
      if (!name || !email || !password) {
        return res.status(400).json({ 
          success: false, 
          message: 'Name, email, and password are required' 
        });
      }
      
      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ 
          success: false, 
          message: 'Invalid email format'
        });
      }      const result = await createUser(email, password, name);
      res.json(result);
    } catch (error) {
      console.error('  ❌ Registration error:', error);
      res.status(500).json({ success: false, message: 'Server error during registration' });
    }
  });
  
  // ------------------- Per-User WoT Routes -------------------

  /**
   * Returns a user-scoped City Model Thing Description where event MQTT topics
   * are rewritten to `smartbot/user/{userId}/events/{name}` (the per-user
   * publish contract used by createEmitEvent). Property/action hrefs stay on
   * the citymodel Thing paths so the frontend can write camera/building state.
   */
  app.get('/api/wot/td/:userId', requireAuth, (req: Request, res: Response) => {
    const reqUserId = Number(req.params.userId);

    if (req.session?.userId !== reqUserId) {
      res.status(403).json({ error: 'Forbidden: userId mismatch' });
      return;
    }

    if (!originalCityModelTD) {
      res.status(503).json({ error: 'City Model Thing Description not yet available' });
      return;
    }

    const tdStr = JSON.stringify(originalCityModelTD);
    const userTDStr = tdStr
      // Rewrite event MQTT hrefs to the per-user topic prefix (legacy contract)
      .replace(/"(mqtt:\/\/[^"]+)\/citymodel\/events\/([^"]+)"/g,
        `"$1/smartbot/user/${reqUserId}/events/$2"`);

    res.json(JSON.parse(userTDStr));
  });

  /**
   * Per-user action proxy. Forwards the request to the Domain Thing that owns
   * the action, with `_userId` pre-populated.
   */
  app.post('/smartbot/user/:userId/actions/:actionName', requireAuth, async (req: Request, res: Response) => {
    const reqUserId = Number(req.params.userId);

    if (req.session?.userId !== reqUserId) {
      res.status(403).json({ error: 'Forbidden: userId mismatch' });
      return;
    }

    if (domainThings.size === 0) {
      res.status(503).json({ error: 'Domain Things not connected' });
      return;
    }

    const { actionName } = req.params;
    try {
      const body = req.body || {};
      const result = await invokeDomainAction(actionName, { ...body, _userId: reqUserId });
      const value = typeof (result as any)?.value === 'function' ? await (result as any).value() : result;
      res.json(value ?? { success: true });
    } catch (err: any) {
      console.error(`Error invoking action ${actionName} for user ${reqUserId}:`, err);
      res.status(500).json({ error: err.message || 'Action invocation failed' });
    }
  });

  // Login
  app.post('/api/auth/login', async (req: Request, res: Response) => {
    try {
      const { username, password } = req.body;      
      const result = await authenticateUser(username, password);
      
      if (result.success && result.user && req.session) {
        req.session.authenticated = true;
        req.session.email = result.user.email;
        req.session.userId = result.user.id;
        req.session.name = result.user.full_name || result.user.email;

        req.session.save((err) => {
          if (err) {
            console.error('Session save error:', err);
          }
        });
      }

      res.json(result);
    } catch (error) {
      console.error('  ❌ Login error:', error);
      res.status(500).json({ success: false, message: 'Server error during login' });
    }
  });
  
  // Logout
  app.post('/api/auth/logout', (req: Request, res: Response) => {
    req.session?.destroy((err) => {
      if (err) {
        res.status(500).json({ success: false, message: 'Failed to logout' });
      } else {
        res.clearCookie('connect.sid');
        res.json({ success: true, message: 'Logged out successfully' });
      }
    });
  });
  
  // Check authentication status
  app.get('/api/auth/check', (req: Request, res: Response) => {
    if (req.session && req.session.authenticated) {
      res.json({
        authenticated: true,
        userId: req.session.userId,
        email: req.session.email,
        name: req.session.name
      });
    } else {
      res.json({ authenticated: false });
    }
  });
  
  // Get current user info
  app.get('/api/auth/user', requireAuth, (req: Request, res: Response) => {
    res.json({
      success: true,
      email: req.session?.email,
      name: req.session?.name
    });
  });

  // ------------------- Chat History Endpoints -------------------

  app.get('/api/chat/sessions', requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = sessionUserId(req);
      if (userId == null) {
        return res.status(401).json({ success: false, message: 'Invalid session' });
      }
      const sessions = await getUserSessions(userId);
      res.json({ success: true, sessions });
    } catch (error) {
      console.error('Error fetching chat sessions:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch sessions' });
    }
  });

  app.get('/api/chat/sessions/:sessionId', requireAuth, async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      const userId = sessionUserId(req);
      if (userId == null) {
        return res.status(401).json({ success: false, message: 'Invalid session' });
      }
      const messages = await getSessionMessages(sessionId, userId);
      res.json({ success: true, messages });
    } catch (error) {
      console.error('Error fetching session messages:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch messages' });
    }
  });

  // ------------------- Feedback Endpoints -------------------

  app.post('/api/feedback', requireAuth, async (req: Request, res: Response) => {
    try {
      const { requestId, sessionId, rating, comment, feedbackType } = req.body;
      const userId = sessionUserId(req);
      if (userId == null) {
        return res.status(401).json({ success: false, message: 'Invalid session' });
      }

      if (!requestId) return res.status(400).json({ success: false, message: 'requestId is required' });
      if (typeof rating !== 'number' || rating < 1 || rating > 5) {
        return res.status(400).json({ success: false, message: 'rating must be 1–5' });
      }

      await saveUserFeedback(requestId, sessionId || '', userId, rating, comment || '', feedbackType || 'response');
      res.json({ success: true });
    } catch (error) {
      console.error('Error saving feedback:', error);
      res.status(500).json({ success: false, message: 'Failed to save feedback' });
    }
  });

  // Reset selected-building state when a new browser session starts (page refresh)
  app.post('/api/session/start', requireAuth, (req: Request, res: Response) => {
    const userKey = userContextKey(req.session?.userId);
    perUserSelectedBuilding.set(userKey, EMPTY_SELECTED_BUILDING());    res.json({ success: true });
  });

  // Serve configuration endpoint (requires authentication)
  app.get('/config.js', requireAuth, (req: Request, res: Response) => {    
    const config = {
      SERVER_NAME: process.env.SERVER_NAME,
      WOT_SMARTBOT_PORT: Number(process.env.WOT_SMARTBOT_PORT) || 8081,
      WOT_LLM_PORT: Number(process.env.WOT_LLM_PORT) || 3001,
      WEB_PORT: Number(process.env.WEB_PORT) || 3000,
      WOT_USERNAME: process.env.WOT_USERNAME || 'admin',
      WOT_PASSWORD: process.env.WOT_PASSWORD || '6VPXcB3q92rBLz/dZa1xDQOovbIlhn8Vqcgm8CDFT8M='
      // NOTE: Do NOT include CURRENT_USER here - frontend fetches it dynamically via /api/auth/check
    };
    
    res.setHeader('Content-Type', 'application/javascript');
    res.send(`window.APP_CONFIG = ${JSON.stringify(config, null, 2)};`);
  });

  // Serve the login page
  app.get('/login', (req: Request, res: Response) => {
    // Redirect to main page if already logged in
    if (req.session && req.session.authenticated) {
      res.redirect('/');
    } else {
      res.sendFile(path.join(templatesDir, 'login.html'));
    }
  });

  // Serve the main HTML page (requires authentication)
  app.get('/', (req: Request, res: Response) => {
    if (req.session && req.session.authenticated) {
      res.sendFile(path.join(templatesDir, 'index_citybot.html'));
    } else {
      res.redirect('/login');
    }
  });

  function logServerTiming(_label: string, startTime: number) {
    return performance.now() - startTime;
  }

  app.listen(WEB_PORT, () => {});
}

main().catch((error) => {
  console.error('Error starting LLM service:', error);
  process.exit(1);
}); 