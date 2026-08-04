window.lastCameraState = null;
    window.thing = null; // Will be set after WoT connection
    window.llmThing = null; // Will be set after LLM WoT connection
    window.isOwnCameraUpdate = false; // Flag to prevent self-updates
    window.lastOwnUpdateTime = 0;
    window.queue = [];
    window.flying = false;
    window.programmaticMove = false;
    // Streaming state for LLM conversation
    window.activeStreamRequestId = null;
    window.streamMessageContentEl = null;
    // STT request tracking
    window.pendingSTTRequests = {};
    window.transcribeAudioCallCount = 0;
    // TTS handling for streaming
    window.shouldDoTTSAfterStream = false;
    // MQTT debugging
    window.conversationStreamStats = null;
    // Visualization style tracking
    window.pendingVisualizationStyle = null;
    window.sofiaTileset = null; // Will store the Sofia tileset reference
    // Building interaction
    window.selectedBuilding = null;
    window.selectedBuildingFeature = null; // Store the actual Cesium feature for highlighting
    window.llmSelectedBuilding = null;

    function withUserId(payload) {
      if (window.currentUserId != null) {
        payload.userId = window.currentUserId;
      }
      return payload;
    }

    function getLlmContextPayload() {
      return {
        selectedBuilding: window.llmSelectedBuilding,
        mapState: window.lastCameraState
      };
    }

    function requireLoggedInUserId() {
      if (window.currentUserId == null) {
        throw new Error('Not logged in — missing userId. Please refresh and log in again.');
      }
      return window.currentUserId;
    }

    window.withUserId = withUserId;
    window.getLlmContextPayload = getLlmContextPayload;
    window.requireLoggedInUserId = requireLoggedInUserId;
    
    // Function to apply visualization styles from server-provided definition
    window.applyVisualizationStyle = function(styleDefinition, styleName) {      
      if (!window.sofiaTileset) {
        console.error('❌ Sofia tileset not loaded yet');
        return;
      }
      
      if (!styleDefinition) {
        console.error('❌ No style definition provided');
        return;
      }
      
      try {
        // Create Cesium 3D tile style from server-provided definition
        const cesiumStyle = new Cesium.Cesium3DTileStyle(styleDefinition);
        window.sofiaTileset.style = cesiumStyle;
      } catch (error) {
        console.error(`❌ Failed to apply style ${styleName}:`, error);
        console.error(`❌ Error details:`, {
          message: error.message,
          stack: error.stack,
          styleDefinition: styleDefinition
        });
      }
    };
    
    // Define emitCameraState function to use WoT property instead of MQTT
    window.emitCameraState = async () => {      // Don't emit if thing is not yet connected
      if (!window.thing) {        return;
      }
      
      const position = window.viewer.camera.positionCartographic;
      const currentState = {
        latitude: Cesium.Math.toDegrees(position.latitude),
        longitude: Cesium.Math.toDegrees(position.longitude),
        height: position.height,
        heading: Cesium.Math.toDegrees(window.viewer.camera.heading),
        pitch: Cesium.Math.toDegrees(window.viewer.camera.pitch),
        roll: Cesium.Math.toDegrees(window.viewer.camera.roll),
        timestamp: new Date().toISOString()
      };

      // Only emit if camera state has changed significantly
      if (!window.lastCameraState 
          || 
          Math.abs(currentState.latitude - window.lastCameraState.latitude) > 0.001 ||
          Math.abs(currentState.longitude - window.lastCameraState.longitude) > 0.001 ||
          Math.abs(currentState.height - window.lastCameraState.height) > 100
        ) {
        
        try {
          // Set flag to prevent processing our own camera update
          window.isOwnCameraUpdate = true;
          window.lastOwnUpdateTime = Date.now();
          
          // Use WoT property write instead of MQTT
          await window.thing.writeProperty('cameraState', withUserId({
            coordinates: {
              latitude: currentState.latitude,
              longitude: currentState.longitude,
              height: currentState.height
            },
            camera: {
              heading: currentState.heading,
              pitch: currentState.pitch,
              roll: currentState.roll
            },
            time: currentState.timestamp
          }));          window.lastCameraState = currentState;
          
          // Reset flag after a longer delay to allow the event to be processed
          setTimeout(() => {
            window.isOwnCameraUpdate = false;
          }, 300);
        } catch (error) {
          console.error('❌ Failed to update camera state:', error);
          window.isOwnCameraUpdate = false;
        }
      }
    };

    // Subscribe to WoT events instead of using MQTT
