export const API_URL = "https://citylab.gate-ai.eu/3d-city-model";

export const paramMap = {
  PM10: "Particulate matter 10",
  T: "Temperature",
  p: "Pressure",
  RH: "Relative humidity",
  WD: "Wind direction",
  WS: "Wind speed",
  R: "Rainfall",
  SI: "Solar irradiation",
  CO: "Carbon monoxide",
  CO2: "Carbon dioxide",
  NO: "Nitrogen monoxide",
  NO2: "Nitrogen dioxide",
  SO2: "Sulphur dioxide",
  O3: "Ozone",
  C6H6: "Benzene",
  PM1: "Particulate matter 1",
  "PM2.5": "Particulate matter 2.5",
};

export const operatorParams = {
  "Sofia municipality": [
    "PM10",
    "T",
    "p",
    "RH",
    "CO",
    "NO2",
    "SO2",
    "O3",
    "PM2.5",
  ],

  "Executive environmental agency (ExEA)": [
    "PM10",
    "T",
    "RH",
    "WD",
    "WS",
    "SI",
    "CO",
    "NO",
    "NO2",
    "SO2",
    "C6H6",
  ],
  "GATE Institute": [
    "PM10",
    "T",
    "p",
    "RH",
    "WD",
    "WS",
    "R",
    "CO2",
    "NO2",
    "SO2",
    "O3",
    "PM1",
    "PM2.5",
  ],
};
// Shared configuration for all parameters
const airQualityConfig = {
  // Particulate Matter
  PM10: {
    thresholds: [25, 50, 75, 100],
    colors: ["#4CAF50", "#FFEB3B", "#FF9800", "#F44336", "#8B0000"],
    cesiumColors: [
      Cesium.Color.GREEN,
      Cesium.Color.YELLOW,
      Cesium.Color.ORANGE,
      Cesium.Color.RED,
      Cesium.Color.DARKRED,
    ],
    unit: "µg/m³",
    labels: ["Good", "Moderate", "Poor", "Very Poor", "Hazardous"],
  },
  "PM2.5": {
    thresholds: [15, 30, 55, 110],
    colors: ["#4CAF50", "#FFEB3B", "#FF9800", "#F44336", "#8B0000"],
    cesiumColors: [
      Cesium.Color.GREEN,
      Cesium.Color.YELLOW,
      Cesium.Color.ORANGE,
      Cesium.Color.RED,
      Cesium.Color.DARKRED,
    ],
    unit: "µg/m³",
    labels: ["Good", "Moderate", "Poor", "Very Poor", "Hazardous"],
  },
  // Gases
  CO: {
    thresholds: [1, 2, 4],
    colors: ["#4CAF50", "#FFEB3B", "#FF9800", "#F44336"],
    cesiumColors: [
      Cesium.Color.GREEN,
      Cesium.Color.YELLOW,
      Cesium.Color.ORANGE,
      Cesium.Color.RED,
    ],
    unit: "mg/m³",
    labels: ["Good", "Moderate", "Poor", "Very Poor"],
  },
  NO2: {
    thresholds: [50, 100, 200],
    colors: ["#4CAF50", "#FFEB3B", "#FF9800", "#F44336"],
    cesiumColors: [
      Cesium.Color.GREEN,
      Cesium.Color.YELLOW,
      Cesium.Color.ORANGE,
      Cesium.Color.RED,
    ],
    unit: "µg/m³",
    labels: ["Good", "Moderate", "Poor", "Very Poor"],
  },
  O3: {
    thresholds: [60, 120, 180],
    colors: ["#4CAF50", "#FFEB3B", "#FF9800", "#F44336"],
    cesiumColors: [
      Cesium.Color.GREEN,
      Cesium.Color.YELLOW,
      Cesium.Color.ORANGE,
      Cesium.Color.RED,
    ],
    unit: "µg/m³",
    labels: ["Good", "Moderate", "Poor", "Very Poor"],
  },
  // Meteorological
  T: {
    thresholds: [-10, 30, -15, 35], // Special case for temperature
    colors: ["#2196F3", "#FF9800", "#F44336"],
    cesiumColors: [Cesium.Color.BLUE, Cesium.Color.ORANGE, Cesium.Color.RED],
    unit: "°C",
    labels: ["Normal", "Uncomfortable", "Extreme"],
    isMeteo: true,
  },
  RH: {
    thresholds: [30, 60, 20, 80], // Special case for humidity
    colors: ["#2196F3", "#FF9800", "#F44336"],
    cesiumColors: [
      Cesium.Color.BLUE.withAlpha(0.3),
      Cesium.Color.ORANGE,
      Cesium.Color.RED,
    ],
    unit: "%",
    labels: ["Comfortable", "Uncomfortable", "Extreme"],
    isMeteo: true,
  },
  // Default
  default: {
    thresholds: [25, 50, 75, 100],
    colors: ["#4CAF50", "#FFEB3B", "#FF9800", "#F44336", "#8B0000"],
    cesiumColors: [
      Cesium.Color.GREEN,
      Cesium.Color.YELLOW,
      Cesium.Color.ORANGE,
      Cesium.Color.RED,
      Cesium.Color.DARKRED,
    ],
    unit: "",
    labels: ["Good", "Moderate", "Poor", "Very Poor", "Hazardous"],
  },
};

// Unified function to get sensor color
function getSensorColor(param, value) {
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

// Function to update legend based on selected parameter
export function updateLegend(selectedParam) {
  const legend = document.getElementById("legend-airQuality");
  const config = airQualityConfig[selectedParam] || airQualityConfig.default;

  let legendHTML = `
   <button
        class="close-btn"
        onclick="this.parentElement.style.display='none'"
      >
        ×
      </button>
    <h4>Air Quality Legend (${selectedParam})</h4>
  `;

  if (config.isMeteo) {
    // Meteorological parameters special legend
    const [minGood, maxGood, minBad, maxBad] = config.thresholds;
    legendHTML += `
      <div class="legend-items">
        <div class="legend-color" style="background-color: ${config.colors[0]}"></div>
        <span>${config.labels[0]} (${minGood}${config.unit} ≤ ${selectedParam} ≤ ${maxGood}${config.unit})</span>
      </div>
      <div class="legend-items">
        <div class="legend-color" style="background-color: ${config.colors[1]}"></div>
        <span>${config.labels[1]}</span>
      </div>
      <div class="legend-items">
        <div class="legend-color" style="background-color: ${config.colors[2]}"></div>
        <span>${config.labels[2]} (${selectedParam} < ${minBad}${config.unit} or > ${maxBad}${config.unit})</span>
      </div>
    `;
  } else {
    // Standard air quality parameters legend
    for (let i = 0; i < config.thresholds.length; i++) {
      const rangeText =
        i === 0
          ? `${selectedParam} ≤ ${config.thresholds[i]}${config.unit}`
          : `${config.thresholds[i - 1]} < ${selectedParam} ≤ ${
              config.thresholds[i]
            }${config.unit}`;

      legendHTML += `
        <div class="legend-items">
          <div class="legend-color" style="background-color: ${config.colors[i]}"></div>
          <span>${config.labels[i]}: ${rangeText}</span>
        </div>
      `;
    }

    // Add final range
    legendHTML += `
      <div class="legend-items">
        <div class="legend-color" style="background-color: ${
          config.colors[config.colors.length - 1]
        }"></div>
        <span>${config.labels[config.labels.length - 1]}: ${selectedParam} > ${
      config.thresholds[config.thresholds.length - 1]
    }${config.unit}</span>
      </div>
    `;
  }

  // Add no data item
  legendHTML += `
    <div class="legend-items">
      <div class="legend-color" style="background-color: #9E9E9E"></div>
      <span>No Data</span>
    </div>`;

  legend.innerHTML = legendHTML;
}

updateLegend("PM10");
function createSensorIcon(color, text) {
  const iconSize = 32;
  const labelHeight = 30;
  const canvas = document.createElement("canvas");

  canvas.width = iconSize;
  canvas.height = iconSize + labelHeight;

  const ctx = canvas.getContext("2d");

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const fontSize = 14;
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";

  ctx.strokeStyle = "rgba(0,0,0,0.7)";
  ctx.lineWidth = 4;
  ctx.strokeText(text, iconSize / 2, labelHeight - 2);

  ctx.fillStyle = "white";
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 2;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 1;
  ctx.fillText(text, iconSize / 2, labelHeight - 2);

  ctx.strokeStyle = "black";
  ctx.lineWidth = 1.5;
  ctx.strokeText(text, iconSize / 2, labelHeight - 2);

  ctx.shadowColor = "transparent";
  ctx.fillStyle = "white";
  ctx.fillText(text, iconSize / 2, labelHeight - 2);

  ctx.beginPath();
  ctx.moveTo(16, labelHeight + 4);
  ctx.bezierCurveTo(
    24,
    labelHeight + 4,
    28,
    labelHeight + 12,
    16,
    labelHeight + 30
  );
  ctx.bezierCurveTo(
    4,
    labelHeight + 12,
    8,
    labelHeight + 4,
    16,
    labelHeight + 4
  );
  ctx.closePath();
  ctx.fillStyle = color.toCssColorString();
  ctx.fill();

  // inner cyrcle
  ctx.beginPath();
  ctx.arc(16, labelHeight + 12, 5, 0, 2 * Math.PI);
  ctx.fillStyle = "white";
  ctx.fill();

  return canvas;
}

// Load air quality sensors
export async function loadAirQualitySensors(
  viewer,
  operator,
  sensorEntities,
  param = "PM10",
  date,
  showLoading
) {
  try {
    const selectedDate = Cesium.JulianDate.toDate(date);
    const today = new Date();

    selectedDate.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);

    const isToday = selectedDate.getTime() === today.getTime();
    let url;

    if (!showLoading) {
      document.getElementById("loadingOverlay").style.display = "block";
    }
    const modeSelectorContainer = document.getElementById(
      "modeSelectorContainer"
    );

    if (isToday) {
      modeSelectorContainer.style.display = "none";
      url = `${API_URL}/api/operator-stations?operator=${encodeURIComponent(
        operator
      )}`;
    } else {
      modeSelectorContainer.style.display = "flex";
      // 👉 ВИНАГИ използваме byAgr режим
      const mode = "byAgr";
      const isoDate = selectedDate.toLocaleDateString("sv-SE");
      const paramsList = operatorParams[operator] || [];

      url = `${API_URL}/api/operator-stations-by-date?operator=${encodeURIComponent(
        operator
      )}&date=${encodeURIComponent(isoDate)}&params=${encodeURIComponent(
        paramsList.join(",")
      )}&mode=${encodeURIComponent(mode)}`;
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const geojson = await response.json();

    sensorEntities.forEach((entity) => viewer.entities.remove(entity));
    sensorEntities.length = 0;

    geojson.features.forEach((feature) => {
      const valueData = feature.properties[param];

      console.log("Sensor:", feature.properties.object);
      console.log("Value data:", valueData); // {max: 22, min: 6.1, avg: 14.49} or null

      let displayValue = null;

      if (valueData && typeof valueData === "object") {
        let agr = document.getElementById("modeSelector").value;
        displayValue = valueData[agr];
      } else if (isToday) {
        displayValue = valueData;
      }

      console.log("Display value:", displayValue);

      const color = getSensorColor(param, displayValue);

      const icon = createSensorIcon(
        color,
        feature.properties.object || "Sensor",
        displayValue
      );

      const scale = parseFloat(document.getElementById("sensorScale").value);

      const entity = viewer.entities.add({
        name: `Air Quality Sensor ${feature.properties.object} - ${param}: ${
          displayValue !== null ? displayValue : "N/A"
        }`,
        position: Cesium.Cartesian3.fromDegrees(
          feature.geometry.coordinates[0],
          feature.geometry.coordinates[1],
          0
        ),
        billboard: {
          image: icon,
          scale: scale + 2,
          scaleByDistance: new Cesium.NearFarScalar(100, 1.0, 10000, 0.3),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        properties: {
          ...feature.properties,
          currentParam: param,
          currentValue: displayValue,
        },
      });

      sensorEntities.push(entity);
    });
  } catch (error) {
    console.error("Failed to load air quality sensors:", error.message);
  } finally {
    document.getElementById("loadingOverlay").style.display = "none";
  }
}
export function updateAirQualityValues(
  sensorEntities,
  param = "PM10",
  valueType = "max"
) {
  sensorEntities.forEach((entity) => {
    const prop = entity.properties[param];
    const raw = prop && prop.getValue ? prop.getValue() : prop;

    let value = null;
    if (typeof raw === "number") {
      value = raw;
    } else if (raw && typeof raw === "object") {
      value = raw[valueType];
    }

    const color = getSensorColor(param, value);
    const icon = createSensorIcon(color, entity.properties.object || "Sensor");
    entity.billboard.image = icon;
  });
}

export function updateSensorParams() {
  const operatorSelect = document.getElementById("sensorOperator");
  const paramsSelect = document.getElementById("sensorParams");

  const selectedOperator = operatorSelect.value;
  const params = operatorParams[selectedOperator] || [];

  // Изчистваме старите опции
  paramsSelect.innerHTML = "";

  // Добавяме новите
  params.forEach((code) => {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = paramMap[code] || code;
    paramsSelect.appendChild(option);
  });
}

//graph for all operators for specific param
export async function drawParamChart(operator, param, cesiumDate, canvaId) {
  try {
    const modal = document.getElementById("chartAllStations");
    const canvas = document.getElementById(canvaId);
    modal.style.display = "flex";

    if (canvas._chart) {
      canvas._chart.destroy();
    }

    // Convert Cesium.JulianDate to js date
    const selectedDate = Cesium.JulianDate.toDate(cesiumDate);
    selectedDate.setHours(0, 0, 0, 0);
    const isoDate = selectedDate.toLocaleDateString("sv-SE");
    const paramsList = operatorParams[operator] || [];

    document.getElementById("loadingOverlay").style.display = "block";

    const backendUrl = new URL(`${API_URL}/api/operator-stations-by-date`);
    backendUrl.searchParams.append("operator", operator);
    backendUrl.searchParams.append("date", isoDate);
    backendUrl.searchParams.append("params", paramsList.join(","));
    backendUrl.searchParams.append("mode", "byHour");
    backendUrl.searchParams.append("param", param);

    const response = await fetch(backendUrl.toString());

    if (!response.ok) {
      throw new Error(`Backend error: ${response.status}`);
    }
    const result = await response.json();
    //alert(JSON.stringify(result, null, 2));
    const datasets = [];
    const labelsSet = new Set();

    Object.entries(result).forEach(([stationName, stationData]) => {
      const series = stationData.series;
      if (series && Array.isArray(series) && series.length > 0) {
        const data = series
          .map((measurement) => {
            const date = measurement.timestamp;
            const value = measurement.value;
            if (date && value !== undefined) {
              labelsSet.add(date);
              return { x: date, y: value };
            }
            return null;
          })
          .filter((point) => point !== null);

        if (data.length > 0) {
          datasets.push({
            label: stationName,
            data,
            borderWidth: 2,
            fill: false,
            tension: 0.1,
            pointRadius: 3,
            pointHoverRadius: 8,
            borderColor: colors[datasets.length % colors.length],
            backgroundColor: colors[datasets.length % colors.length],
          });
        }
      }
    });

    if (datasets.length === 0) {
      console.warn("No data available for chart");
      modal.innerHTML =
        "<p>No data available for the selected parameter and stations</p>";
      return;
    }

    const isMinimized = modal.classList.contains("minimized");

    const config = {
      type: "line",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: !isMinimized,
            position: "top",
            labels: {
              usePointStyle: true,
              pointStyle: "circle",
              padding: 20,
            },
          },
          title: {
            display: true,
            text: `Air Quality on ${isoDate}`,
            font: {
              size: 16,
              weight: "bold",
            },
          },
          tooltip: {
            backgroundColor: "rgba(0,0,0,0.8)",
            titleColor: "#ffffff",
            bodyColor: "#ffffff",
            titleFont: { size: 14, weight: "bold" },
            bodyFont: { size: 12 },
            padding: 12,
            cornerRadius: 6,
            callbacks: {
              label: function (context) {
                const label = context.dataset.label || "";
                const value = context.parsed.y;
                const unit = getUnitForParam(param);
                return `${label}: ${
                  value !== undefined ? value.toFixed(2) : "N/A"
                } ${unit}`;
              },
              title: function (context) {
                const date = new Date(context[0].parsed.x);
                return date.toLocaleString("en-US", {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                });
              },
            },
            displayColors: true,
            intersect: false,
            mode: "nearest",
          },
        },
        scales: {
          x: {
            type: "time",
            time: {
              parser: "yyyy-MM-dd HH:mm:ss",
              tooltipFormat: "dd MMM yyyy HH:mm",
              displayFormats: { hour: "HH:mm", day: "DD MMM" },
            },
            title: {
              display: true,
              text: "Date and Time",
              font: { weight: "bold" },
            },
          },
          y: {
            title: {
              display: true,
              text: `${param} (${getUnitForParam(param)})`,
              font: { weight: "bold" },
            },
            grid: {
              color: "rgba(0, 0, 0, 0.1)",
            },
          },
        },
        interaction: {
          intersect: false,
          mode: "nearest",
          axis: "x",
        },
      },
    };

    canvas._chart = new Chart(canvas, config);
    document.getElementById("loadingOverlay").style.display = "none";
  } catch (err) {
    console.error("Error drawing chart:", err);
    const modal = document.getElementById("chartAllStations");
    modal.innerHTML = `<p>Error loading chart: ${err.message}</p>`;
    document.getElementById("loadingOverlay").style.display = "none";
  }
}

const colors = [
  "#1f77b4",
  "#ff7f0e",
  "#2ca02c",
  "#d62728",
  "#9467bd",
  "#8c564b",
  "#e377c2",
  "#7f7f7f",
  "#bcbd22",
  "#17becf",
  "#aec7e8",
  "#ffbb78",
  "#98df8a",
  "#ff9896",
  "#c5b0d5",
  "#c49c94",
  "#f7b6d2",
  "#c7c7c7",
  "#dbdb8d",
  "#9edae5",
  "#393b79",
  "#5254a3",
  "#6b6ecf",
  "#9c9ede",
  "#637939",
];

// Helper function to get units for parameters
export function getUnitForParam(param) {
  const config = airQualityConfig[param] || airQualityConfig.default;
  return config.unit || "";
}
