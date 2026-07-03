// worker.js
// Handles heavy parsing tasks off the main JavaScript execution thread.
// Supports: PARSE_GRID_DATA, COMPUTE_AQI

// CPCB AQI Breakpoints for sub-index computation
const CPCB_BREAKPOINTS = {
  pm25: [
    [[0, 30], [0, 50]],
    [[31, 60], [51, 100]],
    [[61, 90], [101, 200]],
    [[91, 120], [201, 300]],
    [[121, 250], [301, 400]],
    [[251, 1000], [401, 500]]
  ],
  pm10: [
    [[0, 50], [0, 50]],
    [[51, 100], [51, 100]],
    [[101, 250], [101, 200]],
    [[251, 350], [201, 300]],
    [[351, 430], [301, 400]],
    [[431, 1000], [401, 500]]
  ],
  no2: [
    [[0, 40], [0, 50]],
    [[41, 80], [51, 100]],
    [[81, 180], [101, 200]],
    [[181, 280], [201, 300]],
    [[281, 400], [301, 400]],
    [[401, 1000], [401, 500]]
  ],
  so2: [
    [[0, 40], [0, 50]],
    [[41, 80], [51, 100]],
    [[81, 380], [101, 200]],
    [[381, 800], [201, 300]],
    [[801, 1600], [301, 400]],
    [[1601, 5000], [401, 500]]
  ],
  co: [
    [[0, 1], [0, 50]],
    [[1.1, 2], [51, 100]],
    [[2.1, 10], [101, 200]],
    [[10.1, 17], [201, 300]],
    [[17.1, 34], [301, 400]],
    [[34.1, 100], [401, 500]]
  ],
  o3: [
    [[0, 50], [0, 50]],
    [[51, 100], [51, 100]],
    [[101, 168], [101, 200]],
    [[169, 208], [201, 300]],
    [[209, 748], [301, 400]],
    [[749, 1000], [401, 500]]
  ]
};

function calculateSubIndex(val, pollutant) {
  const ranges = CPCB_BREAKPOINTS[pollutant];
  if (!ranges) return 0;
  for (const [[c_low, c_high], [i_low, i_high]] of ranges) {
    if (val >= c_low && val <= c_high) {
      return i_low + ((val - c_low) * (i_high - i_low)) / (c_high - c_low);
    }
  }
  const lastRange = ranges[ranges.length - 1];
  if (val > lastRange[0][1]) return lastRange[1][1];
  return 0;
}

function computeAQI(pm25, pm10, no2, so2, co, o3) {
  return Math.round(Math.max(
    calculateSubIndex(pm25, 'pm25'),
    calculateSubIndex(pm10, 'pm10'),
    calculateSubIndex(no2, 'no2'),
    calculateSubIndex(so2, 'so2'),
    calculateSubIndex(co, 'co'),
    calculateSubIndex(o3, 'o3')
  ));
}

self.onmessage = function (e) {
  const { type, data } = e.data;

  // --- Parse grid data arrays or GeoJSON ---
  if (type === 'PARSE_GRID_DATA') {
    try {
      let parsedData;
      if (typeof data === 'string') {
        parsedData = JSON.parse(data);
      } else {
        parsedData = data;
      }

      let values = [];

      // Support GeoJSON FeatureCollection
      if (parsedData.type === 'FeatureCollection' && Array.isArray(parsedData.features)) {
        values = parsedData.features.map(f => f.properties?.aqi ?? 0);
      }
      // Support raw { width, height, values } format
      else if (Array.isArray(parsedData.values)) {
        values = parsedData.values;
      }
      // Support plain array of numbers
      else if (Array.isArray(parsedData)) {
        values = parsedData;
      }

      const stats = { min: Infinity, max: -Infinity, avg: 0, count: values.length };
      if (values.length > 0) {
        let sum = 0;
        for (let i = 0; i < values.length; i++) {
          const val = values[i];
          if (val < stats.min) stats.min = val;
          if (val > stats.max) stats.max = val;
          sum += val;
        }
        stats.avg = sum / stats.count;
      } else {
        stats.min = 0;
        stats.max = 0;
      }

      self.postMessage({
        type: 'PARSE_SUCCESS',
        payload: {
          width: parsedData.width || 0,
          height: parsedData.height || 0,
          values,
          stats
        }
      });
    } catch (error) {
      self.postMessage({
        type: 'PARSE_ERROR',
        error: error.message
      });
    }
  }

  // --- Compute AQI from pollutant concentrations ---
  else if (type === 'COMPUTE_AQI') {
    try {
      const { pm25, pm10, no2, so2, co, o3 } = data;
      const aqi = computeAQI(
        pm25 || 0, pm10 || 0, no2 || 0,
        so2 || 0, co || 0, o3 || 0
      );
      self.postMessage({
        type: 'PARSE_SUCCESS',
        payload: { aqi }
      });
    } catch (error) {
      self.postMessage({
        type: 'PARSE_ERROR',
        error: error.message
      });
    }
  }
};
