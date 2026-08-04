/* =================== 5. Programmatic move =================== */
    let programmaticMove = false;
    let queue            = [];
    let flying           = false;
    let isOwnCameraUpdate = false; // keep preventing self-updates if you also publish via MQTT later
    let lastOwnUpdateTime = 0;
    
    // Initialize these variables at the global scope to avoid reference errors
    window.programmaticMove = programmaticMove;
    window.queue = queue;
    window.flying = flying;
    window.isOwnCameraUpdate = isOwnCameraUpdate;
    window.lastOwnUpdateTime = lastOwnUpdateTime;

    async function nextFly () {
      if (window.flying || !window.queue.length) return;
      window.flying = true;
      flying = true; // Update both local and window variables
      const data = window.queue.shift();
      try {
        programmaticMove = true;
        window.programmaticMove = true;
        const lon  = data.coordinates?.longitude ?? data.camera?.longitude ?? 0;
        const lat  = data.coordinates?.latitude  ?? data.camera?.latitude  ?? 0;
        const hgtRaw = data.coordinates?.height ?? data.camera?.height;
        const hgt    = (typeof hgtRaw === 'number' ? hgtRaw : 100000);
        const dest = Cesium.Cartesian3.fromDegrees(lon, lat, hgt);

        const head = Cesium.Math.toRadians(data.camera?.heading ?? 0);
        const pit  = Cesium.Math.toRadians(data.camera?.pitch   ?? -90);
        const rol  = Cesium.Math.toRadians(data.camera?.roll    ?? 0);

        if (!window.tilesAreLoaded && !window.viewer.scene.globe.tilesLoaded) {
          await new Promise((resolve) => {
            const onLoad = (n) => {
              if (n === 0) {
                window.viewer.scene.globe.tileLoadProgressEvent.removeEventListener(onLoad);
                resolve();
              }
            };
            window.viewer.scene.globe.tileLoadProgressEvent.addEventListener(onLoad);
            setTimeout(resolve, 3000);
          });
        }

        await new Promise((resolve) => setTimeout(resolve, 100));        await new Promise((resolve) => {
          window.viewer.camera.flyTo({
            destination: dest,
            orientation: { heading: head, pitch: pit, roll: rol },
            duration: 3,
            complete () {              programmaticMove = false;
              window.programmaticMove = false;
              resolve();
            }
          });
        });
      } catch (err) {
        console.error('❌ nextFly error:', err);
      } finally {
        flying = false;
        window.flying = false;
        nextFly();
      }
    }   

    /* ========================= 6. Make nextFly globally available =========================== */
    window.nextFly = nextFly;
