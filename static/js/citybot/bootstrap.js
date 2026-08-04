import { authReady } from './auth.js';

window.addEventListener('load', async () => {
  try {
    await Promise.race([
      window.initCesium(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Cesium initialization timeout')), 30000)
      ),
    ]);

    if (!window.viewer) {
      throw new Error('Cesium viewer was not initialized properly');
    }

    // WoT/MQTT require per-user topics — wait until auth check sets currentUserId
    await authReady;

    await Promise.race([
      window.initWoT(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('WoT initialization timeout')), 45000)
      ),
    ]);
  } catch (err) {
    console.error('Initialization error:', err);

    const errorMessage = err.message || 'Unknown error';
    if (typeof window.addMessage === 'function') {
      if (errorMessage.includes('timeout')) {
        window.addMessage(
          'Connection timeout — please check your internet connection and try refreshing the page',
          false,
          true
        );
      } else if (errorMessage.includes('Cesium')) {
        window.addMessage(
          '3D map initialization failed — some features may not work properly',
          false,
          true
        );
      } else if (errorMessage.includes('WoT')) {
        window.addMessage(
          'Service connection failed — please try refreshing the page',
          false,
          true
        );
      } else {
        window.addMessage('Initialization error: ' + errorMessage, false, true);
      }
    }
  }
});
