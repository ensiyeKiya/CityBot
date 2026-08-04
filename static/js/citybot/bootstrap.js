// Initialize everything when the page loads
    window.addEventListener('load', async () => {      
      try {
        // First initialize Cesium with timeout
        await Promise.race([
          window.initCesium(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Cesium initialization timeout')), 30000))
        ]);
        // Make sure viewer is defined before proceeding
        if (!window.viewer) {
          throw new Error('Cesium viewer was not initialized properly');
        }
        
        // Then initialize WoT connections with timeout
        await Promise.race([
          window.initWoT(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('WoT initialization timeout')), 45000))
        ]);
      } catch (err) {
        console.error('❌ Initialization error:', err);
        
        // Show user-friendly error message
        const errorMessage = err.message || 'Unknown error';
        if (errorMessage.includes('timeout')) {
          window.addMessage('⚠️ Connection timeout - please check your internet connection and try refreshing the page', false, true);
        } else if (errorMessage.includes('Cesium')) {
          window.addMessage('⚠️ 3D map initialization failed - some features may not work properly', false, true);
        } else if (errorMessage.includes('WoT')) {
          window.addMessage('⚠️ Service connection failed - please try refreshing the page', false, true);
        } else {
          window.addMessage('❌ Initialization error: ' + errorMessage, false, true);
        }
        
        // Try to continue with basic functionality even if initialization fails
      }
    });
