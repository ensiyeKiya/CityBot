import { configureCesium } from "./cesiumConfig.js";
import { loadAirQualitySensors, updateSensorParams, updateLegend, drawParamChart, updateAirQualityValues} from "./sensorManager.js";
import { createStyles, getLegendElements, setupShadowToggle, set3DTileStyle, getSelectedTileStyle} from "./stylesManager.js";
import { updateFeatureInfoBox } from "./infoBox.js";
async function startup(Cesium) {
  "use strict";

  const viewer = await configureCesium(Cesium);

  // Stores all sensor entities
  const sensorEntities = [];
 
  
  /////////////////////////// 3D Tiles  ////////////////////////
  const tilesetSofia = await Cesium.Cesium3DTileset.fromUrl(
    "https://raw.githubusercontent.com/eshirinyan/three_sample/refs/heads/main/sofia_building_tiles_20250821/tileset.json",
    {
      dynamicScreenSpaceError: false, 
    maximumScreenSpaceError: 1      
    }
  );
  viewer.scene.primitives.add(tilesetSofia);
  viewer.flyTo(tilesetSofia);

  //  const tilesetSofia = await Cesium.Cesium3DTileset.fromIonAssetId(
  //     1995995,
  //     {
  //       dynamicScreenSpaceError: true,
  //       dynamicScreenSpaceErrorDensity: 0.00278,
  //        dynamicScreenSpaceErrorFactor: 4.0,
  //       dynamicScreenSpaceErrorHeightFalloff: 0.25,
  //     }
  //    );

  //         viewer.scene.primitives.add(tilesetSofia);
  //         viewer.flyTo(tilesetSofia);

  //   viewer.flyTo(tileset, {
  //   duration: 2.0,
  //   offset: new Cesium.HeadingPitchRange(0, -30, 1000)  // ъгъл на камерата
  // });

  // const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(1986152, {
  //   maximumScreenSpaceError: 2,
  //   preferLeaves: true,
  // });
  // viewer.scene.primitives.add(tileset);
  // viewer.flyTo(tileset);

  // // appling default style if available
  // const extras = tileset.asset.extras;
  // if (
  //   Cesium.defined(extras) &&
  //   Cesium.defined(extras.ion) &&
  //   Cesium.defined(extras.ion.defaultStyle)
  // ) {
  //   tileset.style = new Cesium.Cesium3DTileStyle(extras.ion.defaultStyle);
  // }

  /////////////////////////// Feature Picking /////////////////////////
  const featureInfo = document.getElementById("featureInfo");
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

  const nameOverlay = document.createElement("div");
  viewer.container.appendChild(nameOverlay);
  nameOverlay.className = "backdrop";
  nameOverlay.style.display = "none";
  nameOverlay.style.position = "absolute";
  nameOverlay.style.bottom = "0";
  nameOverlay.style.left = "0";
  nameOverlay.style["pointer-events"] = "none";
  nameOverlay.style.padding = "4px";
  nameOverlay.style.backgroundColor = "black";

  const selected = {
    feature: undefined,
    originalColor: new Cesium.Color(),
  };

  // checking for silhouette support
  if (Cesium.PostProcessStageLibrary.isSilhouetteSupported(viewer.scene)) {
    const silhouetteBlue =
      Cesium.PostProcessStageLibrary.createEdgeDetectionStage();
    silhouetteBlue.uniforms.color = Cesium.Color.MEDIUMSLATEBLUE.withAlpha(0.7);
    silhouetteBlue.uniforms.length = 0.01;
    silhouetteBlue.selected = [];

    const silhouetteGreen =
      Cesium.PostProcessStageLibrary.createEdgeDetectionStage();
    silhouetteGreen.uniforms.color = Cesium.Color.LIME.withAlpha(0.8);
    silhouetteGreen.uniforms.length = 0.02;
    silhouetteGreen.selected = [];

    viewer.scene.postProcessStages.add(
      Cesium.PostProcessStageLibrary.createSilhouetteStage([
        silhouetteBlue,
        silhouetteGreen,
      ])
    );

    // the clickHandler is changed with more modern syntax approach
    handler.setInputAction((movement) => {
      silhouetteBlue.selected = [];
      const picked = viewer.scene.pick(movement.endPosition);

      if (!Cesium.defined(picked)) {
        nameOverlay.style.display = "none";
        return;
      }

      // if sensor is checked(entity with billboard)
      if (picked.id && picked.id.billboard) {
        nameOverlay.style.display = "block";
        nameOverlay.style.bottom = `${viewer.canvas.clientHeight - movement.endPosition.y}px`;
        nameOverlay.style.left = `${movement.endPosition.x}px`;
        nameOverlay.textContent = picked.id.name || "Air Quality Sensor";
        return;
      }

      if (picked instanceof Cesium.Cesium3DTileFeature) {
        nameOverlay.style.display = "block";
        nameOverlay.style.bottom = `${viewer.canvas.clientHeight - movement.endPosition.y}px`;
        nameOverlay.style.left = `${movement.endPosition.x}px`;
        nameOverlay.textContent =
          picked.getProperty("citygml_class_description") ||
          picked.getProperty("name") ||
          "Unnamed feature";

        if (picked !== selected.feature) {
          silhouetteBlue.selected = [picked];
        }
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction((movement) => {
      silhouetteGreen.selected = [];
      const picked = viewer.scene.pick(movement.position);

      if (!Cesium.defined(picked)) {
        featureInfo.style.display = "none";
        return;
      }

      if (silhouetteGreen.selected[0] === picked) return;
      silhouetteGreen.selected = [picked];
      selected.feature = picked;
      const selectedStyle = getSelectedTileStyle();
      updateFeatureInfoBox(picked, selectedStyle, viewer.clock.currentTime);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  } else {
    // Fallback
    const highlighted = {
      feature: undefined,
      originalColor: new Cesium.Color(),
    };
    handler.setInputAction((movement) => {
      if (Cesium.defined(highlighted.feature)) {
        highlighted.feature.color = highlighted.originalColor;
        highlighted.feature = undefined;
      }

      const pickedObject = viewer.scene.pick(movement.endPosition);
      if (!Cesium.defined(pickedObject)) {
        nameOverlay.style.display = "none";

        return;
      }

      // Check if it's a sensor (entity with billboard)
      if (pickedObject.id && pickedObject.id.billboard) {
        nameOverlay.style.display = "block";
        nameOverlay.style.bottom = `${viewer.canvas.clientHeight - movement.endPosition.y}px`;
        nameOverlay.style.left = `${movement.endPosition.x}px`;
        nameOverlay.textContent = pickedObject.id.name || "Air Quality Sensor";
        return;
      }
      // Otherwise treat as a building/feature
      if (pickedObject.primitive instanceof Cesium.Cesium3DTileFeature) {
        highlighted.originalColor = pickedObject.color.clone();
        pickedObject.color = Cesium.Color.YELLOW;
        highlighted.feature = pickedObject;

        nameOverlay.style.display = "block";
        nameOverlay.style.bottom = `${viewer.canvas.clientHeight - movement.endPosition.y}px`;
        nameOverlay.style.left = `${movement.endPosition.x}px`;
        nameOverlay.textContent =
          pickedObject.getProperty("name") ||
          pickedObject.getProperty("cad_id") ||
          pickedObject.getProperty("citygml_class_description") ||
          "Unnamed feature";
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction((movement) => {
      if (Cesium.defined(selected.feature)) {
        selected.feature.color = selected.originalColor;
      }

      const pickedObject = viewer.scene.pick(movement.position);
      if (!Cesium.defined(pickedObject)) {
        featureInfo.style.display = "none";
        return;
      }
      if (pickedObject.primitive instanceof Cesium.Cesium3DTileFeature) {
        selected.originalColor = pickedObject.color.clone();
        pickedObject.color = Cesium.Color.LIME;
        selected.feature = pickedObject;
        updateFeatureInfoBox(
          pickedObject,
          tileStyle?.options?.[tileStyle.selectedIndex]?.value, 
          viewer.clock.currentTime
        );
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }
  /////////////////////////// 3D Tiles Styles /////////////////////////
  const tileStyle = document.getElementById("tileStyle");
  const styles = createStyles(Cesium);
  const legendElements = getLegendElements();
  setupShadowToggle(viewer);

const clock = viewer.clock;          

  const operator = document.getElementById("sensorOperator");
  const param = document.getElementById("sensorParams");
  const dateInput = document.getElementById("sensorDate");
  const timeInput = document.getElementById("sensorTime");
  await loadAirQualitySensors(viewer, operator.value, sensorEntities, param.value ,viewer.clock.currentTime);

  
viewer.timeline.addEventListener("settime", function () {
  const currentTime = Cesium.JulianDate.toDate(viewer.clock.currentTime);

  // Converting to the right format for input[type=date] и input[type=time]
  // const year = currentTime.getFullYear();
  // const month = String(currentTime.getMonth() + 1).padStart(2, "0");
  // const day = String(currentTime.getDate()).padStart(2, "0");
  const hours = String(currentTime.getHours()).padStart(2, "0");
  const minutes = String(currentTime.getMinutes()).padStart(2, "0");

//  dateInput.value = `${year}-${month}-${day}`;
  timeInput.value = `${hours}:${minutes}`;
});


  operator.addEventListener("change", function (e) {
      const selectedOperator = e.target.value;
      updateSensorParams();

      loadAirQualitySensors( viewer, selectedOperator, sensorEntities, param.value, viewer.clock.currentTime);
        updateLegend(param.value); 

    });
    
  param.addEventListener("change", function() {
  const selectedParam = this.value;
  updateLegend(selectedParam); 
  loadAirQualitySensors(viewer, operator.value, sensorEntities, selectedParam, viewer.clock.currentTime, true);
});


function updateClockFromInputs () {
  const dateValue = dateInput.value;
  const timeValue = timeInput.value;

  if (!dateValue || !timeValue) return;

  const [year, month, day] = dateValue.split("-").map(Number);
  const [hour, minute] = timeValue.split(":").map(Number);

  const newTime = Cesium.JulianDate.fromDate(
    new Date(year, month - 1, day, hour, minute)
  );

  // Задаваме избрания ден като начало и край
  const startOfDay = Cesium.JulianDate.fromDate(new Date(year, month - 1, day, 0, 0, 0));
  const endOfDay = Cesium.JulianDate.fromDate(new Date(year, month - 1, day, 23, 59, 59));

  // Настройка на часовника
  clock.startTime = startOfDay.clone();
  clock.stopTime = endOfDay.clone();
  clock.currentTime = newTime;
  clock.clockRange = Cesium.ClockRange.CLAMPED; // спира при крайното време
  clock.multiplier = 60; // скорост (примерно 1 минута в секунда)

  if (viewer.timeline) {
    viewer.timeline.zoomTo(startOfDay, endOfDay);
  }
  loadAirQualitySensors(
    viewer,
    operator.value,
    sensorEntities,
    param.value,
    viewer.clock.currentTime
  );
}

dateInput.addEventListener("change", updateClockFromInputs);
timeInput.addEventListener("change", updateClockFromInputs);


document.getElementById("modeSelector").addEventListener("change", function() {
  const valueType = this.value; // "max", "min" или "avg"
  updateAirQualityValues(sensorEntities, param.value, valueType);
});

 const now = new Date();
dateInput.value = now.toLocaleDateString('sv-SE');
timeInput.value = now.toLocaleTimeString('sv-SE', { 
  hour: '2-digit', 
  minute: '2-digit',
  hour12: false 
}).slice(0, 5);


updateClockFromInputs();

document.getElementById("showChartBtn").addEventListener("click", () => {
  drawParamChart( operator.value, param.value, viewer.clock.currentTime, "paramChart");
});

let chartCounter = 1;

document.getElementById("closeChartAllStationsBtn").addEventListener("click", () => {
  const modal = document.getElementById("chartAllStations");
  const container = document.getElementById("chartsContainer");

  modal.style.display = "none";

  container.innerHTML = '<canvas id="paramChart" style="flex:1; height:400px;"></canvas>';

  
  chartCounter = 1;
});

document.getElementById("addChartBtn").addEventListener("click", () => {
  chartCounter++;
  const newOperator = document.getElementById("compareOperatorSelect").value;

  const newCanvas = document.createElement("canvas");
  newCanvas.id = `paramChart${chartCounter}`;
  newCanvas.style.flex = "1";
  newCanvas.style.minWidth = "400px";
  newCanvas.style.height = "400px";

  document.getElementById("chartsContainer").appendChild(newCanvas);

  drawParamChart(newOperator, param.value, viewer.clock.currentTime, newCanvas.id);
});


const chartModal = document.getElementById("chartAllStations");
const resizeBtn = document.getElementById("resizeChartBtn");

resizeBtn.addEventListener("click", () => {
  if (chartModal.classList.contains("minimized")) {
    chartModal.classList.remove("minimized");
    chartModal.classList.add("fullscreen");
    resizeBtn.textContent = "⤡"; 
  } else {
    chartModal.classList.remove("fullscreen");
    chartModal.classList.add("minimized");
    resizeBtn.textContent = "⤢"; 
  }

  chartModal.querySelectorAll("canvas").forEach((canvas) => {
    if (canvas._chart) {
      const isMinimized = chartModal.classList.contains("minimized");
      canvas._chart.options.plugins.legend.display = !isMinimized; 
      canvas._chart.update(); 
    }
  });
});

  // Sensor controls
  document
    .getElementById("sensorScale")
    .addEventListener("input", function (e) {
      const scale = parseFloat(e.target.value);
      sensorEntities.forEach((entity) => {
        if (entity.billboard) {
          entity.billboard.scale = scale;
          entity.billboard.scaleByDistance = new Cesium.NearFarScalar(
            100,
            scale,
            10000,
            scale * 0.3
          );
        }
      });
    });

  document
    .getElementById("showSensors")
    .addEventListener("change", function (e) {
      const show = e.target.checked;
      sensorEntities.forEach((entity) => {
        entity.show = show;
      });

      const airQualityLegend = document.getElementById("legend-airQuality");
      if (airQualityLegend) {
        airQualityLegend.style.display = show ? "block" : "none";
      }
    });


  //main logic for the toggle styles(imitation of radio buttons)
  const styleToggles = document.querySelectorAll(".tile-style-toggle");

  styleToggles.forEach((toggle) => {
    toggle.addEventListener("change", (e) => {
      if (e.target.checked) {
        styleToggles.forEach((t) => {
          if (t !== e.target) t.checked = false;
        });
        const selectedStyle = e.target.value;
        set3DTileStyle(
          selectedStyle,
          legendElements,
          tilesetSofia,
          styles,
          viewer
        );
        featureInfo.style.display = "none";
      } else {
        set3DTileStyle(
          "none",
          legendElements,
          tilesetSofia,
          styles,
          viewer
        );
        styleToggles.forEach((t) => (t.checked = false));
        document.getElementById("style-none").checked = true;
      }
    });
  });
  document.getElementById("shadows").addEventListener("change", function () {
    viewer.shadows = this.checked;
  });


const infoToolbar = document.getElementById("infoToolbar");

const layerInfo = {
  "uhi4": {
    title: "Urban Heat Island 22.0.2018 16:00 pm",
    description: "Represents the urban heat island effect at 4 pm, showing variations of air temperature at 2m height in the city.",
    link: "https://www.sciencedirect.com/science/article/pii/S2212095525002469"
  },
  "uhi9": {
    title: "Urban Heat Island 22.0.2018 21:00 pm",
    description: "Represents the urban heat island effect at 9 pm, with detailed visualization of heat distribution.",
    link: "https://www.sciencedirect.com/science/article/pii/S2212095525002469"
  },
  "walkability": {
    title: "Walkability",
    description: "Shows pedestrian accessibility and walkability levels across the urban environment.",
    link: "https://www.sciencedirect.com/science/article/pii/S026427512500472X"
  },
  "height": {
    title: "Building Height",
    description: "Displays buildings colored according to their height within the 3D city model."
  },
  "energyltb": {
    title: "Building Energy Consumption: upper tolerance interval values",
    description: "Visualizes building yearly energy consumption. Based EPC data and on tolerance intervals (TI) for the energy consumption (kWh m2 yearly) of the 10 classes of buildings.",
    link: "https://isprs-archives.copernicus.org/articles/XLVIII-1-W2-2023/123/2023/"
  },
  "energyutb": {
    title: "Building Energy Consumption: upper tolerance interval values",
    description: "Visualizes building yearly energy consumption. Based EPC data and on tolerance intervals (TI) for the energy consumption (kWh m2 yearly) of the 10 classes of buildings.",
    link: "https://isprs-archives.copernicus.org/articles/XLVIII-1-W2-2023/123/2023/"
  },
  "class": {
    title: "Building Class",
    description: "Highlights different building categories or classes using cadastral values"
  },
};


styleToggles.forEach((toggle) => {
  toggle.addEventListener("change", (e) => {
    if (e.target.checked) {
      styleToggles.forEach((t) => {
        if (t !== e.target) t.checked = false;
      });
      const selectedStyle = e.target.value;
      set3DTileStyle(
        selectedStyle,
        legendElements,
        tilesetSofia,
        styles,
        viewer
      );
      
      showLayerInfo(selectedStyle);
    } else {
      set3DTileStyle(
        "none",
        legendElements,
        tilesetSofia,
        styles,
        viewer
      );
      styleToggles.forEach((t) => (t.checked = false));
      document.getElementById("style-none").checked = true;
      infoToolbar.style.display = "none";
    }
  });
});

function showLayerInfo(layerName) {
  if(layerName === "none") {
      infoToolbar.style.display = "none";
      return;
  }
  const info = layerInfo[layerName] || layerInfo["default"];
  
  infoToolbar.innerHTML = `
    <span style="font-weight:600;">${info.title}:</span> 
    ${info.description} 
   ${info.link ? `<a href="${info.link}" target="_blank" style="color:#c3bff4; text-decoration:underline;">Read more</a>` : ""}
  `;
  
  infoToolbar.style.display = "block";
}


  document.getElementById("style-none").checked = true;
  set3DTileStyle("none", legendElements, tilesetSofia, styles, viewer);
}

if (typeof Cesium !== "undefined") {
  window.startupCalled = true;
  startup(Cesium);
  document.getElementById("loadingOverlay").style.display = "none";
}
