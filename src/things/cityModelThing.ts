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
import { countBuildingsMatching, queryBuildingsMatching } from '../database';
import { resolveBuildingClass } from '../sofiaSensors';
import { tracer, THING_IDS, SECURITY_SCHEME, createEmitEvent, httpForm, mqttEventForm } from './shared';

const TITLE = 'citymodel';

// Sofia tileset ID constant - shared between load and remove actions
const SOFIA_TILESET_ID = 'sofia-buildings-tileset';

// ---------------------------------------------------------------------------
// filterBuildings helpers
// ---------------------------------------------------------------------------

/** Valid filter type names accepted by the filterBuildings action. */
const VALID_FILTER_TYPES = ['class', 'walkability', 'height', 'energy', 'energy LTB', 'energy UTB', 'uhi4', 'uhi9', 'sunhours'] as const;
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
  'sunhours':    'rgb(255, 200, 0)',
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
 * Parse a numeric filter value string into a Cesium condition fragment.
 *
 * Accepted formats (examples use walkability, same rules apply to all numeric types):
 *   ">=80"        → prop >= 80
 *   ">80"         → prop > 80
 *   "<=30"        → prop <= 30
 *   "80"          → prop >= 80   (bare number → default operator)
 *   "20-30"       → prop >= 20 && prop <= 30   (inclusive range)
 *   "20 - 30"     → same, spaces around dash are ignored
 *
 * Returns the condition string fragment (the part between feature and the
 * catch-all "true") or an error message.
 */
function parseNumericFilter(
  prop: string,          // Cesium feature property expression, e.g. "walk_access_index"
  filterValue: string,
  defaultOp = '>='
): { expr: string } | { error: string } {
  const v = filterValue.trim();

  // Range: "20-30" or "20 - 30"  (leading operator would be ambiguous, so
  // only match when the first char is a digit or a decimal point)
  const rangeMatch = v.match(/^(\d+\.?\d*)\s*-\s*(\d+\.?\d*)$/);
  if (rangeMatch) {
    const lo = rangeMatch[1];
    const hi = rangeMatch[2];
    if (parseFloat(lo) > parseFloat(hi)) {
      return { error: `Range "${v}" is invalid — lower bound exceeds upper bound.` };
    }
    return { expr: `Number(\${feature['${prop}']}) >= ${lo} && Number(\${feature['${prop}']}) <= ${hi}` };
  }

  // Single threshold: optional operator + number
  const singleMatch = v.match(/^([><=!]+)?\s*(\d+\.?\d*)$/);
  if (singleMatch) {
    return { expr: `Number(\${feature['${prop}']}) ${singleMatch[1] || defaultOp} ${singleMatch[2]}` };
  }

  return { error: `Invalid numeric filter value "${filterValue}". Use e.g. ">=80", "50", or "20-30".` };
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
      return { expr: `\${feature['citygml_class_description']} === '${filterValue.replace(/'/g, "\\'")}'` };

    case 'walkability':
      return parseNumericFilter('walk_access_index', filterValue, '>=');

    case 'height':
      return parseNumericFilter('citygml_measured_height', filterValue, '>=');

    case 'energy':
    case 'energy LTB':
      return parseNumericFilter('energy_ti_ltb', filterValue, '<=');

    case 'energy UTB':
      return parseNumericFilter('energy_ti_utb', filterValue, '>=');

    case 'uhi4':
      return parseNumericFilter('t1600_max', filterValue, '>=');

    case 'uhi9':
      return parseNumericFilter('t2100_max', filterValue, '>=');

    case 'sunhours':
      return parseNumericFilter('sunhrs_int_avg', filterValue, '>=');

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
              description: "The visualization style ID being applied (e.g. walkability, custom_filter, none)"
            },
            styleName: {
              type: "string",
              description: "Human-readable name of the style"
            },
            styleDefinition: {
              type: "object",
              description: "Complete Cesium 3D Tile Style definition with defines and color conditions"
            },
            appliedResult: {
              type: "object",
              description: "Human-readable and structured description of what the filter/style does (filters, colors, combineMode, etc.) for UI ack and LLM final answers"
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
        description: 'Sets precise camera position and orientation with custom heading, pitch, and roll angles. Accepts numeric coordinates only; call getCoordinates first if you have a place name. To adjust angle or height without changing location, pass the current lat/lon from currentMapState.',
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
        description: "Primary navigation tool. Accepts only numeric latitude/longitude/height — never place names (call getCoordinates first). Height tips: 500–3000m close-up, 3000–10000m medium, 50000m+ wide. For \"zoom in/out\" (no place): set zoomOperation to 'in' or 'out' and pass currentMapState latitude/longitude/height — zoom is relative to that height (min 100m). For \"zoom to [place]\": getCoordinates, then flyTo with a close-up height (500–3000m), zoomOperation omitted or 'none'.",
        input: {
          type: 'object',
          properties: {
            latitude: {
              type: 'number',
              description: 'Latitude in degrees (−90..90). Required for place navigation; for zoom in/out use currentMapState.latitude.'
            },
            longitude: {
              type: 'number',
              description: 'Longitude in degrees (−180..180). Required for place navigation; for zoom in/out use currentMapState.longitude.'
            },
            height: {
              type: 'number',
              description: 'Camera height in meters (min 100). For zoom in/out pass currentMapState.height so the relative zoom is correct.'
            },
            location: {
              type: 'string',
              description: 'Human-readable location name for display only (not geocoded)'
            },
            zoomOperation: {
              type: 'string',
              enum: ['in', 'out', 'none'],
              description: '"in" = closer (height /= zoomFactor, min 100m), "out" = farther, "none"/omit = fly to absolute lat/lon/height'
            },
            zoomFactor: {
              type: 'number',
              default: 2.0,
              description: 'Multiplier for zoom in/out (default 2.0)'
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
        description: 'Colors ALL buildings on the map by one metric. Changes map appearance. Styles: walkability, height, uhi4/uhi9, energyltb/energyutb, class, none. Load Sofia tiles first if needed. For factual questions about a subset (counts, heights, averages) use queryBuildings — it does not change the map.',
        input: {
          type: 'object',
          properties: {
            style: {
              type: 'string',
              enum: ['none', 'walkability', 'height', 'uhi4', 'uhi9', 'energyltb', 'energyutb', 'class'],
              description: 'Visualization style to apply'
            }
          },
          required: ['style']
        },
        output: { type: 'object' },
        forms: httpForm(TITLE, 'actions', 'setVisualizationStyle', ['invokeaction'])
      },
      queryBuildings: {
        description: 'Answers factual questions about buildings without changing the map. Returns count and stats (height min/avg/max, energy avg, walkability avg) for matching buildings.\n'
          + 'Use for "how tall / how many / what is the average …". Same filter language as filterBuildings.\n'
          + 'filterType: class | walkability | height | energy LTB | energy UTB | uhi4 | uhi9 | sunhours.\n'
          + 'NUMERIC filterValue must be a numeric expression (">=58", "<30", "20-30"). Intent → value: energy LTB inefficient ">=58"; height tall ">=50"; walkability low "<30"; uhi9 hot ">=26".\n'
          + 'AND multiple criteria with filters=[...]. Class: casual names OK (schools, hospitals, …).',
        input: {
          type: 'object',
          properties: {
            filterType: {
              type: 'string',
              enum: ['class', 'walkability', 'height', 'energy', 'energy LTB', 'energy UTB', 'uhi4', 'uhi9', 'sunhours'],
              description: 'Single-condition filter type. Ignored when filters array is provided.'
            },
            filterValue: {
              type: 'string',
              description: 'Single-condition value. Numeric expression or class name.'
            },
            filters: {
              type: 'array',
              description: 'AND list of conditions. All must match.',
              items: {
                type: 'object',
                properties: {
                  filterType: { type: 'string', enum: ['class', 'walkability', 'height', 'energy', 'energy LTB', 'energy UTB', 'uhi4', 'uhi9', 'sunhours'] },
                  filterValue: { type: 'string' }
                },
                required: ['filterType', 'filterValue']
              }
            }
          }
        },
        output: { type: 'object' },
        forms: httpForm(TITLE, 'actions', 'queryBuildings', ['invokeaction'])
      },
      filterBuildings: {
        description: 'Highlights matching buildings on the map (others white). Changes map appearance — use when the user asks to show/highlight buildings. For factual answers without map changes, use queryBuildings.\n\n'
          + 'USAGE MODES:\n'
          + '- SINGLE: filterType + filterValue + optional color.\n'
          + '- AND: filters=[...] combineMode "AND" (default). Example tall hospitals: filters=[{filterType:"class",filterValue:"healthcare"},{filterType:"height",filterValue:">=30"}].\n'
          + '- OR: combineMode "OR" with per-leg colors.\n'
          + '- Shared AND on every OR group: andFilters.\n'
          + '- Reset: filterType "none".\n\n'
          + 'filterType: class | walkability | height | energy LTB | energy UTB | uhi4 | uhi9 | sunhours | none.\n'
          + 'Class: casual names OK (schools, hospitals, residential, …).\n'
          + 'NUMERIC filterValue MUST be a numeric expression — ">=58", "<30", "20-30". Never put label words in filterValue.\n'
          + 'Intent → value: walkability high ">=80" low "<30"; height tall ">=50" short "<10"; energy LTB inefficient ">=58" efficient "<=48"; energy UTB inefficient ">=750" efficient "<=300"; uhi4 hot ">=28"; uhi9 hot ">=26"; sunhours high ">=6" low "<4".',
        input: {
          type: 'object',
          properties: {
            filterType: {
              type: 'string',
              enum: ['class', 'walkability', 'height', 'energy', 'energy LTB', 'energy UTB', 'uhi4', 'uhi9', 'sunhours', 'none'],
              description: 'Filter type for single-condition use. Ignored when "filters" array is provided.'
            },
            filterValue: {
              type: 'string',
              description: 'Single-condition value. Numeric: ">=80", "50", or "20-30". Class: casual or exact name (schools, hospitals, healthcare, …). Ignored when "filters" is set.'
            },
            color: {
              type: 'string',
              description: 'Highlight color for single-condition or AND mode (CSS name, hex, or rgb()). In OR mode prefer per-filter color.'
            },
            filters: {
              type: 'array',
              description: 'Multi-condition list. combineMode AND = all must match (one color); OR = each leg its own color.',
              items: {
                type: 'object',
                properties: {
                  filterType: { type: 'string', enum: ['class', 'walkability', 'height', 'energy', 'energy LTB', 'energy UTB', 'uhi4', 'uhi9', 'sunhours'] },
                  filterValue: { type: 'string', description: 'Numeric threshold/range or class name (casual OK).' },
                  color: { type: 'string', description: 'Per-leg color in OR mode.' }
                },
                required: ['filterType', 'filterValue']
              }
            },
            combineMode: {
              type: 'string',
              enum: ['AND', 'OR'],
              description: 'AND (default): intersection, one shared color. OR: each filter leg highlighted in its own color. Must be uppercase.'
            },
            andFilters: {
              type: 'array',
              description: 'Extra AND constraints applied to every matching group (e.g. height when OR-coloring several classes).',
              items: {
                type: 'object',
                properties: {
                  filterType: { type: 'string', enum: ['class', 'walkability', 'height', 'energy', 'energy LTB', 'energy UTB', 'uhi4', 'uhi9', 'sunhours'] },
                  filterValue: { type: 'string', description: 'Numeric threshold/range or class name.' }
                },
                required: ['filterType', 'filterValue']
              }
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
          // Relative zoom; floor at 100m (same as flyTo height minimum) so already-close
          // views do not jump farther away via a 1km clamp.
          newHeight = Math.max(input.height / factor, 100);
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
          requestId: input?._requestId ?? null,
          toolCallId: input?._toolCallId ?? null,
          style: input.style,
          styleName: styleName,
          styleDefinition: styleDefinition,
          appliedResult: {
            action: 'setVisualizationStyle',
            style: input.style,
            styleName,
            description: `All buildings are now colored by ${styleName} across the city`
          },
          timestamp: new Date().toISOString()
        });      } catch (error) {
        console.error("Error emitting visualization style change event:", error);
        return { error: true, message: `Failed to emit visualization style change event: ${error}` };
      }

      return {
        success: true,
        message: `Successfully applied ${styleName} visualization style`,
        userMessage: `The map is now colored by ${styleName}.`,
        style: {
          id: input.style,
          name: styleName,
          definition: styleDefinition
        },
        uiEffect: {
          needsAck: true,
          timeoutMs: 5000,
          summary: `Apply visualization style: ${styleName}`
        }
      };
    } catch (error) {
      console.error("Error in setVisualizationStyle handler:", error);
      return { error: true, message: "Failed to set visualization style" };
    } finally {
      span.end();
    }
  });

  thing.setActionHandler('queryBuildings', async (params: any) => {
    const span = tracer.startSpan('queryBuildings');
    try {
      let input: any;
      if (params && typeof params.value === 'function') {
        input = await params.value();
      } else {
        input = params || {};
      }

      type FilterLeg = { filterType: string; filterValue: string };
      let resolvedFilters: FilterLeg[];
      if (Array.isArray(input.filters) && input.filters.length > 0) {
        resolvedFilters = input.filters;
      } else if (input.filterType && input.filterValue) {
        resolvedFilters = [{ filterType: input.filterType, filterValue: input.filterValue }];
      } else {
        return { error: true, message: 'Provide either filterType+filterValue or a non-empty filters array.' };
      }

      for (const leg of resolvedFilters) {
        if (!VALID_FILTER_TYPES.includes(leg.filterType as FilterType)) {
          return { error: true, message: `Invalid filterType "${leg.filterType}". Valid values: ${VALID_FILTER_TYPES.join(', ')}.` };
        }
        if (!leg.filterValue) {
          return { error: true, message: `filterValue is required for filterType "${leg.filterType}".` };
        }
        if (leg.filterType === 'class') {
          leg.filterValue = resolveBuildingClass(String(leg.filterValue));
        }
      }

      const stats = await queryBuildingsMatching(resolvedFilters);
      if (!stats) {
        return { error: true, message: 'Failed to query building statistics.' };
      }

      const label = resolvedFilters
        .map((l) => (l.filterType === 'class' ? l.filterValue : `${l.filterType} ${l.filterValue}`))
        .join(' AND ');

      let userMessage: string;
      if (stats.count === 0) {
        userMessage = `I couldn't find any buildings matching ${label}.`;
      } else if (stats.heightAvg != null) {
        userMessage =
          `For buildings matching ${label}: ${stats.count.toLocaleString()} buildings, `
          + `height avg ${stats.heightAvg} m`
          + (stats.heightMin != null && stats.heightMax != null
            ? ` (range ${stats.heightMin}–${stats.heightMax} m)`
            : '')
          + '.';
      } else {
        userMessage = `Found ${stats.count.toLocaleString()} buildings matching ${label}.`;
      }

      return {
        success: true,
        message: userMessage,
        userMessage,
        facts: {
          label,
          filters: resolvedFilters,
          count: stats.count,
          heightMin: stats.heightMin,
          heightAvg: stats.heightAvg,
          heightMax: stats.heightMax,
          energyLtbAvg: stats.energyLtbAvg,
          walkabilityAvg: stats.walkabilityAvg
        }
      };
    } catch (error) {
      console.error('Error in queryBuildings handler:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { error: true, message: `Failed to query buildings: ${errorMessage}` };
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
            requestId: input?._requestId ?? null,
            toolCallId: input?._toolCallId ?? null,
            style: 'none',
            styleName: 'Default Style',
            styleDefinition: { show: true },
            appliedResult: {
              action: 'clearFilter',
              style: 'none',
              styleName: 'Default Style',
              description: 'Building filter cleared; map reset to default building appearance'
            },
            timestamp: new Date().toISOString()
          });
        } catch (error) {
          console.error('Error resetting filter:', error);
          return { error: true, message: `Failed to reset visualization style: ${error}` };
        }
        return {
          success: true,
          message: 'Removed building filter and reset to default visualization style',
          userMessage: 'Building filter cleared; the map is back to the default style.',
          filter: { type: 'none', style: { show: true } },
          uiEffect: {
            needsAck: true,
            timeoutMs: 5000,
            summary: 'Clear building filter / reset default style'
          }
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

      // Validate every leg; normalize casual class names (schools → schools, education, research)
      for (const leg of resolvedFilters) {
        if (!VALID_FILTER_TYPES.includes(leg.filterType as FilterType)) {
          return { error: true, message: `Invalid filterType "${leg.filterType}". Valid values: ${VALID_FILTER_TYPES.join(', ')}.` };
        }
        if (!leg.filterValue) {
          return { error: true, message: `filterValue is required for filterType "${leg.filterType}".` };
        }
        if (leg.filterType === 'class') {
          leg.filterValue = resolveBuildingClass(String(leg.filterValue));
        }
      }

      // Optional shared AND constraints applied to every match group
      type SharedAndLeg = { filterType: string; filterValue: string };
      const sharedAndLegs: SharedAndLeg[] = Array.isArray(input.andFilters) ? input.andFilters : [];
      for (const leg of sharedAndLegs) {
        if (!VALID_FILTER_TYPES.includes(leg.filterType as FilterType)) {
          return { error: true, message: `Invalid andFilters filterType "${leg.filterType}". Valid values: ${VALID_FILTER_TYPES.join(', ')}.` };
        }
        if (!leg.filterValue) {
          return { error: true, message: `andFilters filterValue is required for filterType "${leg.filterType}".` };
        }
        if (leg.filterType === 'class') {
          leg.filterValue = resolveBuildingClass(String(leg.filterValue));
        }
      }

      const sharedAndExprs: string[] = [];
      for (const leg of sharedAndLegs) {
        const result = buildCesiumExpression(leg.filterType, leg.filterValue);
        if ('error' in result) return { error: true, message: `andFilters: ${result.error}` };
        sharedAndExprs.push(result.expr);
      }
      const withSharedAnd = (expr: string): string =>
        sharedAndExprs.length === 0 ? expr : `(${expr}) && (${sharedAndExprs.join(' && ')})`;

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
        const combinedExpr = withSharedAnd(expressions.join(' && '));

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
        // OR mode: each leg gets its own colour; shared andFilters are ANDed onto each leg.
        const legConditions: [string, string][] = [];
        for (const leg of resolvedFilters) {
          const result = buildCesiumExpression(leg.filterType, leg.filterValue);
          if ('error' in result) return { error: true, message: result.error };
          const colour = leg.color
            || (leg.filterType === 'class'
                ? BUILDING_CLASS_COLORS[leg.filterValue] || DEFAULT_FILTER_COLORS['class']
                : DEFAULT_FILTER_COLORS[leg.filterType] || 'rgb(255, 255, 0)');
          legConditions.push([withSharedAnd(result.expr), toCesiumColorExpr(colour)]);
        }
        conditions = [...legConditions, ["true", "color('white')"]];
      }

      const filterStyleDefinition = { color: { conditions } };

      // ── Verified facts (domain data) + UI effect (presentation) ──────────
      // facts = what is true in the database; uiEffect = what the browser should apply.
      // The LLM must use facts for "what exists", uiStatus only for "style was applied".
      type MatchGroup = {
        filterType: string;
        filterValue: string;
        color: string | null;
        matchCount: number | null;
        label: string;
      };

      const matchGroups: MatchGroup[] = [];
      if (combineMode === 'AND') {
        const count = await countBuildingsMatching([...resolvedFilters, ...sharedAndLegs]);
        const first = resolvedFilters[0];
        const color = input.color || first.color || null;
        matchGroups.push({
          filterType: 'combined',
          filterValue: resolvedFilters.map((l) => `${l.filterType}:${l.filterValue}`).join('+'),
          color,
          matchCount: count,
          label: resolvedFilters.map((l) =>
            l.filterType === 'class' ? l.filterValue : `${l.filterType} ${l.filterValue}`
          ).join(' AND ')
        });
      } else {
        for (const leg of resolvedFilters) {
          const count = await countBuildingsMatching([leg, ...sharedAndLegs]);
          const colour = leg.color
            || (leg.filterType === 'class'
                ? BUILDING_CLASS_COLORS[leg.filterValue] || DEFAULT_FILTER_COLORS['class']
                : DEFAULT_FILTER_COLORS[leg.filterType] || null);
          matchGroups.push({
            filterType: leg.filterType,
            filterValue: leg.filterValue,
            color: colour,
            matchCount: count,
            label: leg.filterType === 'class' ? leg.filterValue : `${leg.filterType} ${leg.filterValue}`
          });
        }
      }

      const describeLeg = (l: FilterLeg): string => {
        const colorPart = l.color ? ` in ${l.color}` : '';
        return `${l.filterType} ${l.filterValue}${colorPart}`;
      };
      const styleLabel = resolvedFilters.map(describeLeg).join(combineMode === 'AND' ? ' AND ' : ' OR ');
      const andLabel = sharedAndLegs.length > 0
        ? `, also requiring ${sharedAndLegs.map((l) => `${l.filterType} ${l.filterValue}`).join(' AND ')}`
        : '';

      const emptyGroups = matchGroups.filter((g) => g.matchCount === 0);
      const totalMatched = matchGroups.reduce((sum, g) => sum + (g.matchCount ?? 0), 0);

      const facts = {
        combineMode,
        andFilters: sharedAndLegs,
        groups: matchGroups,
        emptyGroups: emptyGroups.map((g) => g.label),
        totalMatched
      };

      // Authoritative user-facing text (consumed by llmThing as the final answer).
      // Keep it natural — no match counts in the spoken reply.
      const friendlyLabel = (g: MatchGroup): string => {
        if (g.filterType === 'class' || g.filterType === 'combined') {
          const raw = g.filterType === 'class' ? g.filterValue : g.label;
          const map: Record<string, string> = {
            'healthcare': 'hospitals',
            'schools, education, research': 'schools',
            'sport': 'sports centers',
            'business, trade': 'business buildings',
            'habitation': 'residential buildings',
            'church institution': 'churches',
            'administration': 'administrative buildings',
            'industry': 'industrial buildings',
            'storage': 'storage buildings',
            'traffic': 'traffic buildings',
            'culture': 'cultural buildings'
          };
          if (g.filterType === 'class' && map[raw]) return map[raw];
          // combined AND of classes — map each piece when possible
          return raw.split(' AND ').map((p) => {
            const v = p.replace(/^class\s+/, '');
            return map[v] || v;
          }).join(' and ');
        }
        return g.label;
      };

      const friendlyConstraint = (legs: SharedAndLeg[]): string => {
        if (!legs.length) return '';
        return legs.map((l) => {
          const v = l.filterValue.trim();
          if (l.filterType === 'height') {
            if (v.startsWith('>=') || v.startsWith('>')) return `taller than ${v.replace(/^>=?/, '')} meters`;
            if (v.startsWith('<=') || v.startsWith('<')) return `shorter than ${v.replace(/^<=?/, '')} meters`;
            if (v.includes('-')) return `${v} meters tall`;
            return `height ${v}`;
          }
          if (l.filterType === 'walkability') {
            if (v.startsWith('>=') || v.startsWith('>')) return `walkability above ${v.replace(/^>=?/, '')}`;
            if (v.startsWith('<=') || v.startsWith('<')) return `walkability below ${v.replace(/^<=?/, '')}`;
            return `walkability ${v}`;
          }
          if (l.filterType === 'sunhours') {
            if (v.startsWith('>=') || v.startsWith('>')) return `more than ${v.replace(/^>=?/, '')} hours of sun`;
            return `sun hours ${v}`;
          }
          return `${l.filterType} ${v}`;
        }).join(' and ');
      };

      const visible = matchGroups.filter((g) => (g.matchCount ?? 0) > 0);
      const empty = matchGroups.filter((g) => g.matchCount === 0);
      const constraint = friendlyConstraint(sharedAndLegs);

      let userMessage: string;
      if (totalMatched === 0 && matchGroups.every((g) => g.matchCount != null)) {
        userMessage = constraint
          ? `I couldn't find any buildings that match (${constraint}), so nothing is highlighted.`
          : `I couldn't find any buildings that match that filter, so nothing is highlighted.`;
      } else if (visible.length === 1 && empty.length === 0) {
        const g = visible[0];
        const name = friendlyLabel(g);
        const Name = name.replace(/^\w/, (c) => c.toUpperCase());
        if (constraint && g.color) {
          userMessage = `${Name} ${constraint} are now highlighted in ${g.color}.`;
        } else if (constraint) {
          userMessage = `${Name} ${constraint} are now highlighted on the map.`;
        } else if (g.color) {
          userMessage = `${Name} are now highlighted in ${g.color}.`;
        } else {
          userMessage = `${Name} are now highlighted on the map.`;
        }
      } else {
        const listed = visible.map((g) => {
          const name = friendlyLabel(g);
          return g.color ? `${name} in ${g.color}` : name;
        });
        if (listed.length === 1) {
          const Name = listed[0].replace(/^\w/, (c) => c.toUpperCase());
          userMessage = constraint
            ? `${Name} are now highlighted (${constraint}).`
            : `${Name} are now highlighted on the map.`;
        } else if (listed.length === 2) {
          userMessage = constraint
            ? `The map now shows ${listed[0]} and ${listed[1]} (${constraint}).`
            : `The map now shows ${listed[0]} and ${listed[1]}.`;
        } else {
          const last = listed[listed.length - 1];
          const head = listed.slice(0, -1).join(', ');
          userMessage = constraint
            ? `The map now shows ${head}, and ${last} (${constraint}).`
            : `The map now shows ${head}, and ${last}.`;
        }
        if (empty.length === 1) {
          const g = empty[0];
          userMessage += g.color
            ? ` No ${friendlyLabel(g)} matched, so nothing appears in ${g.color}.`
            : ` No ${friendlyLabel(g)} matched.`;
        } else if (empty.length > 1) {
          userMessage += ` No ${empty.map(friendlyLabel).join(' or ')} matched, so those colors do not appear.`;
        }
      }

      const description = userMessage;

      const uiEffect = {
        needsAck: true,
        timeoutMs: 5000,
        summary: `Apply building filter style: ${styleLabel}${andLabel}`
      };

      const appliedResult = {
        action: 'filterBuildings',
        combineMode,
        filters: resolvedFilters,
        andFilters: sharedAndLegs,
        color: input.color || null,
        nonMatching: 'white',
        facts,
        description
      };

      try {
        await emitEvent('visualizationStyleChanged', {
          userId,
          requestId: input?._requestId ?? null,
          toolCallId: input?._toolCallId ?? null,
          style: 'custom_filter',
          styleName: `Filter: ${styleLabel}${andLabel}`,
          styleDefinition: filterStyleDefinition,
          appliedResult,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Error emitting filter visualization:', error);
        return { error: true, message: `Failed to emit filter visualization: ${error}` };
      }

      return {
        success: true,
        message: description,
        userMessage,
        filter: {
          filters: resolvedFilters,
          andFilters: sharedAndLegs,
          combineMode,
          style: filterStyleDefinition
        },
        facts,
        uiEffect,
        appliedResult
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
        requestId: input?._requestId ?? null,
        toolCallId: input?._toolCallId ?? null,
        id: SOFIA_TILESET.id,
        url: SOFIA_TILESET.url,
        name: SOFIA_TILESET.name,
        show: SOFIA_TILESET.show,
        appliedResult: {
          action: 'loadTiles',
          tilesetId: SOFIA_TILESET.id,
          tilesetName: SOFIA_TILESET.name,
          show: SOFIA_TILESET.show,
          description: `Sofia's 3D building tiles (${SOFIA_TILESET.name}) are now loaded and visible on the map`
        },
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
        userMessage: 'The 3D model of Sofia\'s buildings has been loaded onto the map.',
        tileset: {
          name: SOFIA_TILESET.name,
          id: SOFIA_TILESET.id,
          url: SOFIA_TILESET.url
        },
        uiEffect: {
          needsAck: true,
          timeoutMs: 15000,
          summary: `Load 3D tileset: ${SOFIA_TILESET.name}`
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
          requestId: removeInput?._requestId ?? null,
          toolCallId: removeInput?._toolCallId ?? null,
          id: SOFIA_TILESET_ID,
          appliedResult: {
            action: 'removeTiles',
            tilesetId: SOFIA_TILESET_ID,
            description: "Sofia's 3D building tiles were removed from the map"
          },
          timestamp: new Date().toISOString()
        });      } catch (error) {
        console.error("Error emitting tileset remove event:", error);
        return { error: true, message: `Failed to emit tileset removal event: ${error}` };
      }

      return {
        success: true,
        message: 'Successfully removed Sofia\'s 3D building tiles',
        userMessage: 'Sofia\'s 3D building tiles have been removed from the map.',
        tileset: {
          id: SOFIA_TILESET_ID,
          name: 'Sofia Buildings'
        },
        uiEffect: {
          needsAck: true,
          timeoutMs: 5000,
          summary: 'Remove Sofia 3D tileset from map'
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
