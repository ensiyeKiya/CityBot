import { toggleChart } from "./charts.js";
import { paramMap, operatorParams } from "./sensorManager.js"; 
export function updateFeatureInfoBox(pickedFeature, selectedStyle, date) {
  const isEntitySensor = pickedFeature.id && pickedFeature.id.billboard;
  let htmlContent = "";

  const featureName =
    pickedFeature.id?.name ||
    pickedFeature.getProperty?.("name") ||
    pickedFeature.getProperty?.("cad_id") ||
    pickedFeature.getProperty?.("citygml_class_description") ||
    "Unnamed feature";



  if (isEntitySensor && pickedFeature.id.properties) {
    htmlContent = airQualityTable(pickedFeature.id.properties, featureName, date);
  } else {
      htmlContent = createDefaultTable(pickedFeature, featureName);
  }

  featureInfo.innerHTML = htmlContent;
  featureInfo.style.display = "block";

  setTimeout(() => {
    document.querySelectorAll(".chart-toggle").forEach((button) => {
      button.addEventListener("click", (e) => {
        toggleChart(e.target);
      });
    });
  }, 0);
}



function createDefaultTable(feature, name) {
  let allProperties = "";
  const propertyIds = feature.getPropertyIds();
//alert(feature.getProperty("walk_access_index"));
  for (let i = 0; i < propertyIds.length; i++) {
    const propName = propertyIds[i];
    const propValue = feature.getProperty(propName);
    allProperties += `${propName}: ${propValue}\n`;
  }
  return `<button class="close-btn" onclick="this.parentElement.style.display='none'">×</button>
      <div class="feature-info-title">Building Information</div>
      <div id="featureInfoContent"> <table class="feature-info-table">
          <tbody>
            <tr><th>Address</th><td>${feature.getProperty("addr") || "No data"}</td></tr>
            <tr><th>Class</th><td>${feature.getProperty("citygml_class_description") || "No data"}</td></tr>
            <tr><th>Function</th><td>${feature.getProperty("citygml_function_description") || "No data"}</td></tr>
            <tr><th>Average sunshine hours</th><td>${feature.getProperty("sunhrs_int_avg") || "No data"}</td></tr>
            <tr><th>Height</th><td>${feature.getProperty("citygml_measured_height") || "No data"}</td></tr>
            <tr><th>Latitude</th><td>${feature.getProperty("lat") || "No data"}</td></tr>
            <tr><th>Longitude</th><td>${feature.getProperty("lon") || "No data"}</td></tr>
            <tr><th>Energy Lower Tolerance Bound</th><td>${feature.getProperty("energy_ti_ltb") || "No data"}</td></tr>
            <tr><th>Energy Upper Tolerance Bound</th><td>${feature.getProperty("energy_ti_utb") || "No data"}</td></tr>
            <tr><th>Walkability</th><td>${feature.getProperty("walk_access_index") || "No data"}</td></tr>
            <tr><th>Wikipedia article title</th><td>${feature.getProperty("wiki_title_bg") || "No data"}</td></tr>
          </tbody>
        </table> </div> `;
}

function createRowWithChart(
  label,
  value,
  station,
  date_of_measurement,
  paramShort
) {
  return ` <tr>
      <th>${label}</th>
      <td>
        ${
          value === null ||
          value === undefined ||
          value === "null" ||
          value === "undefined"
            ? "No data"
            : value
        }
        <button class="chart-toggle" data-param="${paramShort}" data-station="${station}" data-date="${date_of_measurement}" style="padding-left:3px">(See more)</button>
        <div class="chart-container" style="display:none; margin-top:8px;"></div>
      </td>
    </tr>`;
}

function airQualityTable(props, name, date) {
  const selectedDate = Cesium.JulianDate.toDate(date);
  const today = new Date();
  selectedDate.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);

  const isToday = selectedDate.getTime() === today.getTime();
  const mode = !isToday ? document.getElementById("modeSelector").value : null;

  let selectedFields;
  if (name.includes("AT")) {
    selectedFields = operatorParams["Sofia municipality"];
  } else if (name.includes("AE")) {
    selectedFields = operatorParams["Executive environmental agency (ExEA)"];
  } else {
    selectedFields = operatorParams["GATE Institute"];
  }

  const rows = selectedFields
    .map((key) => {
      let raw = props[key];

      // ако е Cesium property → вземаме стойност
      if (raw && typeof raw.getValue === "function") {
        raw = raw.getValue();
      }

      // ако е {max,min,avg} → избираме според mode
      let value = raw;
      if (!isToday && raw && typeof raw === "object") {
        value = raw[mode] ?? null;
      }

      const fullLabel = paramMap[key] || key;
      return createRowWithChart(
        fullLabel,
        value,
        props.object,
        props.date_measured,
        key
      );
    })
    .join("");

  const html = `
    <button class="close-btn" onclick="this.parentElement.style.display='none'">×</button>
    <div class="feature-info-title"><strong>${name}</strong></div>
    <div id="featureInfoContent" style="max-height: 400px; overflow-y: auto;">
      <table class="feature-info-table">
        <tbody>
          <tr><th>Location</th><td>${props.coordinates || "No data"}</td></tr>
          <tr>
            <th>
              ${
                isToday
                  ? "Last measurements"
                  : mode === "max"
                  ? "Max measurements for"
                  : mode === "min"
                  ? "Min measurements for"
                  : "Average measurements for"
              }:
            </th>
            <td>${props.date_measured || "No data"}</td>
          </tr>
          ${rows}
        </tbody>
      </table>
    </div>
  `;

  return html;
}

