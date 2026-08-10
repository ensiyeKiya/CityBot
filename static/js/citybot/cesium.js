import { appConfig } from './config.js';

/* ========================= 2. Cesium viewer ======================= */

    Cesium.Ion.defaultAccessToken = appConfig.ION_ACCESS_TOKEN;

    // Initialize Cesium asynchronously with timeout handling
    async function initCesium() {
      try {        
        // Create terrain provider with timeout handling
        let terrainProvider;
        try {          const terrainResource = await Promise.race([
            Cesium.IonResource.fromAssetId(2564867, {
              accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJjNWUzZmI0ZS02NDcxLTRlNjktYTcyYi00OWZlNTA4ZmViMTAiLCJpZCI6NDY4MjksImlhdCI6MTYxNjYwMTM4Nn0.3KOIXUjF4QpChsVKmW9pNy5WdE6qi3C61jBJc9VJGIQ"
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Terrain resource timeout')), 15000))
          ]);

          terrainProvider = await Promise.race([
            Cesium.CesiumTerrainProvider.fromUrl(terrainResource, {
              requestVertexNormals: true,
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Terrain provider timeout')), 10000))
          ]);        } catch (error) {
          console.warn('⚠️ Failed to load Ion terrain, using default terrain:', error.message);
          // Fallback to default terrain
          terrainProvider = new Cesium.EllipsoidTerrainProvider();
        }

        // Make viewer globally available
        window.viewer = new Cesium.Viewer('cesiumContainer', {
          terrainProvider: terrainProvider,
          animation: true,   // show the playback controls (date & time read‑out)
          baseLayerPicker: false,
          fullscreenButton: false,
          geocoder: false,
          homeButton: false,
          infoBox: true,  // Enable InfoBox to show entity descriptions
          sceneModePicker: false,
          selectionIndicator: false,
          timeline:  true,   // show the timeline scrub bar
          navigationHelpButton: false,
          navigationInstructionsInitiallyVisible: false,
          contextOptions: { webgl: { alpha: true } }
        });

        performance.mark('viewer-start');
        // Ensure atmosphere is rendered so the night‑side of Earth is never completely black
        window.viewer.scene.skyAtmosphere = new Cesium.SkyAtmosphere();

        // Add Photorealistic 3D Tiles for realistic 3D buildings and terrain with timeout
        try {          window.googleTileset = await Promise.race([
            Cesium.Cesium3DTileset.fromIonAssetId(2275207, {
              enableDebugWireframe: false
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Google tileset timeout')), 20000))
          ]);
          
          window.googleTileset.id = 'google-photorealistic-tileset';
          window.viewer.scene.primitives.add(window.googleTileset);        } catch (error) {
          console.warn(`⚠️ Error loading Photorealistic 3D Tiles tileset: ${error.message}`);
          window.googleTileset = null;
        }

        // Set initial camera view
        window.viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(23.3219, 42.6977, 10000),
          orientation: {
            heading: Cesium.Math.toRadians(0),
            pitch: Cesium.Math.toRadians(-90),
            roll: 0
          }
        });

        // Keep imagery fully lit to prevent night-side blackouts
        window.viewer.scene.globe.enableLighting = false;
        window.viewer.scene.globe.atmosphereBrightnessShift = 0.1;
        window.viewer.scene.globe.atmosphereSaturationShift = 0.8;

        // Make tilesAreLoaded a global variable
        window.tilesAreLoaded = false;
        window.viewer.scene.globe.tileLoadProgressEvent.addEventListener((remaining) => {
          if (remaining === 0) {
            window.tilesAreLoaded = true;
            window.viewer.scene.requestRender();
          }
        });
        
        // Add click handler for both buildings (3D tiles) and sensors (entities)
        const handler = new Cesium.ScreenSpaceEventHandler(window.viewer.scene.canvas);
        handler.setInputAction((movement) => {
          const picked = window.viewer.scene.pick(movement.position);
          
          // Check if we clicked on a 3D tile feature (building)
        if (picked && picked instanceof Cesium.Cesium3DTileFeature) {          
          // Hide InfoBox for buildings
          window.viewer.selectedEntity = undefined;
          
          window.handleBuildingClick(picked);

          // Report selection to backend for LLM awareness
          try {
            if (window.thing) {
              const propIds = picked.getPropertyIds();
              const props = {};
              for (let i = 0; i < propIds.length; i++) {
                const k = propIds[i];
                props[k] = picked.getProperty(k);
              }
              // Build data object and filter out undefined/invalid values
              const buildingData = {
                gmlId: props.gml_id || props.GMLID,
                coordinates: {
                  latitude: props.lat,
                  longitude: props.lon,
                  height: props.citygml_measured_height
                },
                class: props.citygml_class_description,
                function: props.citygml_function_description,
                addr: props.addr,
                wiki_title_bg: props.wiki_title_bg,
                wiki_pageid: props.wiki_pageid,
                wikidata_instances: props.wikidata_instances,
                walk_access_index: props.walk_access_index,
                sunhrs_int_avg: props.sunhrs_int_avg,
                timestamp: new Date().toISOString()
              };              
              // Remove undefined, null, and NaN values to satisfy WoT schema validation
              Object.keys(buildingData).forEach(key => {
                const value = buildingData[key];
                if (value === undefined || value === null || (typeof value === 'number' && isNaN(value))) {
                  delete buildingData[key];
                }
              });
              
              // Clean up coordinates object - remove invalid values
              if (buildingData.coordinates) {
                Object.keys(buildingData.coordinates).forEach(key => {
                  const value = buildingData.coordinates[key];
                  if (value === undefined || value === null || (typeof value === 'number' && isNaN(value))) {
                    delete buildingData.coordinates[key];
                  }
                });
                
                // If coordinates object is empty after cleanup, remove it entirely
                if (Object.keys(buildingData.coordinates).length === 0) {
                  delete buildingData.coordinates;                }
              }
              window.llmSelectedBuilding = window.withUserId({ ...buildingData });
              
              window.thing.writeProperty('selectedBuildingState', window.withUserId(buildingData))
                .then(() => {                })
                .catch(err => {
                  console.error('❌ Failed to write building selection:', err);
                });
              
            }
          } catch (err) {
            console.error('❌ Failed to report building selection:', err);
          }
        } else if (picked && picked.id && picked.id instanceof Cesium.Entity) {
          // Check if we clicked on an entity (sensor)          
          // Show InfoBox for sensors by selecting the entity
          window.viewer.selectedEntity = picked.id;
        } else {
          // Clicked on nothing - deselect everything
          window.viewer.selectedEntity = undefined;
          
          // Restore building style color and close building info panel
          window.clearBuildingSelectionHighlight();
          
          // Hide building info panel if visible
          const buildingInfoPanel = document.getElementById('buildingInfoPanel');
          if (buildingInfoPanel && buildingInfoPanel.style.display === 'flex') {
            buildingInfoPanel.style.display = 'none';
            window.selectedBuilding = null;            
            // Notify server that building has been deselected
            if (window.thing) {
              window.llmSelectedBuilding = window.withUserId({
                gmlId: null,
                class: null,
                function: null,
                addr: null,
                wiki_title_bg: null,
                wiki_pageid: null,
                wikidata_instances: null,
                walk_access_index: null,
                sunhrs_int_avg: null,
                timestamp: new Date().toISOString()
              });
              window.thing.writeProperty('selectedBuildingState', window.llmSelectedBuilding).then(() => {              }).catch(err => {
                console.error('❌ Failed to send building deselection:', err);
              });
            }
          }
        }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);        
      } catch (error) {
        console.error('❌ Critical error during Cesium initialization:', error);
        throw error;
      }
    }

    window.initCesium = initCesium;
