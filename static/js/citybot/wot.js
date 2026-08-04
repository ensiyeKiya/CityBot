import { appConfig } from './config.js';

/* ========================= 4. WoT Thing ========================= */
    async function connectThing () {
      try {        const servient = new window.WoT.Core.Servient();
        servient.addCredentials({
          "urn:dev:wot:com:citymodel": {
            username: appConfig.WOT_USERNAME,
            password: appConfig.WOT_PASSWORD
          }
        });
        servient.addClientFactory(new window.WoT.Http.HttpClientFactory());
        servient.addClientFactory(new window.WoT.Http.HttpsClientFactory({ allowSelfSigned: true }));
        
        const wot = await Promise.race([
          servient.start(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('WoT servient start timeout')), 10000))
        ]);
        
        // Use the per-user Thing Description so event MQTT topics are scoped
        // to the authenticated user. Properties still point at the citymodel Thing.
        const userId = window.currentUserId;
        const citymodelUrl = userId != null
          ? `https://${appConfig.SERVER_NAME}/api/wot/td/${userId}`
          : `https://${appConfig.SERVER_NAME}/citymodel`;        
        const td = await Promise.race([
          wot.requestThingDescription(citymodelUrl),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Thing description request timeout')), 15000))
        ]);
        
        const thing = await Promise.race([
          wot.consume(td),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Thing consumption timeout')), 10000))
        ]);        return thing;
      } catch (error) {
        console.error('❌ Failed to connect to WoT Thing:', error);
        throw error;
      }
    }

    async function connectLLMThing () {
      try {        const servient = new window.WoT.Core.Servient();
        
        // Add credentials for LLM service - same as main smartbot
        servient.addCredentials({
          "urn:dev:wot:com:smartbot:llm": {
            username: appConfig.WOT_USERNAME,
            password: appConfig.WOT_PASSWORD
          }
        });
        
        // Add HTTP client factories
        servient.addClientFactory(new window.WoT.Http.HttpClientFactory({
          allowSelfSigned: true,
          rejectUnauthorized: false
        }));
        servient.addClientFactory(new window.WoT.Http.HttpsClientFactory({ 
          allowSelfSigned: true,
          rejectUnauthorized: false
        }));
        
        const wot = await Promise.race([
          servient.start(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('LLM WoT servient start timeout')), 10000))
        ]);
        
        // Use dynamic configuration for the URL
        const llmUrl = `https://${appConfig.SERVER_NAME}/llm`; // No port - handled by reverse proxy        
        const td = await Promise.race([
          wot.requestThingDescription(llmUrl),
          new Promise((_, reject) => setTimeout(() => reject(new Error('LLM Thing description request timeout')), 15000))
        ]);
        
        const llmThing = await Promise.race([
          wot.consume(td),
          new Promise((_, reject) => setTimeout(() => reject(new Error('LLM Thing consumption timeout')), 10000))
        ]);        return llmThing;
      } catch (error) {
        console.error('❌ Failed to connect to LLM Thing:', error);
        throw error;
      }
    }

    // Initialize WoT connections when the page loads
    window.initWoT = async function() {
      try {
        // Connect to Thing
        window.thing = await connectThing();        
        window.llmThing = await connectLLMThing();        
        // Subscribe to WoT events
        const subscriptions = await window.subscribeToWoTEvents();
    
    // Now that thing is connected, set up camera listener
        window.viewer.camera.changed.addEventListener(window.emitCameraState);
      } catch (err) {
        console.error('WoT connection error:', err);
        window.addMessage('❌ Connection error: ' + (err && err.message ? err.message : err), false, true);
      }
    }
