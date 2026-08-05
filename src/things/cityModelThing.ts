/**
 * City Model Thing — streams the GATE Sofia tileset as Cesium 3D Tiles and
 * controls the 3D map: camera navigation, visualization styles, building
 * filters, and the frontend camera / building-selection state.
 *
 * The disabled addEntity / removeEntity / findNearbyBuildings handlers are
 * preserved in git history (src/index.ts before the Domain Things split).
 */

import { STYLE_DEFINITIONS, STYLE_NAMES, VALID_STYLES } from '../visualizationStyles';
import { generateDynamicStyle, getDatabaseStatistics, BUILDING_CLASS_COLORS } from '../buildingVisualizationHelpers';
import { tracer, THING_IDS, SECURITY_SCHEME, createEmitEvent, httpForm, mqttEventForm } from './shared';

const TITLE = 'citymodel';

// Sofia tileset ID constant - shared between load and remove actions
const SOFIA_TILESET_ID = 'sofia-buildings-tileset';

// ---------------------------------------------------------------------------
// filterBuildings helpers
// ---------------------------------------------------------------------------

/** Valid filter type names accepted by the filterBuildings action. */
const VALID_FILTER_TYPES = ['class', 'walkability', 'height', 'energy', 'energy LTB', 'energy UTB', 'uhi4', 'uhi9'] as const;
type FilterType = typeof VALID_FILTER_TYPES[number];

/** Default highlight colour per filter type. */
const DEFAULT_FILTER_COLORS: Record<string, string> = {
  'class':       'rgb(255, 255, 0)',
  'walkability': 'rgb(88, 140, 126)',
  'height':      'rgb(102, 71, 151)',
  'energy':      'rgb(255, 239, 66)',
  'energy LTB':  'rgb(255, 239, 66)',
  'energy UTB':  'rgb(255, 140, 0)',
  'uhi4':        'rgb(222, 54, 41)',
  'uhi9':        'rgb(222, 54, 41)',
};

/**
 * Convert a CSS colour string to a Cesium colour expression.
 * rgb()/rgba() values are passed through unchanged; named colours and hex
 * values are wrapped with color('…').
 */
function toCesiumColorExpr(value: string): string {
  if (!value) return "color('white')";
  const trimmed = String(value).trim();
  return /^rgb(a)?\(/i.test(trimmed) ? trimmed : `color('${trimmed}')`;
}

/**
 * Build a Cesium 3D Tiles boolean condition expression for one filter leg.
 * Returns `{ expr }` on success or `{ error }` on bad input.
 */
function buildCesiumExpression(
  filterType: string,
  filterValue: string
): { expr: string } | { error: string } {
  switch (filterType) {
    case 'class':
      // Escape single quotes in the value just in case
      return { expr: `\${feature['citygml_class_description']} === '${filterValue.replace(/'/g, "\\'")}'` };

    case 'walkability': {
      const m = filterValue.match(/^([><=!]+)?\s*(\d+\.?\d*)$/);
      if (!m) return { error: `Invalid walkability value "${filterValue}". Use e.g. ">=80" or "50".` };
      return { expr: `Number(\${feature['walk_access_index']}) ${m[1] || '>='} ${m[2]}` };
    }

    case 'height': {
      const m = filterValue.match(/^([><=!]+)?\s*(\d+\.?\d*)$/);
      if (!m) return { error: `Invalid height value "${filterValue}". Use e.g. ">=50" or "30".` };
      return { expr: `Number(\${feature['citygml_measured_height']}) ${m[1] || '>='} ${m[2]}` };
    }

    case 'energy':
    case 'energy LTB': {
      const m = filterValue.match(/^([><=!]+)?\s*(\d+\.?\d*)$/);
      if (!m) return { error: `Invalid energy LTB value "${filterValue}". Use e.g. "<=48".` };
      return { expr: `Number(\${feature['energy_ti_ltb']}) ${m[1] || '<='} ${m[2]}` };
    }

    case 'energy UTB': {
      const m = filterValue.match(/^([><=!]+)?\s*(\d+\.?\d*)$/);
      if (!m) return { error: `Invalid energy UTB value "${filterValue}". Use e.g. ">=750".` };
      return { expr: `Number(\${feature['energy_ti_utb']}) ${m[1] || '>='} ${m[2]}` };
    }

    case 'uhi4': {
      const m = filterValue.match(/^([><=!]+)?\s*(\d+\.?\d*)$/);
      if (!m) return { error: `Invalid uhi4 value "${filterValue}". Use e.g. ">=28".` };
      return { expr: `Number(\${feature['t1600_max']}) ${m[1] || '>='} ${m[2]}` };
    }

    case 'uhi9': {
      const m = filterValue.match(/^([><=!]+)?\s*(\d+\.?\d*)$/);
      if (!m) return { error: `Invalid uhi9 value "${filterValue}". Use e.g. ">=26".` };
      return { expr: `Number(\${feature['t2100_max']}) ${m[1] || '>='} ${m[2]}` };
    }

    default:
      return { error: `Unknown filterType "${filterType}". Must be one of: ${VALID_FILTER_TYPES.join(', ')}.` };
  }
}

export async function exposeCityModelThing(WoT: any): Promise<any> {
  // Global camera state tracking
  let currentCameraState = {
    latitude: 42.6977,
    longitude: 23.3219,
    height: 100000,
    heading: 0,
    pitch: -90,
    roll: 0,
    timestamp: new Date().toISOString()
  };

  const thing = await WoT.produce({
    id: THING_IDS.citymodel,
    title: TITLE,
    description: 'City Model Thing: streams the GATE Sofia tileset as Cesium 3D Tiles with camera navigation, visualization styles, and building filters',
    ...SECURITY_SCHEME,
    properties: {
      configuration: {
        description: 'Client configuration values for connecting to WoT services',
        type: 'object',
        readOnly: true,
        properties: {
          WOT_SMARTBOT_PORT: { type: 'number', description: 'Port for the main SmartBot WoT service' },
          WOT_LLM_PORT: { type: 'number', description: 'Port for the LLM WoT service' },
          WEB_PORT: { type: 'number', description: 'Port for the web UI' },
          WOT_USERNAME: { type: 'string', description: 'Username for WoT authentication' },
          WOT_PASSWORD: { type: 'string', description: 'Password for WoT authentication' }
        },
        forms: httpForm(TITLE, 'properties', 'configuration', ['readproperty'])
      },
      cameraState: {
        description: 'Current camera state from browsers',
        type: 'object',
        properties: {
          coordinates: {
            type: 'object',
            properties: {
              latitude: { type: 'number' },
              longitude: { type: 'number' },
              height: { type: 'number' }
            }
          },
          camera: {
            type: 'object',
            properties: {
              heading: { type: 'number' },
              pitch: { type: 'number' },
              roll: { type: 'number' }
            }
          },
          time: { type: 'string' },
          userId: {
            oneOf: [{ type: 'number' }, { type: 'string' }],
            description: 'Numeric user PK — scopes camera updates to one client session'
          }
        },
        forms: httpForm(TITLE, 'properties', 'cameraState', ['readproperty', 'writeproperty'])
      },
      selectedBuildingState: {
        description: 'Currently selected building from frontend. Fields are optional except timestamp. Omit gmlId or send empty object with only timestamp to indicate deselection.',
        type: 'object',
        writeOnly: true,
        properties: {
          gmlId: {
            oneOf: [
              { type: 'string' },
              { type: 'null' }
            ],
            description: 'Building GML ID. Can be null or omitted when no building is selected.',
            default: null
          },
          coordinates: {
            type: 'object',
            properties: {
              latitude: { type: 'number' },
              longitude: { type: 'number' },
              height: { type: 'string' }
            }
          },
          class: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            default: null
          },
          function: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            default: null
          },
          addr: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            default: null
          },
          wiki_title_bg: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            default: null
          },
          wiki_pageid: {
            oneOf: [{ type: 'number' }, { type: 'null' }],
            default: null
          },
          wikidata_instances: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            default: null
          },
          walk_access_index: {
            oneOf: [{ type: 'number' }, { type: 'null' }],
            default: null
          },
          sunhrs_int_avg: {
            oneOf: [{ type: 'number' }, { type: 'null' }],
            default: null
          },
          timestamp: { type: 'string' },
          userId: {
            oneOf: [{ type: 'number' }, { type: 'string' }],
            description: 'Numeric user PK — scopes building selection to one client session'
          }
        },
        required: ['timestamp'],
        forms: httpForm(TITLE, 'properties', 'selectedBuildingState', ['writeproperty'])
      }
    },
    events: {
      mapView: {
        title: "Map View Change",
        description: "Fires when the map view should change",
        data: {
          type: "object",
          properties: {
            coordinates: {
              type: "object",
              properties: {
                latitude: { type: "number", unit: "degree" },
                longitude: { type: "number", unit: "degree" },
                height: { type: "number", unit: "metre" }
              },
              required: ["latitude", "longitude"]
            },
            camera: {
              type: "object",
              properties: {
                heading: { type: "number", unit: "degree" },
                pitch: { type: "number", unit: "degree" },
                roll: { type: "number", unit: "degree" }
              }
            },
            time: { type: "string", format: "date-time" },
            location: { type: "string" },
            userId: {
              oneOf: [{ type: "number" }, { type: "string" }],
              description: "Numeric user PK — scopes the map update to one client session"
            }
          },
          required: ["coordinates"]
        },
        forms: mqttEventForm(TITLE, 'mapView')
      },
      layerChanged: {
        title: "Layer / Time Change",
        description: "Fires whenever imagery, terrain, or simulation time is changed",
        data: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["imagery", "terrain", "time"] },
            provider: { type: "string" },
            style: { type: "string" },
            alpha: { type: "number" },
            exaggeration: { type: "number" },
            date: { type: "string", format: "date-time" },
            animate: { type: "boolean" },
            action: { type: "string", enum: ["add", "set", "remove"] }
          },
          required: ["type", "action"]
        },
        forms: mqttEventForm(TITLE, 'layerChanged')
      },
      entityAdded: {
        title: "Entity Added / Removed",
        description: "Broadcasts when a marker, etc. is created or deleted",
        data: {
          type: "object",
          properties: {
            id: { type: "string" },
            action: { type: "string", enum: ["add", "remove"] },
            timestamp: { type: "string", format: "date-time" },
            type: { type: "string" },
            position: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    latitude: { type: "number" },
                    longitude: { type: "number" },
                    height: { type: "number" }
                  },
                  required: ["latitude", "longitude"]
                },
                {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      latitude: { type: "number" },
                      longitude: { type: "number" },
                      height: { type: "number" }
                    },
                    required: ["latitude", "longitude"]
                  },
                  minItems: 2
                }
              ]
            },
            properties: { type: "object" }
          },
          required: ["id", "action"]
        },
        forms: mqttEventForm(TITLE, 'entityAdded')
      },
      mapState: {
        title: "Camera State Response",
        description: "Response containing current camera state from the client",
        data: {
          type: "object",
          properties: {
            latitude: { type: "number", unit: "degree" },
            longitude: { type: "number", unit: "degree" },
            height: { type: "number", unit: "metre" },
            heading: { type: "number", unit: "degree" },
            pitch: { type: "number", unit: "degree" },
            roll: { type: "number", unit: "degree" },
            timestamp: { type: "string", format: "date-time" }
          },
          required: ["latitude", "longitude", "height"]
        },
        forms: mqttEventForm(TITLE, 'mapState')
      },
      tilesetChanged: {
        title: "Tileset Change",
        description: "Fires when a 3D tileset is added, removed, or replaced",
        data: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["add", "remove", "replace"] },
            id: { type: "string", description: "Unique identifier for the tileset" },
            url: { type: "string" },
            ionAssetId: { type: "number" },
            name: { type: "string" },
            show: { type: "boolean", description: "Whether the tileset should be visible" },
            timestamp: { type: "string", format: "date-time" }
          },
          required: ["action"]
        },
        forms: mqttEventForm(TITLE, 'tilesetChanged')
      },
      visualizationStyleChanged: {
        title: "Visualization Style Change",
        description: "Fires when the 3D city model visualization style changes (e.g., walkability, height, energy, heat island). Includes the complete style definition from the server.",
        data: {
          type: "object",
          properties: {
            style: {
              type: "string",
              enum: ["none", "walkability", "height", "uhi4", "uhi9", "energyltb", "energyutb", "class"],
              description: "The visualization style ID being applied"
            },
            styleName: {
              type: "string",
              description: "Human-readable name of the style"
            },
            styleDefinition: {
              type: "object",
              description: "Complete Cesium 3D Tile Style definition with defines and color conditions"
            },
            timestamp: { type: "string", format: "date-time" }
          },
          required: ["style", "styleDefinition"]
        },
        forms: mqttEventForm(TITLE, 'visualizationStyleChanged')
      },
      buildingSelected: {
        title: "Building Selected",
        description: "Emitted when a user selects or deselects a building. When gmlId is null, no building is selected. Some buildings may not have complete data.",
        data: {
          type: "object",
          properties: {
            gmlId: {
              oneOf: [{ type: "string" }, { type: "null" }],
              description: "Building GML ID. Null when no building is selected."
            },
            coordinates: {
              type: "object",
              properties: {
                latitude: { type: "number" },
                longitude: { type: "number" },
                height: { type: "string" }
              }
            },
            class: { oneOf: [{ type: "string" }, { type: "null" }] },
            function: { oneOf: [{ type: "string" }, { type: "null" }] },
            addr: { oneOf: [{ type: "string" }, { type: "null" }] },
            wiki_title_bg: { oneOf: [{ type: "string" }, { type: "null" }] },
            wiki_pageid: { oneOf: [{ type: "number" }, { type: "null" }] },
            wikidata_instances: { oneOf: [{ type: "string" }, { type: "null" }] },
            walk_access_index: { oneOf: [{ type: "number" }, { type: "null" }] },
            sunhrs_int_avg: { oneOf: [{ type: "number" }, { type: "null" }] },
            timestamp: { type: "string", format: "date-time" },
            userId: {
              oneOf: [{ type: "number" }, { type: "string" }],
              description: "Numeric user PK — scopes building selection to one client session"
            }
          },
          required: ["timestamp"]
        },
        forms: mqttEventForm(TITLE, 'buildingSelected', ["subscribeevent", "unsubscribeevent"])
      }
    },
    actions: {
      setCameraView: {
        description: 'Sets precise camera position and orientation with custom angles (heading, pitch, roll). Use this only when the user explicitly requests specific camera angles or orientation. For simple navigation requests like "fly to" or "go to", use flyTo instead. Requires numeric coordinates—call getCoordinates first if you have a location name. When the user asks to change the camera view (angles, height or pitch), use this action and do not change the current location (latitude, longitude).',
        input: {
          type: 'object',
          properties: {
            latitude: {
              type: 'number',
              description: 'Latitude in degrees (-90 to 90). For landmarks, use slight offset from exact coordinates.'
            },
            longitude: {
              type: 'number',
              description: 'Longitude in degrees (-180 to 180). For landmarks, use slight offset from exact coordinates.'
            },
            height: {
              type: 'number',
              description: 'Height in meters (minimum 100m for close-up viewing)',
              default: 100000
            },
            heading: {
              type: 'number',
              description: 'Heading angle in degrees (0-360, 0 = North). Point toward the landmark.',
              default: 0
            },
            pitch: {
              type: 'number',
              description: 'Pitch angle in degrees (-90 to 90, negative = looking down)',
              default: -45
            },
            roll: {
              type: 'number',
              description: 'Roll angle in degrees (0 = level)',
              default: 0
            },
            location: {
              type: 'string',
              description: 'Human-readable location name for display'
            }
          },
          required: ['latitude', 'longitude']
        },
        output: { type: 'object' },
        forms: httpForm(TITLE, 'actions', 'setCameraView', ['invokeaction'])
      },
      flyTo: {
        description: "Primary navigation tool for moving the camera to locations. Accepts only numeric coordinates (latitude, longitude, height)—never location names. If you have a location name, call getCoordinates first to get coordinates. Height guidelines: 1000-3000m for close-up views, 3000-7000m for medium views, 7000m+ for wide views. For zoom operations: use zoomOperation 'in' (get closer) or 'out' (get farther) with currentMapState coordinates.",
        input: {
          type: 'object',
          properties: {
            latitude: {
              type: 'number',
              description: 'Latitude in degrees'
            },
            longitude: {
              type: 'number',
              description: 'Longitude in degrees'
            },
            height: {
              type: 'number',
              description: 'Height in meters. Use 1000-5000m for close-up, 10000-50000m for medium view, 100000m+ for wide view'
            },
            location: {
              type: 'string',
              description: 'Human-readable location name'
            },
            zoomOperation: {
              type: 'string',
              enum: ['in', 'out', 'none'],
              description: 'Use "in" for zoom in, "out" for zoom out, "none" for regular navigation. When specified, use current camera position for lat/lon.'
            },
            zoomFactor: {
              type: 'number',
              default: 2.0,
              description: 'Zoom factor for zoom operations (default 2.0)'
            }
          },
          required: []
        },
        output: { type: 'object' },
        forms: httpForm(TITLE, 'actions', 'flyTo', ['invokeaction'])
      },
      loadTiles: {
        description: 'Loads GATE city model onto the map. Use this when the user wants to see 3D buildings or before applying visualization styles or building filters. No parameters needed—automatically loads the correct tileset.',
        input: {
          type: 'object',
          properties: {
            show: {
              type: 'boolean',
              description: 'Whether the tileset should be visible',
              default: true
            }
          }
        },
        output: { type: 'object' },
        forms: httpForm(TITLE, 'actions', 'loadTiles', ['invokeaction'])
      },
      removeTiles: {
        description: 'Removes GATE city model from the map. Use this when the user wants to hide or unload the 3D buildings. No parameters needed. When this removed, the map will be replaced with the Google Photorealistic 3D Tiles.',
        input: {
          type: 'object',
          properties: {}
        },
        output: { type: 'object' },
        forms: httpForm(TITLE, 'actions', 'removeTiles', ['invokeaction'])
      },
      setVisualizationStyle: {
        description: 'Applies a color-coded visualization style to the 3D city model. Available styles: walkability (pedestrian accessibility), height (building height), uhi4/uhi9 (urban heat island at 4pm/9pm), energyltb/energyutb (energy consumption lower/upper bounds), class (building type classification), none (remove styling). Dynamically generates color schemes from real building data. Load Sofia 3D tiles first if not already loaded.',
        input: {
          type: 'object',
          properties: {
            style: {
              type: 'string',
              enum: ['none', 'walkability', 'height', 'uhi4', 'uhi9', 'energyltb', 'energyutb', 'class'],
              description: 'Visualization style to apply: none (default), walkability (pedestrian accessibility with dynamic thresholds), height (building height with data-driven color ranges), uhi4 (urban heat at 4pm), uhi9 (urban heat at 9pm), energyltb (energy lower bound with intelligent ranges), energyutb (energy upper bound with intelligent ranges), class (building classification)'
            }
          },
          required: ['style']
        },
        output: { type: 'object' },
        forms: httpForm(TITLE, 'actions', 'setVisualizationStyle', ['invokeaction'])
      },
      filterBuildings: {
        description: 'Highlights buildings matching specific criteria in color while showing non-matching buildings in white. Supports single filters and multi-condition AND/OR filters. Load Sofia 3D tiles first if not already loaded.\n\nSINGLE FILTER: set filterType + filterValue + optional color.\nMULTI-CONDITION: set "filters" array instead (filterType/filterValue are ignored). Use combineMode "AND" (default) to highlight only buildings matching ALL conditions in one shared color (e.g. tall healthcare buildings). Use combineMode "OR" to highlight each condition group independently in its own color (e.g. hospitals in blue AND schools in red).\n\nfilterType values: "class" (building type), "walkability" (0-100), "height" (meters), "energy LTB" (kWh/m²/yr lower bound), "energy UTB" (kWh/m²/yr upper bound), "uhi4" (heat island at 4 pm °C), "uhi9" (heat island at 9 pm °C), "none" (reset).\nClass names: "healthcare", "administration", "schools, education, research", "business, trade", "habitation", "culture", "sport", "industry", "storage", "traffic", "church institution".\nNumeric thresholds: walkability high>=80 low<30; height tall>=50 short<10; energy LTB efficient<=48 inefficient>=58; energy UTB efficient<=300 inefficient>=750; uhi4 hot>=28; uhi9 hot>=26.',
        input: {
          type: 'object',
          properties: {
            filterType: {
              type: 'string',
              enum: ['class', 'walkability', 'height', 'energy', 'energy LTB', 'energy UTB', 'uhi4', 'uhi9', 'none'],
              description: 'Filter type for single-condition use. Ignored when "filters" array is provided.'
            },
            filterValue: {
              type: 'string',
              description: 'Filter value for single-condition use. Ignored when "filters" array is provided.'
            },
            color: {
              type: 'string',
              description: 'Highlight color for single-condition use or for AND multi-condition (all matching buildings share this color). Accepts CSS: "red", "#FF0000", "rgb(255,0,0)". Ignored when "filters" array items have their own color in OR mode.'
            },
            filters: {
              type: 'array',
              description: 'Multi-condition filter list. Each element selects a group of buildings. Use combineMode to control AND vs OR logic.',
              items: {
                type: 'object',
                properties: {
                  filterType: { type: 'string', enum: ['class', 'walkability', 'height', 'energy', 'energy LTB', 'energy UTB', 'uhi4', 'uhi9'] },
                  filterValue: { type: 'string' },
                  color: { type: 'string', description: 'Per-condition color used in OR mode. Optional in AND mode.' }
                },
                required: ['filterType', 'filterValue']
              }
            },
            combineMode: {
              type: 'string',
              enum: ['AND', 'OR'],
              description: 'How to combine the "filters" array. "AND" (default): only buildings matching ALL conditions are highlighted in a single shared color. "OR": each condition highlights independently in its own per-condition color.'
            }
          }
        },
        output: { type: 'object' },
        forms: httpForm(TITLE, 'actions', 'filterBuildings', ['invokeaction'])
      }
    }
  });

  const emitEvent = createEmitEvent(thing);

  thing.setActionHandler('flyTo', async (params: any) => {
    const span = tracer.startSpan('flyTo');
    try {
      let input;
      if (params && typeof params.value === 'function') {
        input = await params.value();
      } else {
        input = params;
      }

      const userId = input?._userId ?? null;
      // Enhanced input validation
      if (!input) {
        return { error: true, message: 'Input parameters are required' };
      }

      // Handle zoom operations
      if (input && input.zoomOperation && input.zoomOperation !== 'none') {
        // Validate zoom operation
        if (!['in', 'out'].includes(input.zoomOperation)) {
          return { error: true, message: 'Invalid zoom operation. Use "in" or "out".' };
        }

        // For zoom operations, we need current position and height
        if (typeof input.latitude !== 'number' || typeof input.longitude !== 'number' || typeof input.height !== 'number') {
          return {
            error: true,
            message: 'Zoom operations require current latitude, longitude, and height to be specified'
          };
        }

        // Validate coordinate ranges
        if (input.latitude < -90 || input.latitude > 90) {
          return { error: true, message: 'Latitude must be between -90 and 90 degrees' };
        }
        if (input.longitude < -180 || input.longitude > 180) {
          return { error: true, message: 'Longitude must be between -180 and 180 degrees' };
        }
        if (input.height < 100 || input.height > 50000000) {
          return { error: true, message: 'Height must be between 100 and 50,000,000 meters' };
        }

        const factor = typeof input.zoomFactor === 'number' ? Math.max(1.1, Math.min(10, input.zoomFactor)) : 2.0;
        let newHeight;

        if (input.zoomOperation === 'in') {
          newHeight = Math.max(input.height / factor, 1000); // Minimum 1km
        } else if (input.zoomOperation === 'out') {
          newHeight = Math.min(input.height * factor, 50000000); // Maximum ~50,000km
        } else {
          return { error: true, message: 'Invalid zoom operation. Use "in" or "out".' };
        }

        // Use provided current camera position for zoom
        const latitude = input.latitude;
        const longitude = input.longitude;
        const locationName = `zoom ${input.zoomOperation} (${Math.round(newHeight)}m altitude)`;

        // Update camera state
        currentCameraState = {
          latitude: latitude,
          longitude: longitude,
          height: newHeight,
          heading: input.heading || currentCameraState.heading,
          pitch: input.pitch || currentCameraState.pitch,
          roll: input.roll || currentCameraState.roll,
          timestamp: new Date().toISOString()
        };

        // Emit mapView event
        try {
          const eventData = {
            type: 'mapView',
            coordinates: {
              latitude: latitude,
              longitude: longitude,
              height: newHeight
            },
            camera: {
              heading: currentCameraState.heading,
              pitch: currentCameraState.pitch,
              roll: currentCameraState.roll
            },
            location: locationName,
            time: currentCameraState.timestamp
          };

          (eventData as any).userId = userId;
          await emitEvent('mapView', eventData);        } catch (error) {
          console.error("Error emitting zoom event:", error);
          return { error: true, message: `Failed to emit zoom event: ${error}` };
        }

        return {
          success: true,
          message: `Zoomed ${input.zoomOperation} by ${factor}x to ${Math.round(newHeight)}m altitude`,
          location: locationName,
          camera: {
            latitude: latitude,
            longitude: longitude,
            height: newHeight
          },
          timestamp: currentCameraState.timestamp
        };
      }

      // Handle case where input may contain coordinates from getCoordinates
      if (input.coordinates && typeof input.coordinates === 'object') {
        if (typeof input.coordinates.latitude === 'number'  && input.latitude  == null) input.latitude  = input.coordinates.latitude;
        if (typeof input.coordinates.longitude === 'number' && input.longitude == null) input.longitude = input.coordinates.longitude;
        if (typeof input.coordinates.height === 'number'    && input.height    == null) input.height    = input.coordinates.height;
      }

      if (!input || typeof input.latitude !== 'number' || typeof input.longitude !== 'number') {
        return { error: true, message: 'Latitude and longitude are required for location-based flyTo operations' };
      }

      // Validate coordinate ranges
      if (input.latitude < -90 || input.latitude > 90) {
        return { error: true, message: 'Latitude must be between -90 and 90 degrees' };
      }
      if (input.longitude < -180 || input.longitude > 180) {
        return { error: true, message: 'Longitude must be between -180 and 180 degrees' };
      }

      // Height validation - allow lower heights for close-up viewing
      const height = typeof input.height === 'number'
        ? Math.max(input.height, 500)   // Allow much lower heights for close-up viewing
        : 100000; // Default height only if not specified
      const locationName = input.location || `coordinates (${input.latitude}, ${input.longitude})`;
      if (input.height && input.height < 500) {      }
      // Update global camera state
      currentCameraState = {
        latitude: input.latitude,
        longitude: input.longitude,
        height: height,
        heading: 0,
        pitch: -90,
        roll: 0,
        timestamp: new Date().toISOString()
      };

      // Emit mapView event IMMEDIATELY without debouncing (critical for navigation)
      try {
        const eventData = {
          coordinates: {
            latitude: input.latitude,
            longitude: input.longitude,
            height: height
          },
          camera: {
            heading: 0,
            pitch: -90,
            roll: 0
          },
          location: locationName,
          time: new Date().toISOString()
        };

        // Emit immediately without debouncing for flyTo commands
        (eventData as any).userId = userId;
        await emitEvent('mapView', eventData);
        // Mark that we're starting a flight animation AFTER emitting the event
        inFlightAnimation = true;
        flightAnimationEndTime = Date.now() + 4000; // Assume animation takes ~4 seconds
      } catch (error) {
        console.error("Error emitting mapView event:", error);
        // Don't fail the action if event emission fails
        console.warn(`⚠️ Could not emit map view event: ${error}`);
      }

      return {
        success: true,
        message: `Flying to ${locationName}`,
        location: locationName,
        camera: {
          latitude: input.latitude,
          longitude: input.longitude,
          height: height
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error("Error in flyTo handler:", error);
      return { error: true, message: "Failed to execute flyTo operation" };
    } finally {
      span.end();
    }
  });

  thing.setActionHandler('setCameraView', async (params: any) => {
    const span = tracer.startSpan('setCameraView');
    try {
      // Extract input
      let input;
      if (params && typeof params.value === "function") {
        input = await params.value();
      } else {
        input = params;
      }

      const userId = input?._userId ?? null;
      // Enhanced input validation
      if (!input) {
        return { error: true, message: 'Input parameters are required' };
      }

      // Handle case where input may contain coordinates from getCoordinates
      if (input.coordinates && typeof input.coordinates === 'object') {
        if (typeof input.coordinates.latitude === 'number'  && input.latitude  == null) input.latitude  = input.coordinates.latitude;
        if (typeof input.coordinates.longitude === 'number' && input.longitude == null) input.longitude = input.coordinates.longitude;
        if (typeof input.coordinates.height === 'number'    && input.height    == null) input.height    = input.coordinates.height;
      }

      // Validate input
      if (!input || typeof input.latitude !== 'number' || typeof input.longitude !== 'number') {
        return { error: true, message: "Latitude and longitude are required and must be numbers" };
      }

      // Validate coordinate ranges
      if (input.latitude < -90 || input.latitude > 90) {
        return { error: true, message: "Latitude must be between -90 and 90 degrees" };
      }
      if (input.longitude < -180 || input.longitude > 180) {
        return { error: true, message: "Longitude must be between -180 and 180 degrees" };
      }

      // Height validation - allow lower heights for precise camera positioning
      const height = typeof input.height === 'number'
        ? Math.max(input.height, 100)   // Allow much lower heights for close-up viewing
        : 100000; // Default height only if not specified

      if (input.height && input.height < 100) {      }

      // Validate camera angles
      const heading = typeof input.heading === 'number' ?
        ((input.heading % 360) + 360) % 360 : 0; // Normalize to 0-360
      const pitch = typeof input.pitch === 'number' ?
        Math.max(-90, Math.min(90, input.pitch)) : -45; // Clamp to -90 to 90
      const roll = typeof input.roll === 'number' ?
        ((input.roll % 360) + 360) % 360 : 0; // Normalize to 0-360

      const locationName = input.location || `coordinates (${input.latitude.toFixed(4)}, ${input.longitude.toFixed(4)})`;
      // Update global camera state
      currentCameraState = {
        latitude: input.latitude,
        longitude: input.longitude,
        height: height,
        heading: heading,
        pitch: pitch,
        roll: roll,
        timestamp: new Date().toISOString()
      };

      // Emit mapView event IMMEDIATELY without debouncing (critical for navigation)
      try {
        const eventData = {
          coordinates: {
            latitude: input.latitude,
            longitude: input.longitude,
            height: height
          },
          camera: {
            heading: heading,
            pitch: pitch,
            roll: roll
          },
          location: locationName,
          time: new Date().toISOString()
        };

        // Emit immediately without debouncing for setCameraView commands
        (eventData as any).userId = userId;
        await emitEvent('mapView', eventData);
        // Mark that we're starting a flight animation AFTER emitting the event
        inFlightAnimation = true;
        flightAnimationEndTime = Date.now() + 4000; // Assume animation takes ~4 seconds
      } catch (error) {
        console.error("Error emitting mapView event:", error);
        // Don't fail the action if event emission fails
        console.warn(`⚠️ Could not emit map view event: ${error}`);
      }

      return {
        success: true,
        message: `Camera view set to ${locationName} with heading ${heading}°, pitch ${pitch}°, roll ${roll}°`,
        camera: {
          latitude: input.latitude,
          longitude: input.longitude,
          height: height,
          heading: heading,
          pitch: pitch,
          roll: roll
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error("Error in setCameraView handler:", error);
      return { error: true, message: "Failed to set camera view" };
    } finally {
      span.end();
    }
  });

  thing.setActionHandler('setVisualizationStyle', async (params: any) => {
    const span = tracer.startSpan('setVisualizationStyle');
    try {
      let input;
      if (params && typeof params.value === "function") {
        input = await params.value();
      } else {
        input = params || {};
      }

      const userId = input?._userId ?? null;
      // Validate style parameter using imported constants
      if (!input.style || !VALID_STYLES.includes(input.style)) {
        return {
          error: true,
          message: `Invalid style. Must be one of: ${VALID_STYLES.join(', ')}`
        };
      }

      let styleDefinition;
      let styleName = STYLE_NAMES[input.style];

      // For dynamic styles, get data from database
      if (input.style === 'height' || input.style === 'walkability' || input.style === 'energyltb' || input.style === 'energyutb') {
        const stats = await getDatabaseStatistics();

        if (stats) {
          // Generate dynamic style based on actual data ranges
          styleDefinition = generateDynamicStyle(input.style, stats);        } else {
          console.warn('⚠️ Could not fetch database data, using static style');
          styleDefinition = STYLE_DEFINITIONS[input.style];
        }
      } else {
        // Use static style definitions for non-data-driven styles
        styleDefinition = STYLE_DEFINITIONS[input.style];
      }

      // Emit event with the style definition
      try {
        await emitEvent('visualizationStyleChanged', {
          userId,
          style: input.style,
          styleName: styleName,
          styleDefinition: styleDefinition,
          timestamp: new Date().toISOString()
        });      } catch (error) {
        console.error("Error emitting visualization style change event:", error);
        return { error: true, message: `Failed to emit visualization style change event: ${error}` };
      }

      return {
        success: true,
        message: `Successfully applied ${styleName} visualization style`,
        style: {
          id: input.style,
          name: styleName,
          definition: styleDefinition
        }
      };
    } catch (error) {
      console.error("Error in setVisualizationStyle handler:", error);
      return { error: true, message: "Failed to set visualization style" };
    } finally {
      span.end();
    }
  });

  thing.setActionHandler('filterBuildings', async (params: any) => {
    const span = tracer.startSpan('filterBuildings');
    try {
      let input: any;
      if (params && typeof params.value === 'function') {
        input = await params.value();
      } else {
        input = params || {};
      }

      const userId = input?._userId ?? null;

      // ── Reset ────────────────────────────────────────────────────────────
      if (input.filterType === 'none') {
        try {
          await emitEvent('visualizationStyleChanged', {
            userId,
            style: 'none',
            styleName: 'Default Style',
            styleDefinition: { show: true },
            timestamp: new Date().toISOString()
          });
        } catch (error) {
          console.error('Error resetting filter:', error);
          return { error: true, message: `Failed to reset visualization style: ${error}` };
        }
        return {
          success: true,
          message: 'Removed building filter and reset to default visualization style',
          filter: { type: 'none', style: { show: true } }
        };
      }

      // ── Normalise to a resolvedFilters array ─────────────────────────────
      // Multi-condition path: "filters" array takes priority.
      // Single-condition path: wrap legacy filterType/filterValue fields.
      type FilterLeg = { filterType: string; filterValue: string; color?: string };
      let resolvedFilters: FilterLeg[];

      if (Array.isArray(input.filters) && input.filters.length > 0) {
        resolvedFilters = input.filters;
      } else if (input.filterType && input.filterValue) {
        resolvedFilters = [{ filterType: input.filterType, filterValue: input.filterValue, color: input.color }];
      } else {
        return { error: true, message: 'Provide either filterType+filterValue or a non-empty filters array.' };
      }

      // Validate every leg
      for (const leg of resolvedFilters) {
        if (!VALID_FILTER_TYPES.includes(leg.filterType as FilterType)) {
          return { error: true, message: `Invalid filterType "${leg.filterType}". Valid values: ${VALID_FILTER_TYPES.join(', ')}.` };
        }
        if (!leg.filterValue) {
          return { error: true, message: `filterValue is required for filterType "${leg.filterType}".` };
        }
      }

      // ── Build Cesium conditions ──────────────────────────────────────────
      const combineMode: 'AND' | 'OR' = input.combineMode === 'OR' ? 'OR' : 'AND';

      let conditions: [string, string][];

      if (combineMode === 'AND') {
        // All legs joined with &&; buildings must satisfy every condition.
        const expressions: string[] = [];
        for (const leg of resolvedFilters) {
          const result = buildCesiumExpression(leg.filterType, leg.filterValue);
          if ('error' in result) return { error: true, message: result.error };
          expressions.push(result.expr);
        }
        const combinedExpr = expressions.join(' && ');

        // Shared colour: top-level color → first leg color → default for first filterType
        const firstLeg = resolvedFilters[0];
        const sharedColor = input.color
          || firstLeg.color
          || (firstLeg.filterType === 'class'
              ? BUILDING_CLASS_COLORS[firstLeg.filterValue] || DEFAULT_FILTER_COLORS['class']
              : DEFAULT_FILTER_COLORS[firstLeg.filterType] || 'rgb(255, 255, 0)');

        conditions = [
          [combinedExpr, toCesiumColorExpr(sharedColor)],
          ["true", "color('white')"]
        ];
      } else {
        // OR mode: each leg gets its own colour and its own conditions entry.
        const legConditions: [string, string][] = [];
        for (const leg of resolvedFilters) {
          const result = buildCesiumExpression(leg.filterType, leg.filterValue);
          if ('error' in result) return { error: true, message: result.error };
          const colour = leg.color
            || (leg.filterType === 'class'
                ? BUILDING_CLASS_COLORS[leg.filterValue] || DEFAULT_FILTER_COLORS['class']
                : DEFAULT_FILTER_COLORS[leg.filterType] || 'rgb(255, 255, 0)');
          legConditions.push([result.expr, toCesiumColorExpr(colour)]);
        }
        conditions = [...legConditions, ["true", "color('white')"]];
      }

      const filterStyleDefinition = { color: { conditions } };

      // ── Emit ─────────────────────────────────────────────────────────────
      const styleLabel = resolvedFilters
        .map((l) => `${l.filterType} ${l.filterValue}`)
        .join(combineMode === 'AND' ? ' AND ' : ' OR ');
      try {
        await emitEvent('visualizationStyleChanged', {
          userId,
          style: 'custom_filter',
          styleName: `Filter: ${styleLabel}`,
          styleDefinition: filterStyleDefinition,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Error emitting filter visualization:', error);
        return { error: true, message: `Failed to emit filter visualization: ${error}` };
      }

      return {
        success: true,
        message: `Highlighted buildings matching [${styleLabel}] (${combineMode}), all others shown in white`,
        filter: {
          filters: resolvedFilters,
          combineMode,
          style: filterStyleDefinition
        }
      };
    } catch (error) {
      console.error('Error in filterBuildings handler:', error);
      return { error: true, message: 'Failed to filter buildings' };
    } finally {
      span.end();
    }
  });

  thing.setActionHandler('loadTiles', async (params: any) => {
    const span = tracer.startSpan('loadTiles');
    try {
      let input;
      if (params && typeof params.value === "function") {
        input = await params.value();
      } else {
        input = params || {};
      }

      const userId = input?._userId ?? null;
      // Sofia tileset configuration - hardcoded for simplicity
      const SOFIA_TILESET = {
        id: SOFIA_TILESET_ID,
        url: 'https://raw.githubusercontent.com/eshirinyan/three_sample/refs/heads/main/sofia_building_tiles_20250821/tileset.json',
        name: 'Sofia Buildings',
        show: input.show !== undefined ? Boolean(input.show) : true
      };
      // Prepare tileset data
      const tilesetData = {
        action: 'add',
        userId,
        id: SOFIA_TILESET.id,
        url: SOFIA_TILESET.url,
        name: SOFIA_TILESET.name,
        show: SOFIA_TILESET.show,
        timestamp: new Date().toISOString()
      };
      // Emit event for clients to load the tileset
      try {        const emitStart = Date.now();
        await emitEvent('tilesetChanged', tilesetData);
        const emitTime = Date.now() - emitStart;      } catch (error) {
        console.error("❌ Error emitting tilesetChanged event:", error);
        console.error("🔍 DEBUG: Emit error type:", typeof error);
        console.error("🔍 DEBUG: Emit error message:", error instanceof Error ? error.message : String(error));
        console.error("🔍 DEBUG: Emit error stack:", error instanceof Error ? error.stack : 'No stack');
        return { error: true, message: `Failed to emit tileset change event: ${error}` };
      }

      return {
        success: true,
        message: 'Successfully loaded Sofia\'s 3D building tiles',
        tileset: {
          name: SOFIA_TILESET.name,
          id: SOFIA_TILESET.id,
          url: SOFIA_TILESET.url
        }
      };
    } catch (error) {
      console.error("Error in loadTiles handler:", error);
      return { error: true, message: "Failed to load Sofia tiles" };
    } finally {
      span.end();
    }
  });

  thing.setActionHandler('removeTiles', async (params: any) => {
    const span = tracer.startSpan('removeTiles');
    try {
      let removeInput: any = {};
      if (params && typeof params.value === 'function') removeInput = await params.value();
      else if (params) removeInput = params;
      const userId = removeInput?._userId ?? null;
      // Emit event for clients to remove the tileset
      try {
        await emitEvent('tilesetChanged', {
          action: 'remove',
          userId,
          id: SOFIA_TILESET_ID,
          timestamp: new Date().toISOString()
        });      } catch (error) {
        console.error("Error emitting tileset remove event:", error);
        return { error: true, message: `Failed to emit tileset removal event: ${error}` };
      }

      return {
        success: true,
        message: 'Successfully removed Sofia\'s 3D building tiles',
        tileset: {
          id: SOFIA_TILESET_ID,
          name: 'Sofia Buildings'
        }
      };
    } catch (error) {
      console.error("Error in removeTiles handler:", error);
      return { error: true, message: "Failed to remove Sofia tiles" };
    } finally {
      span.end();
    }
  });

  thing.setPropertyReadHandler('configuration', async () => {
    return {
      WOT_SMARTBOT_PORT: Number(process.env.WOT_SMARTBOT_PORT),
      WOT_LLM_PORT: Number(process.env.WOT_LLM_PORT),
      WEB_PORT: Number(process.env.WEB_PORT),
      WOT_USERNAME: process.env.WOT_USERNAME || '',
      WOT_PASSWORD: process.env.WOT_PASSWORD || ''
    };
  });

  // Create a debounced event emitter to prevent rapid-fire events
  let lastEmitTime = 0;
  let pendingEmit = false;
  let latestCameraData: any = null;
  let inFlightAnimation = false;
  let flightAnimationEndTime = 0;

  // This function will throttle event emissions
  const debouncedEmitMapViewEvent = async () => {
    if (pendingEmit) return; // Don't schedule another emission if one is pending

    const now = Date.now();
    const timeSinceLastEmit = now - lastEmitTime;

    // If we're in a flight animation, only forward events that are significantly different
    if (inFlightAnimation && now < flightAnimationEndTime) {
      // During animation, only emit if it's been at least 1 second since last emission
      if (timeSinceLastEmit < 1000) {
        // Skip this update during animation        latestCameraData = null;
        return;
      }
    } else if (timeSinceLastEmit < 100) {
      // Normal debounce for non-animation updates
      // If we've emitted recently, schedule a delayed emission
      pendingEmit = true;
      setTimeout(async () => {
        if (latestCameraData) {
          try {
            await emitEvent('mapView', latestCameraData);          } catch (err: any) {
            console.warn('⚠️ Could not forward camera state as mapView event:', err.message || String(err));
          }
        }
        lastEmitTime = Date.now();
        pendingEmit = false;
        latestCameraData = null;
      }, 150); // Wait 150ms before emitting
      return;
    }

    // Otherwise emit immediately
    try {
      if (latestCameraData) {
        await emitEvent('mapView', latestCameraData);      }
    } catch (err: any) {
      console.warn('⚠️ Could not forward camera state as mapView event:', err.message || String(err));
    }
    lastEmitTime = now;
    latestCameraData = null;
  };

  thing.setPropertyWriteHandler('cameraState', async (value: any) => {
    try {
      const cameraData = typeof value.value === 'function' ? await value.value() : value;
      // Store the latest camera data and trigger the debounced emission
      latestCameraData = cameraData;
      debouncedEmitMapViewEvent().catch(err => {
        console.error('Error in debounced event emission:', err);
      });
    } catch (error: any) {
      console.error('Error handling camera state write:', error.message || String(error));
    }
  });

  thing.setPropertyWriteHandler('selectedBuildingState', async (value: any) => {
    try {
      const buildingData = typeof value.value === 'function' ? await value.value() : value;
      // Emit as WoT event so LLM client can receive it
      await emitEvent('buildingSelected', buildingData);    } catch (error: any) {
      console.error('Error handling building selection write:', error.message || String(error));
    }
  });

  await thing.expose();  return thing;
}
