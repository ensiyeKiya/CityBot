import { getUnitForParam, API_URL } from "./sensorManager.js";

function formatDateForAPI(date) {
  const pad = (n) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:00:00`;
}

async function fetchChartDataWithOptionalNum( station, params, startDate, endDate, optional_num ) {
      document.getElementById("loadingOverlay").style.display = "block";

  const paramsArray = Array.isArray(params) ? params : [params];

  const backendUrl = new URL(`${API_URL}/api/air-quality`);
  backendUrl.searchParams.append("station", station);
   paramsArray.forEach(param => {
        backendUrl.searchParams.append("params", param);
    });
  backendUrl.searchParams.append("startDate", startDate);
  backendUrl.searchParams.append("endDate", endDate);
  backendUrl.searchParams.append("optional_num", optional_num || 1);

  try {
    const response = await fetch(backendUrl.toString());
    const responseData = await response.json();

    if (!response.ok) {
      throw new Error(
        responseData.error ||
          `API request failed with status ${response.status}`
      );
    }

    if (!Array.isArray(responseData)) {
      throw new Error("Invalid data format received from server");
    }

    return responseData;
  } catch (error) {
    console.error("API Error:", {
      url: backendUrl.toString(),
      error: error.message,
    });
    throw error;
  }
  finally {
    document.getElementById("loadingOverlay").style.display = "none";
  }
}

//graph for specific param
function renderChart(labels, values, param, station, button) {
  const modal = document.getElementById("chartModal");
  const canvas = document.getElementById("chartModalCanvas");
  modal.style.display = "flex";

  if (canvas._chart) {
    canvas._chart.destroy();
  }
 const unit = getUnitForParam(param); 
  canvas._chart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: `${param} at station ${station}`,
          data: values,
          borderColor: "rgba(75, 192, 192, 1)",
          backgroundColor: "rgba(75, 192, 192, 0.2)",
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: "rgba(75, 192, 192, 1)",
          tension: 0.1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "top" },
        tooltip: {
          callbacks: {
            label(ctx) {
              return `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)} µg/m³`;
            },
          },
        },
        zoom: {
          pan: {
            enabled: true,
            mode: "x",
          },
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            mode: "x",
          },
        },
      },
      scales: {
        x: {
          type: "time",
          time: {
            tooltipFormat: "dd.MM.yyyy HH:mm",
            displayFormats: {
              hour: "dd.MM HH:mm",
              day: "dd.MM",
            },
          },
          title: { display: true, text: "Date and Time" },
        },
        y: {
          title: { display: true, text: `${param} (${unit})` },
          beginAtZero: false,
        },
      },
    },
  });
}

export async function toggleChart(button) {
  const param = button.getAttribute("data-param");
  const station = button.getAttribute("data-station");

  // setting the start and end date - 2 months ago to now
  const endDate = new Date();
  const startDateDefault = new Date();
  startDateDefault.setMonth(endDate.getMonth() - 2);

  const formattedStart = formatDateForAPI(startDateDefault);
  const formattedEnd = formatDateForAPI(endDate);

  const optional_num = 1;

  try {
    const data = await fetchChartDataWithOptionalNum(
      station,
      param,
      formattedStart,
      formattedEnd,
      optional_num
    );
    const labels = data.map((item) => new Date(item.Start_Date));
    const values = data.map((item) => Number(item.Values) || 0);

    renderChart(labels, values, param, station, button);
  } catch (error) {
    console.error("Error loading chart:", error);

    let errorMessage = "Failed to load data";
    if (error.message.includes("Failed to fetch")) {
      errorMessage = "Network error - please check your connection";
      alert(errorMessage);
    } else if (error.message.includes("status 401")) {
      errorMessage = "Authentication failed";
      alert(errorMessage);
    } else if (error.message.includes("status 500")) {
      errorMessage = "Server error - please try again later";
      alert(errorMessage);
    } else {
      errorMessage = error.message;
    }
  }
}
