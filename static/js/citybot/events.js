import { appConfig } from './config.js';

window.subscribeToWoTEvents = async function() {
      if (!window.thing) {        return;
      }
      
      try {
        // All events now handled via MQTT - no WoT subscriptions needed        
        // Define message handlers for MQTT
        window.handleConversationStreamMessage = async (payload, transport) => {
          if (!payload) {            return;
          }

          // Track message sequence for loss detection
          if (!window.conversationStreamStats) {
            window.conversationStreamStats = {
              totalMessages: 0,
              tokenMessages: 0,
              planningMessages: 0,
              finalMessages: 0,
              lastMessageTime: null,
              requestId: null
            };
          }
          
          window.conversationStreamStats.totalMessages++;
          window.conversationStreamStats.lastMessageTime = new Date().toISOString();
          
          if (payload.requestId && window.conversationStreamStats.requestId !== payload.requestId) {
            window.conversationStreamStats.requestId = payload.requestId;
            window.conversationStreamStats.tokenMessages = 0;
            window.conversationStreamStats.planningMessages = 0;
            window.conversationStreamStats.finalMessages = 0;
          }

          // Check if this is an auto-generated building analysis
          // Check both the metadata flag and the requestId pattern
          const isAutoBuildingAnalysis = payload.metadata?.autoBuildingAnalysis === true || 
                                          (payload.requestId && payload.requestId.startsWith('llm-auto-building-'));
          
          if (!window.activeStreamRequestId && payload.requestId) {
            window.activeStreamRequestId = payload.requestId;
          }
          
          // Allow auto-generated building analysis through even if it doesn't match activeStreamRequestId
          if (payload.requestId !== window.activeStreamRequestId && !isAutoBuildingAnalysis) {
            console.log('[CityBot][stream] ignored (requestId mismatch)', {
              transport,
              payloadRequestId: payload.requestId,
              activeStreamRequestId: window.activeStreamRequestId,
              isFinal: payload.isFinal,
              planningUpdate: payload.metadata?.planningUpdate || null
            });
            return;
          }

          if (payload.metadata?.planningUpdate || payload.isFinal) {
            console.log('[CityBot][stream]', {
              transport,
              requestId: payload.requestId,
              isFinal: !!payload.isFinal,
              planningUpdate: payload.metadata?.planningUpdate || null,
              toolsUsed: payload.metadata?.toolsUsed ?? null,
              toolCount: payload.metadata?.toolCount ?? (payload.metadata?.toolsUsed?.length ?? null),
              processingTimeSeconds: payload.metadata?.processingTimeSeconds ?? null,
              responsePreview: payload.metadata?.response
                ? String(payload.metadata.response).slice(0, 160)
                : null,
              tokenLen: payload.token ? String(payload.token).length : 0
            });
          }
          
          // If this is auto-building analysis, switch to this requestId
          if (isAutoBuildingAnalysis && payload.requestId !== window.activeStreamRequestId) {            window.activeStreamRequestId = payload.requestId;
            // Reset stream state for new auto-analysis
            window.streamMessageContentEl = null;
            window.streamAccumulatedText = '';
          }

          // Handle planning updates - show them in the thinking message
          if (payload.metadata?.planningUpdate && !payload.isFinal) {
            window.conversationStreamStats.planningMessages++;

            // Find and update the thinking message
            const thinkingMessage = document.querySelector('.thinking:last-child');
            if (thinkingMessage) {
              const contentEl = thinkingMessage.querySelector('.message-content');
              if (contentEl) {
                contentEl.textContent = payload.metadata.planningUpdate;
              }
            }
            document.getElementById('chatMessages').scrollTop = document.getElementById('chatMessages').scrollHeight;
            return;
          }

          if (!payload.isFinal && payload.token) {
            window.conversationStreamStats.tokenMessages++;

            // Create message element only when we have the first token
            if (!window.streamMessageContentEl) {
              document.querySelectorAll('.thinking').forEach(thinkingMsg => {
                thinkingMsg.remove();
              });
              
              const messageElement = window.addMessage('', false);
              window.streamMessageContentEl = messageElement.querySelector('.message-content');
              window.streamAccumulatedText = ''; // Initialize accumulated text
            }
            
            // For streaming, we need to accumulate text and then convert to HTML
            if (!window.streamAccumulatedText) window.streamAccumulatedText = '';
            const previousLength = window.streamAccumulatedText.length;
            window.streamAccumulatedText += payload.token;
            
            window.streamMessageContentEl.innerHTML = window.markdownToHtml(window.streamAccumulatedText);
            document.getElementById('chatMessages').scrollTop = document.getElementById('chatMessages').scrollHeight;
          } else if (payload.isFinal) {
            window.conversationStreamStats.finalMessages++;

            // Handle case where we get final response without any streaming tokens
            if (payload.metadata?.response && (!window.streamAccumulatedText || window.streamAccumulatedText.trim() === '')) {
              if (!window.streamMessageContentEl) {
                // Remove thinking messages and create message element
                document.querySelectorAll('.thinking').forEach(thinkingMsg => {
                  thinkingMsg.remove();
                });
                
                const messageElement = window.addMessage('', false);
                window.streamMessageContentEl = messageElement.querySelector('.message-content');
              }
              window.streamMessageContentEl.innerHTML = window.markdownToHtml(payload.metadata.response);
            }
            
            // Add system information after the response
            if (payload.metadata) {
              const toolsUsed = Array.isArray(payload.metadata.toolsUsed) ? payload.metadata.toolsUsed : [];
              console.log('[CityBot][stream] final toolsUsed=', toolsUsed.length ? toolsUsed : '(none)',
                'processingTime=', payload.metadata.processingTimeSeconds);

              // Create a container for system messages
              const sysContainer = document.createElement('div');
              sysContainer.style.marginBottom = '12px';

              // Always show tools status so missing tool calls are visible in the UI
              const toolsMsg = document.createElement('div');
              toolsMsg.className = 'message system-message';
              toolsMsg.innerHTML = toolsUsed.length > 0
                ? `<strong>Tools:</strong> ${toolsUsed.join(', ')}`
                : `<strong>Tools:</strong> none`;
              sysContainer.appendChild(toolsMsg);
              
              // Show processing time if available
              if (payload.metadata.processingTimeSeconds) {
                const timeMsg = document.createElement('div');
                timeMsg.className = 'message system-message';
                timeMsg.innerHTML = `<strong>Processing time:</strong> ${payload.metadata.processingTimeSeconds}s`;
                sysContainer.appendChild(timeMsg);
              }
              
              if (sysContainer.childNodes.length > 0) {
                document.getElementById('chatMessages').appendChild(sysContainer);
              }
            }
            
            // Attach feedback bar to the bot message that was just completed
            if (window.streamMessageContentEl && payload.requestId) {
              const botMsg = window.streamMessageContentEl.closest('.message');
              if (botMsg && !botMsg.querySelector('.feedback-bar')) {
                botMsg.appendChild(window.buildFeedbackBar(payload.requestId));
              }
            }

            // Reset accumulated text for next message
            window.streamAccumulatedText = '';
            window.streamMessageContentEl = null;
            document.getElementById('chatMessages').scrollTop = document.getElementById('chatMessages').scrollHeight;
            
            // Handle TTS for voice mode if needed
            if (window.shouldDoTTSAfterStream && payload.metadata?.response) {              window.shouldDoTTSAfterStream = false; // Reset flag
              
              try {
                if (!isqamode && currentAudio) {
                  interruptTTS();
                }
                
                // Sanitize text before TTS to remove markdown and emojis
                const sanitizedText = sanitizeTextForTTS(payload.metadata.response);                
                const audio = await getSpeech(sanitizedText);
                const audioURL = URL.createObjectURL(audio);
                currentAudio = new Audio(audioURL);
                
                currentAudio.onended = () => {                  currentAudio = null;
                  // Handle restart or stop before unlocking UI
                  if (isqamode) {
                    stopListeningMode();
                  } else if (state !== 'IDLE') {
                    // Restart listening mode for continuous conversation
                    // Ensure button is green and recording class is set
                    document.getElementById('micButton').classList.replace('red', 'green');
                    chatPanel.classList.add('recording');
                    state = 'LISTENING';
                    startListeningMode();
                  } else {
                    // Only unlock UI if we're not restarting
                    window.unlockUI();
                  }
                };
                
                await currentAudio.play();
                state = 'SPEAKING';              } catch (err) {
                console.error("🔇 Audio playback error:", err);
                window.unlockUI();
              }
            } else {
              // No TTS needed, reset UI immediately after streaming completes
              window.unlockUI();
            }
          }
        };

        window.handleTilesetChangedMessage = (payload, transport) => {          
          if (!payload) {
            console.error('payload is null/undefined');
            return;
          }
          if (payload.userId != null && payload.userId !== window.currentUserId) return;

          try {
            const tilesAckBase = {
              requestId: payload.requestId || null,
              toolCallId: payload.toolCallId || null,
              kind: 'tileset',
              details: { action: payload.action, id: payload.id, name: payload.name }
            };

            if (payload.action === 'remove') {              const primitives = window.viewer.scene.primitives;
              let removed = false;
              for (let i = primitives.length - 1; i >= 0; i--) {
                const primitive = primitives.get(i);
                if (primitive.id === payload.id) {
                  primitives.remove(primitive);
                  removed = true;
                  // Clear Sofia tileset reference and restore Google tileset
                  if (payload.id === 'sofia-buildings-tileset') {
                    window.sofiaTileset = null;                    
                    if (window.googleTileset) {
                      window.googleTileset.show = true;
                    }
                  }
                  break;
                }
              }
              window.reportUiStatus({
                ...tilesAckBase,
                status: 'applied',
                summary: removed
                  ? `Removed tileset from map: ${payload.name || payload.id}`
                  : `Tileset remove requested (not found on map): ${payload.id}`
              });
            } else if (payload.action === 'add') {
              
              // Hide Google tileset when loading Sofia tiles
              if (payload.id === 'sofia-buildings-tileset' && window.googleTileset) {
                window.googleTileset.show = false;              }
              
              (async () => {
                try {                  const tilesetLoadStart = performance.now();
                  
                  const tileset = await Cesium.Cesium3DTileset.fromUrl(payload.url, {
                    dynamicScreenSpaceError: false,
                    maximumScreenSpaceError: 1
                  });
                  
                  const tilesetLoadTime = performance.now() - tilesetLoadStart;
                  
                  tileset.id = payload.id;
                  tileset.show = payload.show !== undefined ? payload.show : true;                  window.viewer.scene.primitives.add(tileset);
                  
                  // Store Sofia tileset reference for visualization styles
                  if (payload.id === 'sofia-buildings-tileset') {
                    window.sofiaTileset = tileset;                    
                    // Apply any pending visualization style
                    if (window.pendingVisualizationStyle) {
                      const pending = window.pendingVisualizationStyle;
                      const ok = window.applyVisualizationStyle(pending.styleDefinition, pending.styleName);
                      window.pendingVisualizationStyle = null;
                      // Ack the pending style apply (may have different toolCallId)
                      if (pending.toolCallId || pending.requestId) {
                        window.reportUiStatus({
                          requestId: pending.requestId || null,
                          toolCallId: pending.toolCallId || null,
                          kind: 'visualization',
                          status: ok ? 'applied' : 'failed',
                          summary: ok
                            ? `Map style applied after tiles load: ${pending.styleName}`
                            : `Failed to apply queued style after tiles load: ${pending.styleName}`,
                          details: { style: pending.style, styleName: pending.styleName }
                        });
                      }
                    }
                  }
                  
                  await window.viewer.flyTo(tileset);
                  window.reportUiStatus({
                    ...tilesAckBase,
                    status: 'applied',
                    summary: `3D tiles loaded on map: ${payload.name || payload.id}`,
                    details: { ...tilesAckBase.details, loadMs: Math.round(tilesetLoadTime) }
                  });
                } catch (tilesetError) {
                  console.error('❌ Failed to load tileset:', tilesetError);
                  window.reportUiStatus({
                    ...tilesAckBase,
                    status: 'failed',
                    summary: `Failed to load tileset on map: ${tilesetError.message || String(tilesetError)}`
                  });
                  // window.addMessage(`Error loading tileset: ${tilesetError.message}`);
                }
              })();
            }
          } catch (err) {
            console.error('Failed to handle tilesetChanged event:', err);
            // window.addMessage(`Error handling tileset change: ${err.message}`);
          }
        };

        window.handleSTTProgressMessage = (payload, transport) => {          
          // Handle pending STT requests
          if (window.pendingSTTRequests && payload.requestId && window.pendingSTTRequests[payload.requestId]) {            const handler = window.pendingSTTRequests[payload.requestId];
            
            if (payload.status === 'completed') {              handler.resolve(payload.text);
            } else if (payload.status === 'error') {              handler.reject(payload.error);
            } else {            }
          } else {          }
        };

        window.handleMapViewMessage = (payload, transport) => {          
          if (!payload) {
            console.error('Invalid mapView payload');
            return;
          }
          if (payload.userId != null && payload.userId !== window.currentUserId) return;

          const now = Date.now();
          if (window.isOwnCameraUpdate || (now - window.lastOwnUpdateTime) < 500) {
            return;
          }

          // Extract values we use later in nextFly
          const lon = payload.coordinates?.longitude ?? payload.camera?.longitude ?? 0;
          const lat = payload.coordinates?.latitude ?? payload.camera?.latitude ?? 0;
          const hgtRaw = payload.coordinates?.height ?? payload.camera?.height;
          const hgt = (typeof hgtRaw === 'number' ? hgtRaw : 100000);
          const head = payload.camera?.heading ?? 0;
          const pit = payload.camera?.pitch ?? -90;
          const rol = payload.camera?.roll ?? 0;
          window.queue.push(payload);
          window.nextFly();
        };

        window.handleEntityAddedMessage = (payload, transport) => {
          const logId = Math.random().toString(36).substr(2, 9);          
          if (!payload) {
            console.error('Invalid entityAdded payload');
            return;
          }
          
          try {
            if (payload.action === 'remove') {
              const entity = window.viewer.entities.getById(payload.id);
              if (entity) {
                window.viewer.entities.remove(entity);
                // window.addMessage(`Removed ${payload.id} from map`);
              }
              return;
            }

            const position = payload.position;
            let entityOptions;
            if (payload.type === 'polyline' && Array.isArray(position)) {
              const positions = position.map(pos => Cesium.Cartesian3.fromDegrees(pos.longitude, pos.latitude, pos.height || 0));
              entityOptions = {
                id: payload.id,
                name: payload.properties?.name || payload.id,
                polyline: {
                  positions: positions,
                  width: 3,
                  material: Cesium.Color.RED,
                  clampToGround: true
                }
              };
            } else {
              if (!position || typeof position.latitude !== 'number' || typeof position.longitude !== 'number') {
                console.error('Invalid position in entityAdded event:', position);
                return;
              }
              const cartesianPosition = Cesium.Cartesian3.fromDegrees(position.longitude, position.latitude, position.height || 0);
              entityOptions = {
                id: payload.id,
                position: cartesianPosition,
                name: payload.properties?.name || payload.properties?.text || payload.id
              };
              switch (payload.type) {
                case 'point':
                case 'billboard':
                  entityOptions.point = {
                    pixelSize: 10,
                    color: Cesium.Color.YELLOW,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
                  };
                  break;
                case 'label':
                  entityOptions.label = {
                    text: payload.properties?.text || entityOptions.name,
                    font: payload.properties?.font || '14pt monospace',
                    fillColor: Cesium.Color.fromCssColorString(payload.properties?.fillColor || 'white'),
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    outlineWidth: 2,
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    pixelOffset: new Cesium.Cartesian2(0, -9),
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
                  };
                  break;
                case 'model':
                  if (payload.properties?.uri) {
                    entityOptions.model = {
                      uri: payload.properties.uri,
                      minimumPixelSize: payload.properties.minimumPixelSize || 128,
                      maximumScale: payload.properties.maximumScale || 20000
                    };
                  }
                  break;
                default:
                  entityOptions.point = {
                    pixelSize: 8,
                    color: Cesium.Color.CYAN,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 1,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
                  };
              }
            }
            window.viewer.entities.add(entityOptions);
            // window.addMessage(`Added ${payload.type} ${payload.type === 'polyline' ? 'with ' + (Array.isArray(position) ? position.length : 0) + ' points' : 'marker'}: ${entityOptions.name}`);
          } catch (err) {
            console.error('Failed to handle entityAdded event:', err);
            // window.addMessage(`Error adding entity: ${err.message}`);
          }
        };

        window.handleVisualizationStyleMessage = (payload, transport) => {          
          if (!payload || !payload.style || !payload.styleDefinition) {
            console.error('❌ Invalid visualization style payload - missing style or definition');
            console.error('❌ Payload structure:', payload);
            return;
          }
          if (payload.userId != null && payload.userId !== window.currentUserId) return;

          const styleName = payload.styleName || payload.style;
          const ackBase = {
            requestId: payload.requestId || null,
            toolCallId: payload.toolCallId || null,
            kind: 'visualization',
            details: { style: payload.style, styleName }
          };
          
          try {
            // Apply the visualization style using server-provided definition
            if (window.sofiaTileset && window.applyVisualizationStyle) {
              const ok = window.applyVisualizationStyle(payload.styleDefinition, styleName);
              window.reportUiStatus({
                ...ackBase,
                status: ok ? 'applied' : 'failed',
                summary: ok
                  ? `Map style applied on screen: ${styleName}`
                  : `Failed to apply map style on screen: ${styleName}`
              });
            } else {
              // Queue style until Sofia tiles load; ack is sent when it is actually applied
              window.pendingVisualizationStyle = {
                styleDefinition: payload.styleDefinition,
                styleName,
                requestId: payload.requestId || null,
                toolCallId: payload.toolCallId || null,
                style: payload.style
              };
              console.log('[CityBot] visualization style queued until tiles load:', styleName);
            }
          } catch (error) {
            console.error(`❌ Error applying visualization style:`, error);
            window.reportUiStatus({
              ...ackBase,
              status: 'failed',
              summary: `Error applying map style: ${error.message || String(error)}`
            });
          }
        };

        // Function to create building info table HTML
        window.createBuildingInfoTable = function(feature, name) {
          const propertyIds = feature.getPropertyIds();
          
          // Define the properties we want to display in a specific order
          const displayProperties = [
            { key: 'addr', label: 'Address' },
            { key: 'citygml_class_description', label: 'Class' },
            { key: 'citygml_function_description', label: 'Function' },
            { key: 'sunhrs_int_avg', label: 'Average sunshine hours' },
            { key: 'citygml_measured_height', label: 'Height (m)' },
            { key: 'lat', label: 'Latitude' },
            { key: 'lon', label: 'Longitude' },
            { key: 'energy_ti_ltb', label: 'Energy Lower Tolerance Bound' },
            { key: 'energy_ti_utb', label: 'Energy Upper Tolerance Bound' },
            { key: 'walk_access_index', label: 'Walkability' },
            { key: 'wiki_title_bg', label: 'Wikipedia article title' }
          ];
          
          let tableRows = '';
          
          // Add the defined properties first
          displayProperties.forEach(prop => {
            const value = feature.getProperty(prop.key);
            const displayValue = (value !== null && value !== undefined && value !== '') ? value : 'No data';
            tableRows += `<tr><th>${prop.label}</th><td>${displayValue}</td></tr>`;
          });
          
          return `
            <div id="featureInfoContent">
              <table class="feature-info-table">
                <tbody>
                  ${tableRows}
                </tbody>
              </table>
            </div>
          `;
        };

        // Building click handler - shows building info table and highlights the building
        window.handleBuildingClick = async (feature) => {          
          try {
            // Reset previous building's color if any
            if (window.selectedBuildingFeature) {
              window.selectedBuildingFeature.color = Cesium.Color.WHITE;            }
            
            // Highlight the newly selected building with a bright cyan color
            feature.color = Cesium.Color.CYAN.withAlpha(0.8);            
            // Store reference to the selected feature
            window.selectedBuildingFeature = feature;
            
            // Extract all properties from the clicked building
            const propertyIds = feature.getPropertyIds();
            const properties = {};
            
            for (let i = 0; i < propertyIds.length; i++) {
              const propName = propertyIds[i];
              properties[propName] = feature.getProperty(propName);
            }            
            // Store the selected building
            window.selectedBuilding = {
              feature: feature,
              properties: properties
            };
            
            // Get building name for display
            const buildingName = feature.getProperty('citygml_class_description') || 
                                feature.getProperty('name') || 
                                feature.getProperty('cad_id') || 
                                'Unnamed Building';
            
            // Create and display the building info table
            const buildingInfoPanel = document.getElementById('buildingInfoPanel');
            const buildingInfoContent = document.getElementById('buildingInfoContent');
            
            if (buildingInfoPanel && buildingInfoContent) {
              buildingInfoContent.innerHTML = window.createBuildingInfoTable(feature, buildingName);
              buildingInfoPanel.style.display = 'flex';            } else {
              console.error('❌ Building info panel elements not found');
            }
            
          } catch (error) {
            console.error('❌ Error handling building click:', error);
          }
        };


        // Initialize sensor storage
        window.sensorEntities = [];
        window.currentSensorOperator = null;
        window.currentSensorParameter = null;

        window.handleSensorsChangedMessage = async (payload, transport) => {          
          if (!payload || !payload.action) {
            console.error('❌ Invalid sensors payload');
            return;
          }
          
          try {
            if (payload.action === 'remove') {
              // Remove all sensor entities
              window.sensorEntities.forEach(entity => {
                window.viewer.entities.remove(entity);
              });
              window.sensorEntities = [];
              window.currentSensorOperator = null;              
            } else if (payload.action === 'load') {
              // Load sensors from backend data              
              // Store current sensor state
              window.currentSensorOperator = payload.operator;
              window.currentSensorParameter = payload.parameter; // Don't default to PM10
              
              // Clear existing sensors first
              window.sensorEntities.forEach(entity => {
                window.viewer.entities.remove(entity);
              });
              window.sensorEntities = [];
              
              // Create sensor entities from backend data
              if (payload.sensors && Array.isArray(payload.sensors)) {
                payload.sensors.forEach((feature) => {
                  // Handle both cases: specific parameter or all parameters
                  let displayValue, color, entityName, description;
                  
                  // Build description with all available sensor values
                  const sensorData = [];
                  const params = ['PM10', 'PM2.5', 'PM1', 'T', 'p', 'RH', 'WD', 'WS', 'R', 'SI', 'CO', 'CO2', 'NO', 'NO2', 'SO2', 'O3', 'C6H6'];
                  params.forEach(param => {
                    const value = feature.properties[param];
                    if (value !== undefined && value !== null) {
                      sensorData.push(`${param}: ${value}`);
                    }
                  });
                  
                  if (payload.parameter) {
                    // Specific parameter mode - use the parameter from backend
                    displayValue = feature.properties.currentValue;
                    color = getSensorColorFromValue(payload.parameter, displayValue);
                    entityName = `Air Quality Sensor ${feature.properties.object} - ${payload.parameter}: ${displayValue !== null && displayValue !== undefined ? displayValue : 'N/A'}`;
                    
                    // Include all measurements in description (HTML formatted for InfoBox)
                    description = sensorData.length > 0 
                      ? `${entityName}<br/><br/><b>All Measurements:</b><br/>${sensorData.join('<br/>')}`
                      : entityName;
                  } else {
                    // All parameters mode - show default color
                    displayValue = null;
                    color = Cesium.Color.CYAN; // Default color for "all parameters" mode
                    entityName = `Air Quality Sensor ${feature.properties.object}`;
                    
                    // Include all measurements in description (HTML formatted for InfoBox)
                    description = sensorData.length > 0 
                      ? `${entityName}<br/><br/><b>All Measurements:</b><br/>${sensorData.join('<br/>')}`
                      : `${entityName} - All Parameters`;
                  }
                  
                  const entity = window.viewer.entities.add({
                    name: entityName,
                    description: description,
                    position: Cesium.Cartesian3.fromDegrees(
                      feature.geometry.coordinates[0],
                      feature.geometry.coordinates[1],
                      0
                    ),
                    billboard: {
                      image: createSensorPin(color, feature.properties.object || 'Sensor'),
                      scale: 3.0, // Matches 3D-city-model (scale + 2 where default scale is 1)
                      scaleByDistance: new Cesium.NearFarScalar(100, 1.0, 10000, 0.3),
                      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                    },
                    properties: {
                      ...feature.properties,
                      operator: feature.properties.operator,
                      currentParam: payload.parameter,
                      currentValue: displayValue
                    },
                  });
                  
                  window.sensorEntities.push(entity);
                });
              }              
            } else if (payload.action === 'filter') {
              // Filter existing sensors              
              window.sensorEntities.forEach(entity => {
                let shouldShow = true;
                
                if (payload.filterType === 'quality') {
                  // Filter by air quality level
                  const value = entity.properties.currentValue?.getValue();
                  const parameter = payload.parameter || window.currentSensorParameter;
                  if (parameter) {
                    shouldShow = matchesQualityLevel(value, parameter, payload.filterValue);
                  } else {
                    shouldShow = false; // Can't filter by quality without a specific parameter
                  }
                  
                } else if (payload.filterType === 'value') {
                  // Filter by numeric value
                  const value = entity.properties.currentValue?.getValue();
                  const parameter = payload.parameter || window.currentSensorParameter;
                  if (parameter) {
                    shouldShow = matchesValueFilter(value, payload.filterValue);
                  } else {
                    shouldShow = false; // Can't filter by value without a specific parameter
                  }
                  
                } else if (payload.filterType === 'operator') {
                  // Filter by operator
                  const entityOperator = entity.properties.operator?.getValue();
                  shouldShow = entityOperator === payload.filterValue;
                  
                } else if (payload.filterType === 'name') {
                  // Filter by sensor name/label
                  const entityName = entity.properties.object?.getValue() || '';
                  const searchValue = payload.filterValue.toLowerCase();
                  shouldShow = entityName.toLowerCase().includes(searchValue);
                  
                } else if (payload.filterType === 'parameter') {
                  // This would require reloading with different parameter
                }
                
                entity.show = shouldShow;
              });
              
              const visibleCount = window.sensorEntities.filter(e => e.show).length;            }
            
          } catch (error) {
            console.error('❌ Error handling sensors:', error);
          }
        };

        // ==================== Pollution Replay Handler ====================
        window.pollutionClouds = null;
        window.pollutionReplayTimer = null;

        function getColorForPollution(value, parameter) {
          const config = airQualityConfig[parameter] || airQualityConfig['PM10'];
          const thresholds = config.thresholds;
          const alphas = [0.5, 0.55, 0.6, 0.65, 0.7];
          const colors = [
            [0.0, 0.8, 0.0],   // green - good
            [1.0, 1.0, 0.0],   // yellow - moderate
            [1.0, 0.65, 0.0],  // orange - poor
            [1.0, 0.0, 0.0],   // red - very poor
            [0.55, 0.0, 0.0],  // dark red - hazardous
          ];
          for (let i = 0; i < thresholds.length; i++) {
            if (value <= thresholds[i]) {
              return new Cesium.Color(colors[i][0], colors[i][1], colors[i][2], alphas[i]);
            }
          }
          const last = colors.length - 1;
          return new Cesium.Color(colors[last][0], colors[last][1], colors[last][2], alphas[last]);
        }

        window.handlePollutionReplayMessage = async (payload, transport) => {
          const replayType = payload?.isPrediction ? 'prediction' : 'historical';
          if (!payload || !payload.action) {
            console.error('❌ Invalid pollutionReplay payload');
            return;
          }
          if (payload.userId != null && payload.userId !== window.currentUserId) return;

          try {
            if (payload.action === 'stop') {
              if (window.pollutionReplayTimer) {
                clearInterval(window.pollutionReplayTimer);
                window.pollutionReplayTimer = null;
              }
              if (window.pollutionClouds && window.viewer.scene.primitives.contains(window.pollutionClouds)) {
                window.viewer.scene.primitives.remove(window.pollutionClouds);
              }
              window.pollutionClouds = null;              return;
            }

            if (payload.action === 'start' && payload.gridPoints && payload.hours) {
              // Stop any existing replay
              if (window.pollutionReplayTimer) {
                clearInterval(window.pollutionReplayTimer);
                window.pollutionReplayTimer = null;
              }
              if (window.pollutionClouds && window.viewer.scene.primitives.contains(window.pollutionClouds)) {
                window.viewer.scene.primitives.remove(window.pollutionClouds);
              }

              // Create cloud collection at grid point positions
              const clouds = new Cesium.CloudCollection();
              const ground2cloud = 1800;
              const cloudSX = 5000, cloudSY = 5000;

              // Compute altitude range to scale cloudSZ dynamically
              const altitudes = payload.gridPoints.map(gp => gp.altitude || 0);
              const minAlt = Math.min(...altitudes);
              const maxAlt = Math.max(...altitudes);
              const altRange = maxAlt - minAlt || 1;
              const minCloudSZ = 400, maxCloudSZ = 1000;

              payload.gridPoints.forEach(gp => {
                const alt = gp.altitude || 0;
                const normalizedAlt = (alt - minAlt) / altRange;
                const cloudSZ = maxCloudSZ - normalizedAlt * (maxCloudSZ - minCloudSZ);

                clouds.add({
                  position: Cesium.Cartesian3.fromDegrees(
                    gp.longitude,
                    gp.latitude,
                    alt + ground2cloud
                  ),
                  scale: new Cesium.Cartesian3(cloudSX, cloudSY, cloudSZ),
                  maximumSize: new Cesium.Cartesian3(cloudSX, cloudSY, cloudSZ),
                  slice: 0.016,
                  color: new Cesium.Color(0.9, 0.9, 0.9, 0.3),
                });
              });

              window.viewer.scene.primitives.add(clouds);
              window.pollutionClouds = clouds;
              // Animate through hours
              const replayParameter = payload.parameter || 'PM10';
              const hoursData = payload.hours;
              const intervalMs = payload.intervalMs || 1000;
              let frameIndex = 0;

              function paintFrame() {
                if (frameIndex >= hoursData.length) {
                  clearInterval(window.pollutionReplayTimer);
                  window.pollutionReplayTimer = null;                  return;
                }

                const frame = hoursData[frameIndex];
                const values = frame.values;
                const numClouds = Math.min(values.length, clouds.length);

                for (let i = 0; i < numClouds; i++) {
                  clouds.get(i).color = getColorForPollution(values[i], replayParameter);
                }

                window.viewer.scene.requestRender();                frameIndex++;
              }

              // Paint first frame immediately, then start interval
              paintFrame();
              window.pollutionReplayTimer = setInterval(paintFrame, intervalMs);
              const label = payload.isPrediction ? `Prediction replay (${payload.model || 'unknown model'})` : 'Pollution replay';            }

          } catch (error) {
            console.error('❌ Error handling pollutionReplay:', error);
          }
        };

        // Air quality configuration matching 3D-city-model
        const airQualityConfig = {
          PM10: {
            thresholds: [25, 50, 75, 100],
            cesiumColors: [
              Cesium.Color.GREEN,
              Cesium.Color.YELLOW,
              Cesium.Color.ORANGE,
              Cesium.Color.RED,
              Cesium.Color.DARKRED
            ],
            unit: 'µg/m³',
            labels: ['Good', 'Moderate', 'Poor', 'Very Poor', 'Hazardous']
          },
          'PM2.5': {
            thresholds: [15, 30, 55, 110],
            cesiumColors: [
              Cesium.Color.GREEN,
              Cesium.Color.YELLOW,
              Cesium.Color.ORANGE,
              Cesium.Color.RED,
              Cesium.Color.DARKRED
            ],
            unit: 'µg/m³',
            labels: ['Good', 'Moderate', 'Poor', 'Very Poor', 'Hazardous']
          },
          PM1: {
            thresholds: [10, 20, 35, 50],
            cesiumColors: [
              Cesium.Color.GREEN,
              Cesium.Color.YELLOW,
              Cesium.Color.ORANGE,
              Cesium.Color.RED,
              Cesium.Color.DARKRED
            ],
            unit: 'µg/m³',
            labels: ['Good', 'Moderate', 'Poor', 'Very Poor', 'Hazardous']
          },
          CO: {
            thresholds: [1, 2, 4],
            cesiumColors: [
              Cesium.Color.GREEN,
              Cesium.Color.YELLOW,
              Cesium.Color.ORANGE,
              Cesium.Color.RED
            ],
            unit: 'mg/m³',
            labels: ['Good', 'Moderate', 'Poor', 'Very Poor']
          },
          CO2: {
            thresholds: [400, 1000, 2000],
            cesiumColors: [
              Cesium.Color.GREEN,
              Cesium.Color.YELLOW,
              Cesium.Color.ORANGE,
              Cesium.Color.RED
            ],
            unit: 'ppm',
            labels: ['Good', 'Moderate', 'Poor', 'Very Poor']
          },
          NO2: {
            thresholds: [50, 100, 200],
            cesiumColors: [
              Cesium.Color.GREEN,
              Cesium.Color.YELLOW,
              Cesium.Color.ORANGE,
              Cesium.Color.RED
            ],
            unit: 'µg/m³',
            labels: ['Good', 'Moderate', 'Poor', 'Very Poor']
          },
          O3: {
            thresholds: [60, 120, 180],
            cesiumColors: [
              Cesium.Color.GREEN,
              Cesium.Color.YELLOW,
              Cesium.Color.ORANGE,
              Cesium.Color.RED
            ],
            unit: 'µg/m³',
            labels: ['Good', 'Moderate', 'Poor', 'Very Poor']
          },
          SO2: {
            thresholds: [50, 100, 350],
            cesiumColors: [
              Cesium.Color.GREEN,
              Cesium.Color.YELLOW,
              Cesium.Color.ORANGE,
              Cesium.Color.RED
            ],
            unit: 'µg/m³',
            labels: ['Good', 'Moderate', 'Poor', 'Very Poor']
          },
          // Meteorological parameters
          T: {
            thresholds: [-10, 30, -15, 35],
            cesiumColors: [
              Cesium.Color.BLUE,
              Cesium.Color.ORANGE,
              Cesium.Color.RED
            ],
            unit: '°C',
            labels: ['Normal', 'Uncomfortable', 'Extreme'],
            isMeteo: true
          },
          RH: {
            thresholds: [30, 60, 20, 80],
            cesiumColors: [
              Cesium.Color.BLUE.withAlpha(0.3),
              Cesium.Color.ORANGE,
              Cesium.Color.RED
            ],
            unit: '%',
            labels: ['Comfortable', 'Uncomfortable', 'Extreme'],
            isMeteo: true
          },
          p: {
            thresholds: [980, 1020, 970, 1030],
            cesiumColors: [
              Cesium.Color.BLUE,
              Cesium.Color.ORANGE,
              Cesium.Color.RED
            ],
            unit: 'hPa',
            labels: ['Normal', 'Unusual', 'Extreme'],
            isMeteo: true
          },
          // Default configuration
          default: {
            thresholds: [25, 50, 75, 100],
            cesiumColors: [
              Cesium.Color.GREEN,
              Cesium.Color.YELLOW,
              Cesium.Color.ORANGE,
              Cesium.Color.RED,
              Cesium.Color.DARKRED
            ],
            unit: '',
            labels: ['Good', 'Moderate', 'Poor', 'Very Poor', 'Hazardous']
          }
        };

        // Helper function to get sensor color based on parameter and value (matching 3D-city-model)
        function getSensorColorFromValue(param, value) {
          if (value === null || value === undefined) {
            return Cesium.Color.GRAY; // No data
          }

          const config = airQualityConfig[param] || airQualityConfig.default;

          if (config.isMeteo) {
            // Special handling for meteorological parameters
            const [minGood, maxGood, minBad, maxBad] = config.thresholds;
            if (value >= minGood && value <= maxGood) return config.cesiumColors[0];
            if (value < minBad || value > maxBad) return config.cesiumColors[2];
            return config.cesiumColors[1];
          } else {
            // Standard air quality parameters
            for (let i = 0; i < config.thresholds.length; i++) {
              if (value <= config.thresholds[i]) return config.cesiumColors[i];
            }
            return config.cesiumColors[config.cesiumColors.length - 1];
          }
        }

        // Helper function to create sensor icon (matching 3D-city-model design)
        function createSensorPin(color, text) {
          const iconSize = 32;
          const labelHeight = 30;
          const canvas = document.createElement('canvas');

          canvas.width = iconSize;
          canvas.height = iconSize + labelHeight;

          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          // Draw text label at the top with outline and shadow
          const fontSize = 14;
          ctx.font = `bold ${fontSize}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';

          // Black outline
          ctx.strokeStyle = 'rgba(0,0,0,0.7)';
          ctx.lineWidth = 4;
          ctx.strokeText(text, iconSize / 2, labelHeight - 2);

          // White fill with shadow
          ctx.fillStyle = 'white';
          ctx.shadowColor = 'rgba(0,0,0,0.5)';
          ctx.shadowBlur = 2;
          ctx.shadowOffsetX = 1;
          ctx.shadowOffsetY = 1;
          ctx.fillText(text, iconSize / 2, labelHeight - 2);

          // Black stroke again for definition
          ctx.strokeStyle = 'black';
          ctx.lineWidth = 1.5;
          ctx.strokeText(text, iconSize / 2, labelHeight - 2);

          // Final white fill
          ctx.shadowColor = 'transparent';
          ctx.fillStyle = 'white';
          ctx.fillText(text, iconSize / 2, labelHeight - 2);

          // Draw pin shape
          ctx.beginPath();
          ctx.moveTo(16, labelHeight + 4);
          ctx.bezierCurveTo(24, labelHeight + 4, 28, labelHeight + 12, 16, labelHeight + 30);
          ctx.bezierCurveTo(4, labelHeight + 12, 8, labelHeight + 4, 16, labelHeight + 4);
          ctx.closePath();
          ctx.fillStyle = color.toCssColorString();
          ctx.fill();

          // Draw inner circle
          ctx.beginPath();
          ctx.arc(16, labelHeight + 12, 5, 0, 2 * Math.PI);
          ctx.fillStyle = 'white';
          ctx.fill();

          return canvas;
        }

        // Helper function to match quality level
        function matchesQualityLevel(value, param, qualityLevel) {
          if (value === null || value === undefined) return false;
          
          const config = airQualityConfig[param] || airQualityConfig.default;
          const level = qualityLevel.toLowerCase().replace(/\s+/g, '');
          
          if (config.isMeteo) {
            // Meteorological parameters use different logic
            const [minGood, maxGood, minBad, maxBad] = config.thresholds;
            if (level === 'normal' || level === 'good' || level === 'comfortable') {
              return value >= minGood && value <= maxGood;
            } else if (level === 'uncomfortable') {
              return (value > maxGood && value <= maxBad) || (value < minGood && value >= minBad);
            } else if (level === 'extreme') {
              return value > maxBad || value < minBad;
            }
          } else {
            // Standard air quality parameters
            const thresholds = config.thresholds;
            const labels = config.labels.map(l => l.toLowerCase().replace(/\s+/g, ''));
            const labelIndex = labels.indexOf(level);
            
            if (labelIndex !== -1) {
              if (labelIndex === 0) {
                return value <= thresholds[0];
              } else if (labelIndex === labels.length - 1) {
                return value > thresholds[thresholds.length - 1];
              } else {
                return value > thresholds[labelIndex - 1] && value <= thresholds[labelIndex];
              }
            }
          }
          
          return false;
        }

        // Helper function to match value filter
        function matchesValueFilter(value, filterValue) {
          if (value === null || value === undefined) return false;
          
          const match = filterValue.match(/^([><=]+)(.+)$/);
          if (!match) return false;
          
          const operator = match[1];
          const threshold = parseFloat(match[2]);
          
          if (operator === '>') return value > threshold;
          if (operator === '>=') return value >= threshold;
          if (operator === '<') return value < threshold;
          if (operator === '<=') return value <= threshold;
          if (operator === '==' || operator === '=') return value === threshold;
          
          return false;
        }
        
        // Set up direct MQTT WebSocket connection for conversationStream
        if (typeof mqtt !== 'undefined') {          
          // MQTT over WebSocket needs /mqtt path - always use WSS through reverse proxy
          const mqttUrl = `wss://${appConfig.SERVER_NAME}/mqtt`;          
          try {
            const mqttClient = mqtt.connect(mqttUrl, {
              clientId: `citybot-browser-${Math.random().toString(36).substr(2, 9)}`,
              username: appConfig.MQTT_USER,
              password: appConfig.MQTT_PASSWORD,
              clean: true,
              connectTimeout: 10000,
              reconnectPeriod: 2000,
              keepalive: 60,
              rejectUnauthorized: false
            });
            
            mqttClient.on('connect', (connack) => {              
              // Build per-user topic paths using the authenticated user's ID.
              // Each user receives their own dedicated event topics so that
              // commands from one user's LLM session never appear in another
              // user's browser.
              const uid = window.currentUserId;
              const userPrefix = uid != null ? `smartbot/user/${uid}` : 'smartbot';

              const llmPrefix = uid != null ? `llm/user/${uid}` : 'llm';

              const topics = [
                `${llmPrefix}/events/conversationStream`,
                `${llmPrefix}/events/sttProgress`,
                `${userPrefix}/events/mapView`,
                `${userPrefix}/events/entityAdded`,
                `${userPrefix}/events/tilesetChanged`,
                `${userPrefix}/events/visualizationStyleChanged`,
                `${userPrefix}/events/sensorsChanged`,
                `${userPrefix}/events/pollutionReplay`
              ];
              
              topics.forEach(topic => {
                mqttClient.subscribe(topic, (err) => {
                  if (err) {
                    console.error(`Failed to subscribe to MQTT topic ${topic}:`, err);
                  } else {                  }
                });
              });
              
              // Test connection by publishing a heartbeat
              mqttClient.publish('client/heartbeat', JSON.stringify({
                clientId: mqttClient.options.clientId,
                timestamp: new Date().toISOString(),
                userAgent: navigator.userAgent
              }), { qos: 0 }, (err) => {
                if (err) {
                  console.error('Failed to send heartbeat:', err);
                } else {                }
              });
            });
            
            mqttClient.on('message', (topic, message) => {
              try {
                const payload = JSON.parse(message.toString());
                
                if (topic.endsWith('/events/conversationStream')) {
                  handleConversationStreamMessage(payload, 'mqtt');
                } else if (topic.endsWith('/events/sttProgress')) {
                  handleSTTProgressMessage(payload, 'mqtt');
                } else if (topic.endsWith('/events/mapView')) {
                  handleMapViewMessage(payload, 'mqtt');
                } else if (topic.endsWith('/events/entityAdded')) {
                  handleEntityAddedMessage(payload, 'mqtt');
                } else if (topic.endsWith('/events/tilesetChanged')) {
                  handleTilesetChangedMessage(payload, 'mqtt');
                } else if (topic.endsWith('/events/visualizationStyleChanged')) {
                  handleVisualizationStyleMessage(payload, 'mqtt');
                } else if (topic.endsWith('/events/sensorsChanged')) {
                  handleSensorsChangedMessage(payload, 'mqtt');
                } else if (topic.endsWith('/events/pollutionReplay')) {
                  handlePollutionReplayMessage(payload, 'mqtt');
                }
                
              } catch (err) {
                console.error('Failed to process MQTT message:', err);
              }
            });
            
            mqttClient.on('error', (err) => {
              console.error('MQTT WebSocket connection error:', err);
              console.error('Error details:', {
                message: err.message,
                code: err.code,
                errno: err.errno,
                syscall: err.syscall
              });
            });
            
            mqttClient.on('disconnect', (packet) => {            });
            
            mqttClient.on('offline', () => {            });
            
            mqttClient.on('reconnect', () => {            });
            
            // Store client globally for cleanup
            window.mqttClient = mqttClient;
            
          } catch (error) {
            console.error('Failed to setup MQTT WebSocket connection:', error);
          }
        } else {        }        
      } catch (error) {
        console.error('Error setting up MQTT event handlers:', error);
      }
      
      // Set up building info panel close button
      document.getElementById('closeBuildingInfo').addEventListener('click', () => {
        document.getElementById('buildingInfoPanel').style.display = 'none';
        
        // Reset the building color when closing the panel
        if (window.selectedBuildingFeature) {
          window.selectedBuildingFeature.color = Cesium.Color.WHITE;
          window.selectedBuildingFeature = null;        }
        
        // Clear the selected building reference
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
          window.thing.writeProperty('selectedBuildingState', window.llmSelectedBuilding).then(() => {          }).catch(err => {
            console.error('❌ Failed to send building deselection:', err);
          });
        }
        
        window.selectedBuilding = null;
        window.selectedBuildingFeature = null;      });
    };
