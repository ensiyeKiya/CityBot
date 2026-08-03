/**
 * Shared infrastructure for the four Domain Things (citymodel, airquality,
 * api, knowledge). Provides the servient factory, the per-user MQTT event
 * publisher, TD form builders, and common constants.
 */

import { Servient } from '@node-wot/core';
import { HttpServer, HttpClientFactory, HttpsClientFactory } from '@node-wot/binding-http';
import { MqttBrokerServer } from '@node-wot/binding-mqtt';
import * as MqttLib from 'mqtt';
import { trace } from '@opentelemetry/api';

export const tracer = trace.getTracer('smartbot-server');

export const USER_AGENT = 'WoT-SmartBot/1.0';

/** Thing ids used for basic-auth credential registration. */
export const THING_IDS = {
  citymodel: 'urn:dev:wot:com:citymodel',
  airquality: 'urn:dev:wot:com:airquality',
  api: 'urn:dev:wot:com:api',
  knowledge: 'urn:dev:wot:com:knowledge'
} as const;

/** Security metadata shared by all four Thing Descriptions. */
export const SECURITY_SCHEME = {
  securityDefinitions: {
    basic_sc: {
      scheme: 'basic',
      in: 'header'
    }
  },
  security: ['basic_sc']
} as const;

// ---------------------------------------------------------------------------
// TD form builders (same URL scheme as before, now per Thing title)
// ---------------------------------------------------------------------------

export function httpForm(thingTitle: string, kind: 'actions' | 'properties', name: string, op: string[]) {
  return [{
    href: `https://${process.env.SERVER_NAME}/${thingTitle}/${kind}/${name}`,
    contentType: 'application/json',
    op
  }];
}

export function mqttEventForm(thingTitle: string, eventName: string, op?: string[]) {
  return [{
    href: `mqtt://${process.env.SERVER_NAME || 'localhost'}:1883/${thingTitle}/events/${eventName}`,
    contentType: 'application/json',
    subprotocol: 'mqtt',
    ...(op ? { op } : {})
  }];
}

// ---------------------------------------------------------------------------
// Servient factory
// ---------------------------------------------------------------------------

/**
 * Creates and starts the servient hosting all Domain Things on one HTTP port
 * (WOT_SMARTBOT_PORT) plus the MQTT broker binding. Mirrors the previous
 * single-Thing setup, including the HTTP-only retry on startup failure.
 */
export async function startServient(): Promise<{ servient: Servient; WoT: any }> {
  const servient = new Servient();

  const mqttUser = process.env.MQTT_USER;
  const mqttPass = process.env.MQTT_PASS;
  const mqttUri = `mqtt://${mqttUser}:${mqttPass}@${process.env.SERVER_NAME}:${process.env.MQTT_PORT}`;

  // Basic credentials for every Domain Thing + MQTT broker credentials
  const thingCredentials = Object.fromEntries(
    Object.values(THING_IDS).map((id) => [id, {
      username: process.env.WOT_USERNAME,
      password: process.env.WOT_PASSWORD
    }])
  );
  servient.addCredentials({
    ...thingCredentials,
    [mqttUri]: {
      username: mqttUser,
      password: mqttPass
    }
  });

  // Client factories for consuming other WoT Things (like LLM)
  servient.addClientFactory(new HttpClientFactory());
  servient.addClientFactory(new HttpsClientFactory({
    allowSelfSigned: true
  }));
  const httpServer = new HttpServer({
    address: '0.0.0.0', // Bind to all network interfaces
    port: Number(process.env.WOT_SMARTBOT_PORT),
    baseUri: `https://${process.env.SERVER_NAME}`,
    security: [{
      scheme: 'basic'
    }]
  });

  let mqttServer: MqttBrokerServer | null = null;
  try {
    mqttServer = new MqttBrokerServer({
      uri: mqttUri,
      clientId: 'smartbot-server',
      rejectUnauthorized: false // Allow self-signed certificates
    });
  } catch (error) {
    console.error('❌ MQTT server creation failed:', error);
    console.warn('⚠️ Continuing without MQTT support. Some features may not work properly.');
  }

  servient.addServer(httpServer);
  if (mqttServer) {
    servient.addServer(mqttServer);
  }

  const WoT = await servient.start().catch((error) => {
    console.error('❌ Failed to start servient:', error);
    if (error && typeof error === 'object' && 'errors' in error) {
      console.error('AggregateError details:', (error as any).errors);
      // Try to start with just HTTP server
      const httpOnlyServient = new Servient();
      httpOnlyServient.addCredentials(thingCredentials);
      httpOnlyServient.addServer(httpServer);
      return httpOnlyServient.start();
    }
    throw error;
  });

  return { servient, WoT };
}

// ---------------------------------------------------------------------------
// Per-user MQTT event publishing
// ---------------------------------------------------------------------------

// Shared publisher for user-scoped topics. The `smartbot/user/{id}/events/…`
// topic prefix is a frontend contract and stays the same for all Things.
let perUserMqttPub: MqttLib.MqttClient | null = null;

function getPerUserMqttPub(): MqttLib.MqttClient | null {
  if (perUserMqttPub) return perUserMqttPub;
  try {
    const pubUri = `mqtt://${process.env.SERVER_NAME || 'localhost'}:${process.env.MQTT_PORT || 1883}`;
    perUserMqttPub = MqttLib.connect(pubUri, {
      username: process.env.MQTT_USER,
      password: process.env.MQTT_PASS,
      clientId: 'smartbot-per-user-pub',
      clean: true,
      rejectUnauthorized: false,
      reconnectPeriod: 5000
    });
    perUserMqttPub.on('connect', () => {});
    perUserMqttPub.on('error', (err) => console.error('❌ Per-user MQTT publisher error:', err.message));
  } catch (err) {
    console.error('❌ Failed to create per-user MQTT publisher:', err);
  }
  return perUserMqttPub;
}

export type EmitEventFn = (eventName: string, data: any) => Promise<void>;

/**
 * Returns an emitEvent function bound to a Thing: emits the WoT event on the
 * Thing's shared topic and, when the payload carries a userId, also publishes
 * to the per-user topic `smartbot/user/{userId}/events/{eventName}`.
 *
 * Also mirrors every event onto the legacy anonymous topic
 * `smartbot/events/{eventName}` so browsers that still subscribe there keep
 * working during the Domain Things migration.
 */
export function createEmitEvent(thing: any): EmitEventFn {
  const pub = getPerUserMqttPub();
  return async function emitEvent(eventName: string, data: any): Promise<void> {
    await thing.emitEvent(eventName, data);
    if (pub?.connected) {
      // Legacy anonymous broadcast (frontend MQTT for unauthenticated users)
      pub.publish(`smartbot/events/${eventName}`, JSON.stringify(data), { qos: 0 });
      const userId = (data as any)?.userId;
      if (userId != null) {
        const topic = `smartbot/user/${userId}/events/${eventName}`;
        pub.publish(topic, JSON.stringify(data), { qos: 0 });
      }
    }
  };
}
