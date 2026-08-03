export async function configureCesium(Cesium) {
  Cesium.Ion.defaultAccessToken =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI1OTdkNmE4OS0yZTVmLTQ1OTUtODNhNi1hOTVjMjAyMTU2ODUiLCJpZCI6MzI3NDAsInNjb3BlcyI6WyJhc3IiLCJnYyJdLCJpYXQiOjE1OTc0MDQwNTB9.FrhV7MfxnIPM1ikW8-Z4VaGJzKxwvZk_Y-Nb7HwOWa0";

  const terrainResource = await Cesium.IonResource.fromAssetId(2564867, {
    accessToken:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJjNWUzZmI0ZS02NDcxLTRlNjktYTcyYi00OWZlNTA4ZmViMTAiLCJpZCI6NDY4MjksImlhdCI6MTYxNjYwMTM4Nn0.3KOIXUjF4QpChsVKmW9pNy5WdE6qi3C61jBJc9VJGIQ",
  });

  const terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(
    terrainResource,
    {
      requestVertexNormals: true,
    }
  );

  const viewer = new Cesium.Viewer("cesiumContainer", {
    terrainProvider: terrainProvider,
    shouldAnimate: false,
    baseLayerPicker: false,
    timeline: true,
    animation: false,
    useBrowserRecommendedResolution: false
  });

  viewer.scene.globe.depthTestAgainstTerrain = true;

  if (viewer.infoBox) {
    viewer.infoBox.container.style.display = "none";
  }

  const now = new Date();
  const twoMonthsAgo = new Date();
  twoMonthsAgo.setMonth(now.getMonth() - 10);

  // convert to cesium julianDate
  const startTime = Cesium.JulianDate.fromDate(twoMonthsAgo);
  const stopTime = Cesium.JulianDate.fromDate(now);
  const currentTime = Cesium.JulianDate.fromDate(now);

  viewer.clock.startTime = startTime;
  viewer.clock.stopTime = stopTime;
  viewer.clock.currentTime = currentTime;

  viewer.clock.clockRange = Cesium.ClockRange.CLAMPED;

  return viewer;
}
