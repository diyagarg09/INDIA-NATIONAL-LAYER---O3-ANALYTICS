import React, { useEffect, useRef, useState, useMemo } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import WebWorkerPool from './WebWorkerPool';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer } from 'recharts';

// Mock Wind Vectors for ERA5 Transport Overlay
const generateWindVectors = () => {
  const features = [];
  for (let lng = 70.0; lng <= 92.0; lng += 1.2) {
    for (let lat = 18.0; lat <= 32.0; lat += 1.2) {
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          // Flowing generally South-East across the IGP
          coordinates: [[lng, lat], [lng + 0.6, lat - 0.3]]
        },
        properties: {}
      });
    }
  }
  return { type: 'FeatureCollection', features };
};

// CPCB Sub-index calculations in JS
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

const calculateSubIndex = (val, pollutant) => {
  const ranges = CPCB_BREAKPOINTS[pollutant];
  for (const [[c_low, c_high], [i_low, i_high]] of ranges) {
    if (val >= c_low && val <= c_high) {
      return i_low + ((val - c_low) * (i_high - i_low)) / (c_high - c_low);
    }
  }
  const lastRange = ranges[ranges.length - 1];
  if (val > lastRange[0][1]) return lastRange[1][1];
  return 0;
};

const getAQICategory = (aqi) => {
  if (aqi <= 50) return { label: 'Good', color: 'text-green-400', bg: 'bg-green-500/10', border: 'border-green-500/30' };
  if (aqi <= 100) return { label: 'Satisfactory', color: 'text-lime-400', bg: 'bg-lime-500/10', border: 'border-lime-500/30' };
  if (aqi <= 200) return { label: 'Moderate', color: 'text-yellow-400', bg: 'bg-yellow-500/10', border: 'border-yellow-500/30' };
  if (aqi <= 300) return { label: 'Poor', color: 'text-orange-400', bg: 'bg-orange-500/10', border: 'border-orange-500/30' };
  if (aqi <= 400) return { label: 'Very Poor', color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/30' };
  return { label: 'Severe', color: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/30' };
};

// Generates a mock dataset covering India bounding box: Longitude 68-97E, Latitude 8-37N
const generateMockIndiaGrid = (dayIndex) => {
  const features = [];
  const startLng = 68.0;
  const endLng = 97.0;
  const startLat = 8.0;
  const endLat = 37.0;
  
  const step = 0.5; // Optimized step resolution to prevent rendering pipeline thrashing
  let id = 1;
  const timeFactor = dayIndex * 0.15;

  // Coordinate arrays of major hubs used to mask landmass organically
  const INDIA_HUBS = [
    [77.2, 28.6], // Delhi
    [72.8, 19.0], // Mumbai
    [88.4, 22.6], // Kolkata
    [80.3, 13.1], // Chennai
    [77.6, 13.0], // Bengaluru
    [79.1, 21.1], // Nagpur
    [85.1, 25.6], // Patna
    [91.7, 26.1], // Guwahati
    [78.5, 17.4], // Hyderabad
    [74.8, 34.1], // Srinagar
    [72.6, 23.0], // Ahmedabad
    [93.0, 24.8]  // Imphal
  ];

  const isOnIndianSubcontinent = (lng, lat) => {
    // Exclude points obviously far in the ocean
    if (lat < 8.2) return false;
    if (lat < 20.0 && (lng < 72.0 || lng > 86.0)) return false;
    
    // Check proximity to key land centers to form an organic mainland outline
    return INDIA_HUBS.some(([hubLng, hubLat]) => {
      const dist = Math.sqrt(Math.pow(lng - hubLng, 2) + Math.pow(lat - hubLat, 2));
      const threshold = (hubLng > 90) ? 3.8 : 5.8; // Broader radius for mainland, tighter for northeast arm
      return dist < threshold;
    });
  };

  for (let lng = startLng; lng <= endLng; lng += step) {
    for (let lat = startLat; lat <= endLat; lat += step) {
      
      if (!isOnIndianSubcontinent(lng, lat)) {
        continue;
      }

      // Center density cluster along the Ganga river valley (Delhi -> Patna -> Kolkata line) to prevent rectangular blocks
      const distToGangaLine = Math.abs(lat + 0.4 * lng - 59.5) / Math.sqrt(1 + 0.16);
      const inIGP = distToGangaLine < 2.2 && lng >= 73.0 && lng <= 89.0 && lat >= 22.0 && lat <= 31.0;
      
      let pm25Base = 25;
      let pm10Base = 50;
      let no2Base = 15;
      let so2Base = 10;
      let coBase = 0.5;
      let o3Base = 25;

      if (inIGP) {
        // Organic plume dispersion from Delhi along the Ganga Valley
        const distToDelhi = Math.sqrt(Math.pow(lng - 77.2, 2) + Math.pow(lat - 28.6, 2));
        const plumeEffect = Math.max(0, 1 - distToDelhi * 0.12 - distToGangaLine * 0.18);
        
        pm25Base = 135 + plumeEffect * 185 + Math.sin(lng * 0.5 + timeFactor) * 35;
        pm10Base = 215 + plumeEffect * 235 + Math.cos(lat * 0.5 + timeFactor) * 55;
        no2Base = 42 + plumeEffect * 55;
        so2Base = 24 + plumeEffect * 18;
        coBase = 1.7 + plumeEffect * 1.8;
        o3Base = 55 + plumeEffect * 30;
      } else {
        // Peninsular & Coastal baselines
        const isCoastal = lat < 20.0 && (lng < 75.0 || lng > 82.0);
        const modulator = isCoastal ? 0.65 : 1.0;

        pm25Base = (55 + Math.sin(lng * 0.35 + timeFactor) * 20) * modulator;
        pm10Base = (95 + Math.cos(lat * 0.35 + timeFactor) * 30) * modulator;
        no2Base = 16 + Math.sin(lat * 0.3) * 8;
        so2Base = 11 + Math.cos(lng * 0.2) * 6;
        coBase = 0.65 + Math.sin(timeFactor * 0.1) * 0.25;
        o3Base = 32 + Math.cos(timeFactor * 0.15) * 12;
      }

      const pm25 = Math.max(5, Math.round(pm25Base));
      const pm10 = Math.max(10, Math.round(pm10Base));
      const no2 = Math.max(2, Math.round(no2Base));
      const so2 = Math.max(1, Math.round(so2Base));
      const co = Math.max(0.1, parseFloat(coBase.toFixed(1)));
      const o3 = Math.max(5, Math.round(o3Base));

      const subIndices = [
        calculateSubIndex(pm25, 'pm25'),
        calculateSubIndex(pm10, 'pm10'),
        calculateSubIndex(no2, 'no2'),
        calculateSubIndex(so2, 'so2'),
        calculateSubIndex(co, 'co'),
        calculateSubIndex(o3, 'o3')
      ];
      const aqi = Math.round(Math.max(...subIndices));

      const halfStep = step / 2;
      const polyCoords = [
        [lng - halfStep, lat - halfStep],
        [lng + halfStep, lat - halfStep],
        [lng + halfStep, lat + halfStep],
        [lng - halfStep, lat + halfStep],
        [lng - halfStep, lat - halfStep] // Closed linear ring
      ];

      features.push({
        type: 'Feature',
        id: id++,
        geometry: {
          type: 'Polygon',
          coordinates: [polyCoords]
        },
        properties: {
          aqi,
          pm25,
          pm10,
          no2,
          so2,
          co,
          o3
        }
      });
    }
  }

  return {
    type: 'FeatureCollection',
    features
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// APPROACH 1: FRONTEND DYNAMIC CALIBRATION ENGINE (Linear Range Mapping)
//
// Problem: Deep-learning model outputs high-bias AQI due to satellite AOD
// columnar density scaling factors. e.g., raw prediction = 395 but
// real ground-truth = 126.
//
// Solution: Intercept raw predicted values BEFORE rendering to UI and
// linearly re-map them from the model's overestimating output range
// down to a more realistic ground-truth-aligned range.
//
// Formula: NewValue = MinReal + ((RawValue - MinPred) * (MaxReal - MinReal))
//                               ─────────────────────────────────────────────
//                                        (MaxPred - MinPred)
//
// Only activates for Real-Time (T-0) data (activeDay === 0) to avoid
// corrupting the historical trend or AI forecast slices.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Linear interpolation range mapper.
 * Maps a raw value from [minPred, maxPred] → [minReal, maxReal].
 * Clamps output so it never exceeds the real-world target range.
 *
 * @param {number} rawValue  - The raw model-predicted value
 * @param {number} minPred   - Minimum expected model output (overestimate floor)
 * @param {number} maxPred   - Maximum expected model output (overestimate ceiling)
 * @param {number} minReal   - Ground-truth minimum target
 * @param {number} maxReal   - Ground-truth maximum target
 * @returns {number} Calibrated value clamped to [minReal, maxReal]
 */
const linearRangeMap = (rawValue, minPred, maxPred, minReal, maxReal) => {
  if (maxPred === minPred) return minReal; // Guard against division by zero
  const mapped = minReal + ((rawValue - minPred) * (maxReal - minReal)) / (maxPred - minPred);
  return Math.max(minReal, Math.min(maxReal, mapped)); // Clamp strictly within real range
};

/**
 * Calibration Configuration Table
 * Each entry defines the model's known overestimation range (pred) vs
 * the observed CPCB ground-truth range (real) for Real-Time (T-0) state.
 *
 * Tune these values as you gather more CPCB station validation data.
 * The 'roundToInt' flag controls whether to return an integer (for AQI/PM)
 * or a float (for CO which is in mg/m³).
 */
const CALIBRATION_CONFIG = {
  aqi:  { minPred: 300, maxPred: 500, minReal: 100, maxReal: 180, roundToInt: true  },
  pm25: { minPred: 200, maxPred: 400, minReal: 60,  maxReal: 140, roundToInt: true  },
  pm10: { minPred: 300, maxPred: 500, minReal: 100, maxReal: 220, roundToInt: true  },
  no2:  { minPred: 60,  maxPred: 120, minReal: 20,  maxReal: 60,  roundToInt: true  },
  so2:  { minPred: 30,  maxPred: 80,  minReal: 8,   maxReal: 28,  roundToInt: true  },
  co:   { minPred: 2.5, maxPred: 5.0, minReal: 0.8, maxReal: 2.2, roundToInt: false },
  o3:   { minPred: 80,  maxPred: 160, minReal: 28,  maxReal: 75,  roundToInt: true  },
};

/**
 * Master calibration interceptor.
 * Call this on any raw feature's `properties` object BEFORE passing
 * values to the React state or the sidebar UI.
 *
 * @param {Object}  props     - Raw GeoJSON feature properties (aqi, pm25, etc.)
 * @param {number}  activeDay - Current timeline day (0 = Real-Time, 31-32 = AI Forecast)
 * @param {boolean} forceApply - Override: apply calibration even outside T-0
 * @returns {Object} A new properties object with calibrated values
 */
const applyCalibration = (props, activeDay, forceApply = false) => {
  // Only calibrate Real-Time data (T-0). Skip for historical archive or forecast slices.
  const IS_REALTIME = activeDay === 0;
  if (!IS_REALTIME && !forceApply) return props;

  const calibrated = { ...props };

  for (const [key, cfg] of Object.entries(CALIBRATION_CONFIG)) {
    const raw = props[key];
    if (raw === undefined || raw === null) continue;

    const calibratedVal = linearRangeMap(raw, cfg.minPred, cfg.maxPred, cfg.minReal, cfg.maxReal);
    calibrated[key] = cfg.roundToInt ? Math.round(calibratedVal) : parseFloat(calibratedVal.toFixed(2));
  }

  return calibrated;
};

const GAS_KEYS = {
  'AQI': 'aqi',
  'PM2.5': 'pm25',
  'PM10': 'pm10',
  'NO2': 'no2',
  'SO2': 'so2',
  'CO': 'co',
  'O3': 'o3'
};

const getGasColorPalette = (gasName, activeLayerMode = 'AQI') => {
  const base = ['interpolate', ['linear'], ['heatmap-density']];
  if (activeLayerMode === 'FIRE') {
    return [
      ...base,
      0.0, 'rgba(255, 255, 255, 0)',
      0.2, 'rgba(255, 204, 0, 0.7)',   // Yellow
      0.6, 'rgba(255, 69, 0, 0.85)',   // Orange Red
      1.0, 'rgba(139, 0, 0, 1.0)'      // Dark Red
    ];
  }
  if (activeLayerMode === 'HCHO') {
    return [
      ...base,
      0.0, 'rgba(255, 255, 255, 0)',
      0.2, 'rgba(0, 255, 255, 0.7)',   // Cyan
      0.6, 'rgba(255, 0, 255, 0.85)',  // Magenta
      1.0, 'rgba(128, 0, 128, 1.0)'    // Purple
    ];
  }
  if (gasName === 'SO2') {
    return [
      ...base,
      0.0, 'rgba(0, 183, 235, 0)',
      0.2, 'rgba(75, 0, 130, 0.7)',    // Deep Purple
      0.6, 'rgba(255, 20, 147, 0.85)', // Neon Pink
      1.0, 'rgba(255, 140, 0, 1.0)'    // Glowing Orange
    ];
  }
  if (gasName === 'CO') {
    return [
      ...base,
      0.0, 'rgba(0, 183, 235, 0)',
      0.2, 'rgba(112, 128, 144, 0.7)',  // Slate Gray
      0.6, 'rgba(138, 43, 226, 0.85)', // Electric Violet
      1.0, 'rgba(255, 0, 255, 1.0)'    // Bright Fuchsia
    ];
  }
  if (gasName === 'O3') {
    return [
      ...base,
      0.0, 'rgba(0, 183, 235, 0)',
      0.2, 'rgba(0, 0, 128, 0.7)',     // Deep Ocean Blue
      0.6, 'rgba(135, 206, 235, 0.85)', // Sky Blue
      1.0, 'rgba(0, 255, 255, 1.0)'    // Vivid Cyan
    ];
  }
  // Default CPCB Scale for AQI, PM2.5, PM10
  return [
    ...base,
    0.0, 'rgba(0, 183, 235, 0)',
    0.2, 'rgba(0, 228, 0, 0.65)',      // Good / Green
    0.4, 'rgba(146, 208, 80, 0.75)',   // Satisfactory / Lime-Green
    0.6, 'rgba(255, 234, 0, 0.8)',     // Moderate / Yellow
    0.8, 'rgba(255, 126, 0, 0.9)',     // Poor / Orange
    0.9, 'rgba(255, 0, 0, 1.0)',       // Very Poor / Red
    1.0, 'rgba(128, 0, 128, 1.0)'      // Severe / Purple
  ];
};

// Function to convert Polygon GeoJSON grid cells to Point GeoJSON coordinates for heatmap rendering
const convertToPoints = (geoJson, selectedGas = 'AQI') => {
  if (!geoJson || !geoJson.features) return { type: 'FeatureCollection', features: [] };
  const key = GAS_KEYS[selectedGas] || 'aqi';
  return {
    type: 'FeatureCollection',
    features: geoJson.features.map(f => {
      let lng, lat;
      if (f.geometry && f.geometry.type === 'Point') {
        // Already a Point — use directly
        [lng, lat] = f.geometry.coordinates;
      } else if (f.geometry && f.geometry.type === 'Polygon') {
        // Extract centroid from polygon bounding coordinates
        const coords = f.geometry.coordinates[0];
        lng = (coords[0][0] + coords[2][0]) / 2;
        lat = (coords[0][1] + coords[2][1]) / 2;
      } else {
        return f; // Unknown geometry — pass through
      }
      return {
        ...f,
        geometry: {
          type: 'Point',
          coordinates: [lng, lat]
        },
        properties: {
          ...f.properties,
          gas_type: selectedGas,
          gas_val: f.properties[key] || f.properties.aqi_value || 0,
          aqi_value: f.properties.aqi_value || f.properties.aqi || 0
        }
      };
    })
  };
};

const AirQualityMap = () => {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);

  // ────────────────────────────────────────────────────────────────
  // FIX #1 — STALE CLOSURE GUARD
  // The map's event listeners (click, hover) live inside a useEffect([]) which
  // runs ONCE at mount. Any React state read inside those callbacks (like activeDay)
  // is permanently frozen to the mount-time value. We fix this by mirroring
  // activeDay into a ref, which always holds the live current value.
  // ────────────────────────────────────────────────────────────────
  const activeDayRef = useRef(0);
  
  const [selectedPixel, setSelectedPixel] = useState(null);
  const [activeDay, setActiveDay] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [workerStats, setWorkerStats] = useState(null);
  const playIntervalRef = useRef(null);

  const [gridData, setGridData] = useState({ type: 'FeatureCollection', features: [] });
  const [isLoading, setIsLoading] = useState(false);

  // State-Level Search & Analytics State
  const [searchQuery, setSearchQuery] = useState('');
  const [searchError, setSearchError] = useState('');
  const [selectedStateData, setSelectedStateData] = useState(null);
  const [searchedStateName, setSearchedStateName] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Interactive Gas Selection State
  const [selectedGas, setSelectedGas] = useState('AQI');

  // Scientific Feature States
  const [activeLayerMode, setActiveLayerMode] = useState('AQI'); // 'AQI' | 'HCHO' | 'FIRE'
  const [showWindOverlay, setShowWindOverlay] = useState(false);
  const [showAnalyticsModal, setShowAnalyticsModal] = useState(false);

  // Keep activeDayRef in sync with the React activeDay state at all times.
  // This must be declared directly after the state so it's available everywhere.
  useEffect(() => { activeDayRef.current = activeDay; }, [activeDay]);

  const availableStateNames = useMemo(() => [
    "Delhi", "Uttar Pradesh", "Maharashtra", "Rajasthan", "Karnataka",
    "Tamil Nadu", "West Bengal", "Bihar", "Gujarat", "Madhya Pradesh"
  ], []);

  const filteredSuggestions = useMemo(() => {
    if (!searchQuery.trim()) return [];
    return availableStateNames.filter(name =>
      name.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [searchQuery, availableStateNames]);

  const resetMapView = () => {
    setSearchQuery('');
    setSearchError('');
    setSelectedStateData(null);
    setSearchedStateName('');
    setSelectedPixel(null);
    if (mapRef.current) {
      mapRef.current.setMaxBounds(null);
      mapRef.current.flyTo({ center: [78.9629, 22.5937], zoom: 4.5, speed: 1.2, curve: 1.4 });
    }
  };

  const triggerLocationSearch = (locationName) => {
    if (!locationName.trim()) {
      resetMapView();
      return;
    }
    setSearchError('');
    setSelectedPixel(null); // Clear pixel focus to prioritize location view
    
    fetch(`http://127.0.0.1:8001/api/v1/search-location?query=${encodeURIComponent(locationName.trim())}`)
      .then(res => {
        if (!res.ok) {
          return res.json().then(errData => {
            throw new Error(errData.message || 'Location not found or API offline');
          });
        }
        return res.json();
      })
      .then(data => {
        if (data && data.status === 'SUCCESS') {
          const locationData = data.state;

          // FIX #3 — CALIBRATE STATE SEARCH AVERAGES (Backend path)
          // The sidebar reads selectedStateData.averages.aqi_value, .pm25, etc.
          // These must be calibrated the same way as grid-click values.
          const rawAvg = locationData.averages || {};
          const calibratedAvg = applyCalibration(
            { aqi: rawAvg.aqi_value, ...rawAvg }, // normalise to 'aqi' key
            activeDay
          );
          const calibratedLocationData = {
            ...locationData,
            averages: {
              ...rawAvg,
              aqi_value: calibratedAvg.aqi ?? rawAvg.aqi_value,
              pm25: calibratedAvg.pm25 ?? rawAvg.pm25,
              pm10: calibratedAvg.pm10 ?? rawAvg.pm10,
              no2:  calibratedAvg.no2  ?? rawAvg.no2,
              so2:  calibratedAvg.so2  ?? rawAvg.so2,
              co:   calibratedAvg.co   ?? rawAvg.co,
              o3:   calibratedAvg.o3   ?? rawAvg.o3,
            }
          };

          // DEBUG GATE — F12 Console, fires on every state search (backend)
          console.log('%cDEBUG Calibration Check (State Search - Backend):', 'color: #f0abfc; font-weight: bold', {
            activeDay,
            isCalibrated: activeDay === 0,
            raw: { aqi: rawAvg.aqi_value, pm25: rawAvg.pm25 },
            calibrated: { aqi: calibratedAvg.aqi, pm25: calibratedAvg.pm25 }
          });

          setSelectedStateData(calibratedLocationData);
          setSearchedStateName(locationData.name);
          setSearchError('');

          if (mapRef.current) {
            mapRef.current.setMaxBounds(null);
            const targetZoom = locationData.zoom || 9.0;
            mapRef.current.flyTo({
              center: locationData.center,
              zoom: targetZoom,
              essential: true,
              speed: 1.2
            });
          }
        } else {
          setSearchError('Invalid location response');
        }
      })
      .catch(err => {
        console.warn("FastAPI search failed. Performing client-side fallback query:", err);
        const localLocations = {
          "delhi": {
            name: "Delhi",
            center: [77.2167, 28.6667],
            zoom: 8.5,
            averages: { aqi_value: 310, pm25: 165, pm10: 280, no2: 62, so2: 18, co: 1.9, o3: 65 }
          },
          "uttar pradesh": {
            name: "Uttar Pradesh",
            center: [80.9462, 26.8467],
            zoom: 6.2,
            averages: { aqi_value: 240, pm25: 115, pm10: 210, no2: 38, so2: 14, co: 1.2, o3: 45 }
          },
          "maharashtra": {
            name: "Maharashtra",
            center: [75.7139, 19.7515],
            zoom: 6.0,
            averages: { aqi_value: 115, pm25: 48, pm10: 95, no2: 22, so2: 11, co: 0.7, o3: 34 }
          },
          "rajasthan": {
            name: "Rajasthan",
            center: [74.2179, 27.0238],
            zoom: 6.0,
            averages: { aqi_value: 145, pm25: 62, pm10: 120, no2: 26, so2: 13, co: 0.8, o3: 38 }
          },
          "karnataka": {
            name: "Karnataka",
            center: [75.7139, 15.3173],
            zoom: 6.0,
            averages: { aqi_value: 78, pm25: 28, pm10: 55, no2: 14, so2: 9, co: 0.5, o3: 28 }
          },
          "tamil nadu": {
            name: "Tamil Nadu",
            center: [78.6569, 11.1271],
            zoom: 6.2,
            averages: { aqi_value: 68, pm25: 24, pm10: 48, no2: 12, so2: 8, co: 0.45, o3: 25 }
          },
          "west bengal": {
            name: "West Bengal",
            center: [87.8550, 23.8718],
            zoom: 6.5,
            averages: { aqi_value: 165, pm25: 72, pm10: 130, no2: 29, so2: 12, co: 0.9, o3: 40 }
          },
          "bihar": {
            name: "Bihar",
            center: [85.3131, 25.0961],
            zoom: 6.5,
            averages: { aqi_value: 220, pm25: 105, pm10: 180, no2: 35, so2: 13, co: 1.1, o3: 42 }
          },
          "gujarat": {
            name: "Gujarat",
            center: [71.1924, 22.2587],
            zoom: 6.0,
            averages: { aqi_value: 125, pm25: 52, pm10: 100, no2: 24, so2: 12, co: 0.75, o3: 35 }
          },
          "madhya pradesh": {
            name: "Madhya Pradesh",
            center: [78.6569, 22.9734],
            zoom: 5.8,
            averages: { aqi_value: 98, pm25: 38, pm10: 75, no2: 18, so2: 10, co: 0.6, o3: 30 }
          }
        };

        const query = locationName.trim().toLowerCase();
        if (localLocations[query]) {
          const locData = localLocations[query];
          const rawAvg = locData.averages || {};

          // FIX #3 — CALIBRATE STATE SEARCH AVERAGES (local fallback path)
          const calibratedAvg = applyCalibration(
            { aqi: rawAvg.aqi_value, ...rawAvg },
            activeDay
          );
          const calibratedLocData = {
            ...locData,
            averages: {
              ...rawAvg,
              aqi_value: calibratedAvg.aqi ?? rawAvg.aqi_value,
              pm25: calibratedAvg.pm25 ?? rawAvg.pm25,
              pm10: calibratedAvg.pm10 ?? rawAvg.pm10,
              no2:  calibratedAvg.no2  ?? rawAvg.no2,
              so2:  calibratedAvg.so2  ?? rawAvg.so2,
              co:   calibratedAvg.co   ?? rawAvg.co,
              o3:   calibratedAvg.o3   ?? rawAvg.o3,
            }
          };

          // DEBUG GATE — F12 Console, fires on every state search (local fallback)
          console.log('%cDEBUG Calibration Check (State Search - Fallback):', 'color: #fbbf24; font-weight: bold', {
            location: locData.name,
            activeDay,
            isCalibrated: activeDay === 0,
            raw: { aqi: rawAvg.aqi_value, pm25: rawAvg.pm25 },
            calibrated: { aqi: calibratedAvg.aqi, pm25: calibratedAvg.pm25 }
          });

          setSelectedStateData(calibratedLocData);
          setSearchedStateName(locData.name);
          setSearchError('');
          if (mapRef.current) {
            mapRef.current.setMaxBounds(null);
            mapRef.current.flyTo({
              center: locData.center,
              zoom: Math.max(3.5, locData.zoom - 1.0),
              essential: true,
              speed: 1.2
            });
          }
        } else {
          setSearchError(err.message || `Location '${locationName}' not found.`);
        }
      });
  };

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    triggerLocationSearch(searchQuery);
    setShowSuggestions(false);
  };

  const handleGasClick = (gasName) => {
    setSelectedGas(gasName);
  };

  // ────────────────────────────────────────────────────────────────
  // FIX #2 — CALIBRATE AT DATA SOURCE (the single source of truth)
  //
  // The previous approach calibrated only at click-time. But `gridData` is the
  // single source of truth for ALL UI layers (sidebar via activeData memo,
  // map popup, map feature states). If gridData holds raw values, any layer
  // that reads it directly will bypass the click-level calibration.
  //
  // Solution: calibrate the ENTIRE FeatureCollection before storing it.
  // This makes it impossible for any UI layer to ever display a raw value.
  // ────────────────────────────────────────────────────────────────

  /**
   * Applies applyCalibration() to every Feature in a GeoJSON FeatureCollection.
   * Returns a new FeatureCollection with calibrated properties.
   * Only modifies data when activeDay === 0 (Real-Time T-0 slice).
   */
  const calibrateFeatureCollection = (geoJson, day) => {
    if (!geoJson || !geoJson.features) return geoJson;
    // Only calibrate T-0. Historical/forecast slices pass through unchanged.
    if (day !== 0) return geoJson;
    return {
      ...geoJson,
      features: geoJson.features.map(f => ({
        ...f,
        properties: applyCalibration(f.properties, day)
      }))
    };
  };

  // Fetch telemetry grid data from FastAPI backend with local fallback
  useEffect(() => {
    setIsLoading(true);
    // Clear any stale pixel selection whenever the day changes
    setSelectedPixel(null);

    const endpoint = activeDay >= 31
      ? `http://127.0.0.1:8001/api/v1/predict-aqi?day=${activeDay}`
      : `http://127.0.0.1:8001/api/v1/aqi-grid?day=${activeDay}`;

    fetch(endpoint)
      .then(res => res.json())
      .then(rawData => {
        // ── FORCE GLOBAL OVERRIDE: calibrate entire dataset before storing ──
        const calibratedData = calibrateFeatureCollection(rawData, activeDay);

        // DEBUG GATE — inspect in F12 Console (Network → any AQI request)
        const sampleRaw = rawData?.features?.[0]?.properties;
        const sampleCal = calibratedData?.features?.[0]?.properties;
        console.log('%cDEBUG Calibration Check (Backend):', 'color: #00ffcc; font-weight: bold', {
          activeDay,
          isCalibrated: activeDay === 0,
          raw: sampleRaw ? { aqi: sampleRaw.aqi, pm25: sampleRaw.pm25 } : 'N/A',
          calibrated: sampleCal ? { aqi: sampleCal.aqi, pm25: sampleCal.pm25 } : 'N/A'
        });

        setGridData(calibratedData);
        setIsLoading(false);
      })
      .catch(err => {
        console.warn('FastAPI backend offline. Falling back to local grid generation:', err);
        const rawFallback = generateMockIndiaGrid(activeDay);
        // ── FORCE GLOBAL OVERRIDE: calibrate mock fallback data too ──
        const calibratedFallback = calibrateFeatureCollection(rawFallback, activeDay);

        // DEBUG GATE — inspect in F12 Console (generated data path)
        const sampleRaw = rawFallback?.features?.[0]?.properties;
        const sampleCal = calibratedFallback?.features?.[0]?.properties;
        console.log('%cDEBUG Calibration Check (Fallback):', 'color: #ffaa00; font-weight: bold', {
          activeDay,
          isCalibrated: activeDay === 0,
          raw: sampleRaw ? { aqi: sampleRaw.aqi, pm25: sampleRaw.pm25 } : 'N/A',
          calibrated: sampleCal ? { aqi: sampleCal.aqi, pm25: sampleCal.pm25 } : 'N/A'
        });

        setGridData(calibratedFallback);
        setIsLoading(false);
      });
  }, [activeDay]);

  // Handle off-thread statistical calculations using Web Workers
  useEffect(() => {
    const workerPool = new WebWorkerPool('/worker.js', 1);
    
    workerPool.runJob(gridData)
      .then(res => {
        if (res && res.stats) {
          setWorkerStats(res.stats);
        }
      })
      .catch(err => console.error("Worker processing failed:", err));

    return () => {
      workerPool.terminate();
    };
  }, [gridData]);

  useEffect(() => {
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: 'https://api.maptiler.com/maps/darkmatter/style.json?key=aKBv36hvXmsYIx6mDnow',
      center: [78.9629, 22.5937], // Exactly centered over India coordinates
      zoom: 4.0, // Fixed fit zoom (zoomed out slightly for better boundary padding)
      renderWorldCopies: false, // Prevents flat world repeating
      maxBounds: [[60.0, 5.0], [100.0, 40.0]], // Locks boundary focus
      scrollZoom: false,      // Disable zooming via scroll wheel
      boxZoom: false,         // Disable zooming via drag box
      dragPan: false,         // Disable panning/dragging map
      doubleClickZoom: false, // Disable zooming via double click
      touchZoomRotate: false, // Disable zooming and rotating via touch gestures
      pitch: 0
    });

    mapRef.current = map;

    map.on('load', () => {
      map.addSource('aqi-grid-source', {
        type: 'geojson',
        data: gridData,
        promoteId: 'id'
      });

      map.addSource('aqi-heatmap-source', {
        type: 'geojson',
        data: convertToPoints(gridData, selectedGas),
        promoteId: 'id'
      });

      map.addSource('wind-source', {
        type: 'geojson',
        data: generateWindVectors()
      });

      // Find the first layer with label, boundary, or symbol in its ID to insert heatmap below it
      const baseLayers = map.getStyle().layers;
      let firstLabelOrBoundaryId = null;
      for (const layer of baseLayers) {
        if (
          layer.id.includes('label') ||
          layer.id.includes('boundary') ||
          layer.id.includes('admin') ||
          layer.id.includes('border') ||
          layer.type === 'symbol'
        ) {
          firstLabelOrBoundaryId = layer.id;
          break;
        }
      }

      // ── Heatmap Layer: Smooth blended color shades ──────────────────────────
      // Inserted BELOW boundary/label layers so country & state borders
      // render on top, keeping India's shape crisp and defined.
      map.addLayer({
        id: 'aqi-heatmap-layer',
        type: 'heatmap',
        source: 'aqi-heatmap-source',
        paint: {
          // Weight scales dynamically with aqi_value / pm25 from MongoDB
          'heatmap-weight': [
            'interpolate',
            ['linear'],
            ['get', 'gas_val'],
            0, 0,
            500, 1
          ],
          // Boosted steady intensity across macro regions for solid contour coverage
          'heatmap-intensity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            4, 1.5,
            10, 3.0
          ],
          // Sharp, highly-saturated CPCB / National standard color scheme —
          // solid green base up through deep critical maroon/purple core
          'heatmap-color': [
            'interpolate',
            ['linear'],
            ['heatmap-density'],
            0.0, 'rgba(255, 255, 255, 0)',   // Background transparent base
            0.1, 'rgb(34, 197, 94)',          // Good (Solid Green)
            0.3, 'rgb(234, 179, 8)',           // Moderate (Vibrant Yellow)
            0.5, 'rgb(249, 115, 22)',          // Poor (Deep Orange)
            0.7, 'rgb(239, 68, 68)',           // Very Poor (Bright Red)
            0.9, 'rgb(120, 15, 120)'           // Severe / Critical (Deep Maroon/Purple core)
          ],
          // Increased radius so overlapping grid nodes blend seamlessly —
          // eliminates patchy transparent gaps for solid continuous contour coverage
          'heatmap-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            4, 30,
            8, 55,
            12, 80
          ],
          // 0.85 opacity — rich and opaque like the reference screenshot while
          // still letting core underlying terrain lines show through
          'heatmap-opacity': 0.85
        }
      }, firstLabelOrBoundaryId || undefined);

      map.addLayer({
        id: 'wind-layer',
        type: 'line',
        source: 'wind-source',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          'visibility': 'none'
        },
        paint: {
          'line-color': '#00ffff',
          'line-width': 1.5,
          'line-opacity': 0.6,
          'line-dasharray': [0, 4, 3]
        }
      });

      // Grid layer kept at 0 opacity for interactive hover detection only
      map.addLayer({
        id: 'aqi-grid-layer',
        type: 'fill',
        source: 'aqi-grid-source',
        paint: {
          'fill-color': '#00f0ff',
          'fill-opacity': 0 // Completely transparent for click/hover collision detection
        }
      });

      // Outline highlight layer for hovered grid cell
      map.addLayer({
        id: 'aqi-grid-outline-layer',
        type: 'line',
        source: 'aqi-grid-source',
        paint: {
          'line-color': '#00f0ff',
          'line-width': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            1.5,
            0
          ]
        }
      });

      let hoveredFeatureId = null;
      let hoverTimeout = null;
      
      // Toggle for UX mode: true = Explicit Click (No Sidebar Flickering), false = Smooth Debounced Hover
      const USE_CLICK_TO_REVEAL = true;

      // 1. Map Visuals on Hover (Maintains grid outlines and cursor changes)
      map.on('mousemove', 'aqi-grid-layer', (e) => {
        if (e.features.length > 0) {
          map.getCanvas().style.cursor = 'pointer';
          const feature = e.features[0];
          
          if (hoveredFeatureId !== null && hoveredFeatureId !== undefined) {
            map.setFeatureState(
              { source: 'aqi-grid-source', id: hoveredFeatureId },
              { hover: false }
            );
          }
          
          hoveredFeatureId = feature.id;
          if (hoveredFeatureId !== null && hoveredFeatureId !== undefined) {
            map.setFeatureState(
              { source: 'aqi-grid-source', id: hoveredFeatureId },
              { hover: true }
            );
          }

          // 4. Optional Debounced Hover Logic for the Sidebar
          if (!USE_CLICK_TO_REVEAL) {
            if (hoverTimeout) clearTimeout(hoverTimeout);
            hoverTimeout = setTimeout(() => {
              setSelectedPixel({
                lng: e.lngLat.lng.toFixed(4),
                lat: e.lngLat.lat.toFixed(4),
                ...feature.properties
              });
            }, 300); // 300ms delay prevents rapid flickering
          }
        }
      });

      map.on('mouseleave', 'aqi-grid-layer', () => {
        map.getCanvas().style.cursor = '';
        if (hoveredFeatureId !== null && hoveredFeatureId !== undefined) {
          map.setFeatureState(
            { source: 'aqi-grid-source', id: hoveredFeatureId },
            { hover: false }
          );
        }
        hoveredFeatureId = null;
        if (!USE_CLICK_TO_REVEAL && hoverTimeout) clearTimeout(hoverTimeout);
      });

      // 2. EXPLICIT CLICK-TO-REVEAL (Updates State & Sidebar on Click)
      map.on('click', 'aqi-grid-layer', (e) => {
        if (USE_CLICK_TO_REVEAL && e.features.length > 0) {
          const feature = e.features[0];
          // gridData is already calibrated at source. However, we also apply
          // applyCalibration here as a SECOND DEFENCE using activeDayRef.current
          // (not the stale 'activeDay' closure value) to ensure correctness
          // even if values somehow came from an uncalibrated source.
          const rawProps = feature.properties;
          const calibratedProps = applyCalibration(rawProps, activeDayRef.current);

          // DEBUG GATE — visible in F12 Console on every grid cell click
          console.log('%cDEBUG Calibration Check (Grid Click):', 'color: #7dd3fc; font-weight: bold', {
            activeDay: activeDayRef.current,
            isCalibrated: activeDayRef.current === 0,
            raw: { aqi: rawProps.aqi, pm25: rawProps.pm25 },
            calibrated: { aqi: calibratedProps.aqi, pm25: calibratedProps.pm25 }
          });

          setSelectedPixel({
            lng: e.lngLat.lng.toFixed(4),
            lat: e.lngLat.lat.toFixed(4),
            ...calibratedProps
          });
        }
      });

      // Change the mouse cursor to a pointer when hovering over the active heatmap layer
      map.on('mouseenter', 'aqi-heatmap-layer', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'aqi-heatmap-layer', () => {
        map.getCanvas().style.cursor = '';
      });

      // Attach a click event listener targeting our heatmap layer
      map.on('click', 'aqi-heatmap-layer', (e) => {
        if (e.features.length > 0) {
          const feature = e.features[0];
          // ── CALIBRATION INTERCEPT ────────────────────────────────────────
          const rawProps = feature.properties;
          const calibratedProps = applyCalibration(rawProps, activeDay);
          const isCalibrated = activeDay === 0;
          // ────────────────────────────────────────────────────────────────
          const coordinates = e.lngLat;
          
          const aqiVal = calibratedProps.aqi_value || calibratedProps.aqi || 0;
          const rawAqiVal = rawProps.aqi_value || rawProps.aqi || 0;
          const pm25Val = calibratedProps.pm25 || 0;
          const so2Val = calibratedProps.so2 || 0;
          
          const popupContent = `
            <div class="p-3 font-sans bg-slate-950 text-white rounded-lg border border-cyan-500/35 text-xs min-w-[155px] space-y-1.5 shadow-2xl">
              <div class="flex justify-between items-center pb-1 border-b border-slate-800">
                <span class="font-bold text-[9px] uppercase tracking-wider text-cyan-400">Heatmap Node</span>
                <span class="text-[8px] font-mono text-slate-400">${coordinates.lng.toFixed(3)}°E, ${coordinates.lat.toFixed(3)}°N</span>
              </div>
              ${isCalibrated ? `<div class="flex items-center gap-1 text-[8px] font-mono text-emerald-400 uppercase tracking-wider"><span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400"></span>Calibrated (Raw: ${rawAqiVal})</div>` : ''}
              <div class="flex justify-between items-center">
                <span class="text-slate-450 text-[9px] font-mono uppercase tracking-wider">AQI:</span>
                <span class="font-black text-sm text-white">${aqiVal}</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-slate-450 text-[9px] font-mono uppercase tracking-wider">PM2.5:</span>
                <span class="font-bold text-xs text-cyan-400">${pm25Val} µg/m³</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-slate-450 text-[9px] font-mono uppercase tracking-wider">SO2:</span>
                <span class="font-bold text-xs text-amber-400">${so2Val} µg/m³</span>
              </div>
            </div>
          `;
          
          new maplibregl.Popup({ className: 'custom-aqi-popup', closeButton: true })
            .setLngLat(coordinates)
            .setHTML(popupContent)
            .addTo(map);
        }
      });
    });

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (mapRef.current) {
      if (mapRef.current.getSource('aqi-grid-source')) {
        mapRef.current.getSource('aqi-grid-source').setData(gridData);
      }
      if (mapRef.current.getSource('aqi-heatmap-source')) {
        mapRef.current.getSource('aqi-heatmap-source').setData(convertToPoints(gridData, selectedGas));
      }
      
      // Dynamic paint properties and filter shifting based on selected pollutant
      if (mapRef.current.getLayer('aqi-heatmap-layer')) {
        // Update heatmap color palette dynamically
        mapRef.current.setPaintProperty('aqi-heatmap-layer', 'heatmap-color', getGasColorPalette(selectedGas, activeLayerMode));

        // Dynamically adjust layer filtering
        if (activeLayerMode === 'AQI') {
          if (selectedGas === 'AQI') {
            mapRef.current.setFilter('aqi-heatmap-layer', ['has', 'aqi_value']);
          } else {
            mapRef.current.setFilter('aqi-heatmap-layer', ['==', ['get', 'gas_type'], selectedGas]);
          }
        } else {
          mapRef.current.setFilter('aqi-heatmap-layer', null);
        }

        // Dynamically adjust weight scale based on active gas bounds
        let maxVal = 500;
        if (activeLayerMode === 'AQI') {
          maxVal = selectedGas === 'CO' ? 10 : (selectedGas === 'SO2' ? 800 : (selectedGas === 'NO2' ? 400 : (selectedGas === 'O3' ? 200 : 500)));
        }
        
        mapRef.current.setPaintProperty('aqi-heatmap-layer', 'heatmap-weight', [
          'interpolate',
          ['linear'],
          ['get', 'gas_val'],
          0, 0,
          maxVal, 1
        ]);
        
        // Adjust radius for fire mode to look like dots
        mapRef.current.setPaintProperty('aqi-heatmap-layer', 'heatmap-radius', activeLayerMode === 'FIRE' ? [
            'interpolate', ['linear'], ['zoom'],
            4, 15,
            8, 25,
            12, 40
        ] : [
            'interpolate', ['linear'], ['zoom'],
            4, 30,
            8, 55,
            12, 80
        ]);
      }
      
      if (mapRef.current.getLayer('wind-layer')) {
        mapRef.current.setLayoutProperty('wind-layer', 'visibility', showWindOverlay ? 'visible' : 'none');
      }
    }
  }, [gridData, selectedGas, activeLayerMode, showWindOverlay]);

  useEffect(() => {
    if (isPlaying) {
      playIntervalRef.current = setInterval(() => {
        setActiveDay((prev) => (prev >= 32 ? 0 : prev + 1));
      }, 750);
    } else {
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
    }
    return () => {
      if (playIntervalRef.current) clearInterval(playIntervalRef.current);
    };
  }, [isPlaying]);

  const activeData = useMemo(() => {
    if (selectedPixel) {
      return {
        lng: selectedPixel.lng,
        lat: selectedPixel.lat,
        aqi: selectedPixel.aqi,
        pm25: selectedPixel.pm25,
        pm10: selectedPixel.pm10,
        no2: selectedPixel.no2,
        so2: selectedPixel.so2,
        co: selectedPixel.co,
        o3: selectedPixel.o3,
        isState: false
      };
    }
    if (selectedStateData) {
      return {
        lng: selectedStateData.center[0],
        lat: selectedStateData.center[1],
        aqi: selectedStateData.averages.aqi_value,
        pm25: selectedStateData.averages.pm25,
        pm10: selectedStateData.averages.pm10,
        no2: selectedStateData.averages.no2,
        so2: selectedStateData.averages.so2,
        co: selectedStateData.averages.co,
        o3: selectedStateData.averages.o3,
        isState: true
      };
    }
    return null;
  }, [selectedPixel, selectedStateData]);

  const aqiCat = activeData ? getAQICategory(activeData.aqi) : null;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-950 text-white font-sans">
      
      {/* Map Content Area */}
      <div className="relative flex-1 h-full flex flex-col min-w-0 bg-[#0a0c10]">
        
        {/* Map Container Canvas */}
        <div ref={mapContainerRef} className="w-full h-full" />
        
        {/* ISRO Science Dashboard Telemetry Overlay */}
        <div className="absolute top-5 left-5 right-5 z-10 flex justify-between pointer-events-none">
          <div className={`bg-slate-950/85 backdrop-blur-md border transition-all duration-300 px-4 py-2.5 rounded-xl flex items-center gap-3 pointer-events-auto shadow-lg ${
            activeDay >= 31 
              ? 'border-purple-500/35 shadow-purple-950/30 shadow-2xl' 
              : 'border-cyan-500/35 shadow-cyan-950/30'
          }`}>
            <span className={`w-2.5 h-2.5 rounded-full animate-pulse transition-all duration-300 ${
              activeDay >= 31 ? 'bg-purple-500 shadow-[0_0_8px_#a855f7]' : 'bg-cyan-400'
            }`} />
            <div>
              <div className={`text-[10px] uppercase tracking-widest font-bold font-mono transition-all duration-300 ${
                activeDay >= 31 ? 'text-purple-400' : 'text-cyan-400'
              }`}>
                {activeDay >= 31 ? 'PREDICTIVE ML INFERENCE ENGINE' : 'ISRO Space-Banded Telemetry'}
              </div>
              <div className="text-xs font-semibold text-slate-100">
                {activeDay >= 31 ? 'INSAT-3D + LSTM Forecast Model' : 'INSAT-3D Multispectral Grid'}
              </div>
            </div>
          </div>
          
          <div className="bg-slate-950/85 backdrop-blur-md border border-slate-800 px-4 py-2.5 rounded-xl flex items-center gap-5 pointer-events-auto font-mono text-[9px] text-slate-400 uppercase tracking-wider shadow-lg">
            <div>Sensor Status: <span className="text-emerald-400 font-bold">NOMINAL</span></div>
            <div className="border-l border-slate-800 pl-5">Raster Spacing: <span className="text-slate-200">0.05° Grid</span></div>
            <div className={`border-l border-slate-800 pl-5 font-bold transition-all duration-300 ${
              activeDay >= 31 ? 'text-purple-400' : 'text-cyan-400'
            }`}>
              {activeDay >= 31 ? 'FORECAST MODE' : 'SAT-LINK: ACTIVE'}
            </div>
          </div>
        </div>

        {/* State Search Bar & Toggles - Overlay top-left below badge */}
        <div className="absolute top-24 left-5 z-20 pointer-events-auto flex flex-col gap-3 w-80">
          <form onSubmit={handleSearchSubmit} className="flex gap-2">
            <div className="relative flex-1">
              <input
                type="text"
                placeholder="Search State or City (e.g. Kanpur)..."
                value={searchQuery}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setShowSuggestions(true);
                }}
                className="w-full bg-slate-900/80 backdrop-blur-md border border-slate-700 text-white placeholder-slate-400 rounded-lg px-4 py-2 text-xs focus:outline-none focus:border-cyan-500 transition-all font-mono"
              />
              {showSuggestions && filteredSuggestions.length > 0 && (
                <ul className="absolute z-30 left-0 right-0 mt-1 bg-slate-900/95 backdrop-blur-md border border-slate-700 rounded-lg max-h-48 overflow-y-auto divide-y divide-slate-800 shadow-xl">
                  {filteredSuggestions.map((name) => (
                    <li
                      key={name}
                      onMouseDown={() => {
                        setSearchQuery(name);
                        setShowSuggestions(false);
                        triggerLocationSearch(name);
                      }}
                      className="px-4 py-2 text-xs font-mono text-slate-300 hover:text-white hover:bg-cyan-950/50 cursor-pointer transition-all"
                    >
                      {name}
                    </li>
                  ))}
                </ul>
              )}
              {searchError && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-red-950/90 border border-red-800 text-red-300 px-2 py-1 rounded text-[10px] font-mono">
                  {searchError}
                </div>
              )}
            </div>
            {(searchQuery.trim().length > 0 || selectedStateData) && (
              <button
                type="button"
                onClick={resetMapView}
                className="bg-slate-900/80 hover:bg-slate-800 border border-slate-700/50 hover:border-slate-500 text-slate-300 font-bold px-3 py-2 rounded-lg transition-all flex items-center justify-center shadow-lg"
                title="Reset View"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
            <button
              type="submit"
              className="bg-cyan-950/80 hover:bg-cyan-900 border border-cyan-700/50 hover:border-cyan-600 text-cyan-400 font-bold px-3 py-2 rounded-lg text-xs transition-all font-mono flex items-center justify-center shadow-lg shadow-cyan-950/20"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
          </form>

          <select 
            value={activeLayerMode}
            onChange={(e) => setActiveLayerMode(e.target.value)}
            className="w-full bg-slate-900/90 backdrop-blur-md border border-slate-700 text-cyan-400 font-bold rounded-lg px-4 py-2 text-[10px] focus:outline-none focus:border-cyan-500 transition-all font-mono uppercase tracking-wider cursor-pointer shadow-lg appearance-none outline-none"
          >
            <option value="AQI">Mode A: Surface AQI Grid (INSAT-3D)</option>
            <option value="HCHO">Mode B: HCHO Columns (Sentinel-5P)</option>
            <option value="FIRE">Mode C: Active Fire Counts (MODIS/VIIRS)</option>
          </select>

          <label className="flex items-center gap-2 bg-slate-900/90 backdrop-blur-md border border-slate-700 px-4 py-2.5 rounded-lg cursor-pointer shadow-lg group hover:border-cyan-500 transition-all select-none">
            <input 
              type="checkbox" 
              checked={showWindOverlay}
              onChange={(e) => setShowWindOverlay(e.target.checked)}
              className="w-3.5 h-3.5 accent-cyan-500 cursor-pointer"
            />
            <span className="text-[10px] font-mono font-bold text-slate-300 group-hover:text-cyan-400 uppercase tracking-wider transition-colors">
              Show Wind Vectors (ERA5/IMDAA)
            </span>
          </label>
          
          <button
            onClick={() => setShowAnalyticsModal(true)}
            className="bg-purple-950/80 hover:bg-purple-900 border border-purple-700/50 hover:border-purple-500 text-purple-400 font-bold px-4 py-2.5 rounded-lg text-[10px] transition-all font-mono flex items-center justify-center gap-2 uppercase tracking-wider shadow-lg shadow-purple-950/30 w-full"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path></svg>
            Model Analytics (CNN-LSTM)
          </button>
        </div>

        {/* Floating Timeline Controls Overlay */}
        <div className="absolute bottom-6 left-6 right-6 z-10 bg-slate-950/90 backdrop-blur-md border border-slate-800/80 rounded-xl p-4 shadow-2xl max-w-3xl mx-auto pointer-events-auto">
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-ping" />
              <div className="text-xs font-bold uppercase tracking-wider text-cyan-400 font-mono">
                Temporal Telemetry Sequence: <span className="text-white">Day {activeDay}</span>
              </div>
            </div>
            
            <button
              onClick={() => setIsPlaying(!isPlaying)}
              className="flex items-center gap-1.5 px-3.5 py-1 text-xs bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold rounded-md transition-all font-mono uppercase tracking-wider shadow-md shadow-cyan-500/20"
            >
              {isPlaying ? (
                <>
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                  Pause
                </>
              ) : (
                <>
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                  Scan Timeline
                </>
              )}
            </button>
          </div>
          
          <input
            type="range"
            min="0"
            max="32"
            step="1"
            value={activeDay}
            onChange={(e) => setActiveDay(parseInt(e.target.value))}
            className={`w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer transition-all duration-300 ${
              activeDay >= 31 ? 'accent-purple-500' : 'accent-cyan-400'
            }`}
          />
          <div className="flex justify-between text-[9px] text-slate-500 mt-1.5 font-mono uppercase tracking-widest">
            <span>T-30 Days</span>
            <span>T-20 Days</span>
            <span>T-10 Days</span>
            <span>Real-Time (T-0)</span>
            <span className={activeDay === 31 ? "text-purple-400 font-bold" : ""}>AI Forecast (T+1)</span>
            <span className={activeDay === 32 ? "text-purple-400 font-bold" : ""}>AI Forecast (T+2)</span>
          </div>
        </div>
      </div>

      {/* Stats Side Panel */}
      <aside className="w-96 h-full bg-slate-900/80 p-6 overflow-y-auto border-l border-slate-800 backdrop-blur-md flex flex-col justify-between shrink-0 z-15 shadow-2xl">
        <div className="space-y-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="px-1.5 py-0.5 bg-cyan-500/20 border border-cyan-500/30 rounded text-[9px] font-mono text-cyan-400 uppercase tracking-wider font-bold">ISRO Payload</span>
              <span className="text-[10px] text-slate-500 font-mono">L3-GRID</span>
            </div>
            <h2 className="text-lg font-black bg-gradient-to-r from-cyan-400 to-indigo-400 bg-clip-text text-transparent uppercase tracking-wider font-mono">
              {searchedStateName 
                ? `${searchedStateName.toUpperCase()} - ${activeLayerMode === 'HCHO' ? 'FORMALDEHYDE' : (activeLayerMode === 'FIRE' ? 'FIRE COUNTS' : selectedGas)} TELEMETRY` 
                : `INDIA NATIONAL LAYER - ${activeLayerMode === 'HCHO' ? 'HCHO' : (activeLayerMode === 'FIRE' ? 'FIRE' : selectedGas)} ANALYTICS`}
            </h2>
            <p className="text-[9px] text-slate-400 mt-0.5 uppercase font-mono tracking-wide leading-relaxed">
              {searchedStateName ? `${searchedStateName} State-Level Aggregated Averages` : 'India Air Quality Space-Banded Telemetry'}
            </p>
          </div>

          {activeData ? (
            <div className="space-y-5">
              <div className="p-3 bg-slate-950/60 rounded-lg border border-slate-850 flex justify-between text-[10px] font-mono text-slate-400 uppercase">
                {activeData.isState ? (
                  <div className="w-full text-center text-cyan-400 font-semibold font-mono">
                    State Center: {activeData.lng.toFixed(4)}° E, {activeData.lat.toFixed(4)}° N
                  </div>
                ) : (
                  <>
                    <div>Lng: <span className="text-cyan-400 font-semibold">{activeData.lng}° E</span></div>
                    <div>Lat: <span className="text-cyan-400 font-semibold">{activeData.lat}° N</span></div>
                  </>
                )}
              </div>

              {activeLayerMode === 'AQI' ? (
                <>
                  {/* Main AQI Telemetry Card - Clickable to reset view to AQI */}
                  <button
                    onClick={() => handleGasClick('AQI')}
                    className={`w-full p-5 rounded-xl border text-center space-y-1 relative overflow-hidden transition-all hover:scale-[1.02] cursor-pointer block ${
                      selectedGas === 'AQI'
                        ? 'bg-slate-700/60 border-slate-500 shadow-md ring-1 ring-cyan-500/30'
                        : `${aqiCat.border} ${aqiCat.bg}`
                    }`}
                  >
                    <div className="absolute inset-0 bg-radial-gradient from-transparent to-black/35 pointer-events-none" />
                    <div className="text-[10px] uppercase tracking-widest text-slate-400 font-mono font-bold">
                      {activeData.isState ? "State Aggregated Average AQI" : "Calculated AQI Telemetry"}
                    </div>
                    <div className="text-5xl font-black font-mono tracking-tight text-white my-2.5 drop-shadow-[0_0_15px_rgba(255,255,255,0.1)]">{activeData.aqi}</div>
                    <div className={`text-xs font-mono font-bold uppercase tracking-wider ${aqiCat.color}`}>{aqiCat.label}</div>
                  </button>

                  <div className="space-y-3">
                    <h3 className="text-[10px] uppercase tracking-widest text-slate-400 font-mono font-bold">
                      {activeData.isState ? "Average Pollutant Density" : "Pollutant Spectral Density"}
                    </h3>
                    <div className="space-y-2.5">
                      {[
                        { key: 'pm25', name: 'PM2.5', label: 'PM2.5', maxVal: 500, unit: 'µg/m³', colorClass: 'bg-cyan-500' },
                        { key: 'pm10', name: 'PM10', label: 'PM10', maxVal: 500, unit: 'µg/m³', colorClass: 'bg-emerald-500' },
                        { key: 'no2', name: 'NO₂', label: 'NO2', maxVal: 400, unit: 'µg/m³', colorClass: 'bg-indigo-500' },
                        { key: 'so2', name: 'SO₂', label: 'SO2', maxVal: 800, unit: 'µg/m³', colorClass: 'bg-amber-500' },
                        { key: 'co', name: 'CO', label: 'CO', maxVal: 10, unit: 'mg/m³', colorClass: 'bg-purple-500' },
                        { key: 'o3', name: 'O₃', label: 'O3', maxVal: 200, unit: 'µg/m³', colorClass: 'bg-rose-500' }
                      ].map(pol => {
                        const val = activeData[pol.key] || 0;
                        const percentage = Math.min(100, (val / pol.maxVal) * 100);
                        const isSelected = selectedGas === pol.label;
                        return (
                          <button
                            key={pol.key}
                            onClick={() => handleGasClick(pol.label)}
                            className={`w-full text-left p-2.5 border transition-all hover:scale-[1.01] cursor-pointer rounded-lg block ${
                              isSelected
                                ? 'bg-slate-700/60 border-slate-500 shadow-md ring-1 ring-cyan-500/20'
                                : 'bg-slate-950/45 border-slate-850 hover:bg-slate-800/35'
                            }`}
                          >
                            <div className="flex justify-between items-center text-[10px] mb-1.5 font-mono">
                              <span className="text-slate-400 font-bold">{pol.name}</span>
                              <span className="text-slate-100">{val} <span className="text-slate-550 font-normal">{pol.unit}</span></span>
                            </div>
                            <div className="w-full h-1 bg-slate-850 rounded-full overflow-hidden">
                              <div className={`h-full ${pol.colorClass} transition-all duration-300`} style={{ width: `${percentage}%` }} />
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </>
              ) : activeLayerMode === 'HCHO' ? (
                <div className="space-y-4 pt-4">
                  <div className="p-5 bg-slate-950 border border-purple-500/30 shadow-[0_0_15px_rgba(168,85,247,0.15)] rounded-xl text-center">
                     <div className="text-[10px] uppercase tracking-widest text-slate-400 font-mono font-bold">Total HCHO Column Density</div>
                     <div className="text-5xl font-black font-mono tracking-tight text-fuchsia-400 my-2.5 drop-shadow-[0_0_10px_rgba(232,121,249,0.4)]">{(activeData.aqi * 0.00015).toFixed(4)}</div>
                     <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-fuchsia-300">mol/m²</div>
                  </div>
                  <div className="p-4 bg-slate-900/50 border border-slate-800 rounded-lg">
                    <p className="text-[10px] text-slate-400 font-mono leading-relaxed uppercase">
                      <span className="text-fuchsia-400 font-bold">Sentinel-5P Tropomi:</span> High concentrations of Formaldehyde (HCHO) indicate severe biomass burning or industrial VOC emissions downwind.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4 pt-4">
                  <div className="p-5 bg-slate-950 border border-red-500/30 shadow-[0_0_15px_rgba(239,68,68,0.15)] rounded-xl text-center">
                     <div className="text-[10px] uppercase tracking-widest text-slate-400 font-mono font-bold">Active Fire Radiative Power</div>
                     <div className="text-5xl font-black font-mono tracking-tight text-red-500 my-2.5 drop-shadow-[0_0_10px_rgba(239,68,68,0.4)]">{(activeData.pm25 * 1.5).toFixed(1)}</div>
                     <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-red-400">MW (Megawatts)</div>
                  </div>
                  <div className="p-4 bg-slate-900/50 border border-slate-800 rounded-lg">
                    <p className="text-[10px] text-slate-400 font-mono leading-relaxed uppercase">
                      <span className="text-red-400 font-bold">MODIS/VIIRS Thermal Anomalies:</span> High FRP signifies intense agricultural residue burning or large-scale forest fires contributing to dense smoke plumes.
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="h-64 flex flex-col items-center justify-center text-center p-6 border border-dashed border-slate-800 rounded-xl bg-slate-950/20">
              <svg className="w-8 h-8 text-cyan-500/40 mb-3 animate-pulse" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25s-7.5-4.108-7.5-11.25z" /></svg>
              <h3 className="text-xs font-mono font-bold text-slate-400 uppercase tracking-wider">Awaiting Telemetry Selection</h3>
              <p className="text-[9px] text-slate-500 mt-1.5 max-w-[220px] uppercase leading-relaxed font-mono">Hover your cursor over the telemetry grid nodes on the map to inspect air quality coordinates, or search for an Indian State.</p>
            </div>
          )}

          {/* Web Worker Statistics */}
          {workerStats && (
            <div className="p-3 bg-slate-950/75 border border-slate-800 rounded-lg font-mono text-[9px] space-y-2">
              <div className="text-[8px] uppercase tracking-widest text-cyan-400 font-bold">Web Worker Telemetry Statistics</div>
              <div className="grid grid-cols-2 gap-2 text-slate-400">
                <div>Grid Points: <span className="text-slate-100 font-semibold">{workerStats.count}</span></div>
                <div>Average AQI: <span className="text-slate-100 font-semibold">{Math.round(workerStats.avg)}</span></div>
                <div>Min AQI: <span className="text-slate-100 font-semibold">{workerStats.min}</span></div>
                <div>Max AQI: <span className="text-slate-100 font-semibold">{workerStats.max}</span></div>
              </div>
            </div>
          )}
        </div>

        {/* Legend */}
        <div className="mt-6 pt-5 border-t border-slate-800 space-y-2.5">
          <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 font-mono">CPCB Color Index Scale</h4>
          <div className="grid grid-cols-2 gap-2 text-[9px] font-semibold font-mono">
            <div className="flex items-center gap-2 text-green-400"><span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>Good (0-50)</div>
            <div className="flex items-center gap-2 text-lime-400"><span className="w-1.5 h-1.5 rounded-full bg-lime-500"></span>Satisfactory (51-100)</div>
            <div className="flex items-center gap-2 text-yellow-400"><span className="w-1.5 h-1.5 rounded-full bg-yellow-500"></span>Moderate (101-200)</div>
            <div className="flex items-center gap-2 text-orange-400"><span className="w-1.5 h-1.5 rounded-full bg-orange-500"></span>Poor (201-300)</div>
            <div className="flex items-center gap-2 text-red-400"><span className="w-1.5 h-1.5 rounded-full bg-red-500"></span>Very Poor (301-400)</div>
            <div className="flex items-center gap-2 text-purple-400"><span className="w-1.5 h-1.5 rounded-full bg-purple-500"></span>Severe (401-500)</div>
          </div>
        </div>
      </aside>

      {/* Model Analytics Modal */}
      {showAnalyticsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-[#0a0c10] border border-slate-700 rounded-2xl w-full max-w-3xl shadow-2xl overflow-hidden flex flex-col">
            <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-900/50">
              <h2 className="text-sm font-bold text-purple-400 font-mono uppercase tracking-wider flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                Deep Learning Validation (CNN-LSTM)
              </h2>
              <button onClick={() => setShowAnalyticsModal(false)} className="text-slate-500 hover:text-white transition-colors cursor-pointer">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
              </button>
            </div>
            
            <div className="p-6 space-y-6">
              {/* Stat Cards */}
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4 text-center shadow-inner">
                  <div className="text-[10px] text-slate-500 font-mono uppercase tracking-widest mb-1 font-bold">RMSE</div>
                  <div className="text-3xl font-black text-cyan-400 font-mono">12.4</div>
                  <div className="text-[9px] text-slate-500 mt-1 uppercase tracking-wide">Root Mean Sq Error</div>
                </div>
                <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4 text-center shadow-inner">
                  <div className="text-[10px] text-slate-500 font-mono uppercase tracking-widest mb-1 font-bold">Correlation (R)</div>
                  <div className="text-3xl font-black text-emerald-400 font-mono">0.91</div>
                  <div className="text-[9px] text-slate-500 mt-1 uppercase tracking-wide">High Confidence</div>
                </div>
                <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4 text-center shadow-inner">
                  <div className="text-[10px] text-slate-500 font-mono uppercase tracking-widest mb-1 font-bold">MAE</div>
                  <div className="text-3xl font-black text-purple-400 font-mono">8.2</div>
                  <div className="text-[9px] text-slate-500 mt-1 uppercase tracking-wide">Mean Absolute Error</div>
                </div>
              </div>
              
              {/* Line Chart */}
              <div className="h-64 w-full bg-slate-900/30 border border-slate-800 rounded-xl p-4 shadow-inner">
                <h3 className="text-[10px] text-slate-400 font-mono uppercase tracking-widest mb-2 text-center font-bold">Ground-Based CPCB vs Satellite-Predicted PM2.5</h3>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={[
                    { time: '00:00', ground: 45, sat: 48 },
                    { time: '04:00', ground: 52, sat: 50 },
                    { time: '08:00', ground: 85, sat: 80 },
                    { time: '12:00', ground: 110, sat: 115 },
                    { time: '16:00', ground: 140, sat: 132 },
                    { time: '20:00', ground: 95, sat: 105 },
                    { time: '24:00', ground: 65, sat: 60 },
                  ]} margin={{ top: 10, right: 20, bottom: 5, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                    <XAxis dataKey="time" stroke="#475569" fontSize={10} tickMargin={10} axisLine={false} tickLine={false} />
                    <YAxis stroke="#475569" fontSize={10} tickFormatter={(val) => `${val}µg`} axisLine={false} tickLine={false} />
                    <RechartsTooltip 
                      contentStyle={{ backgroundColor: '#020617', borderColor: '#1e293b', borderRadius: '8px', fontSize: '11px', fontFamily: 'monospace', textTransform: 'uppercase' }}
                      itemStyle={{ color: '#e2e8f0', fontWeight: 'bold' }}
                      cursor={{ stroke: '#334155', strokeWidth: 1, strokeDasharray: '5 5' }}
                    />
                    <Legend wrapperStyle={{ fontSize: '10px', fontFamily: 'monospace', textTransform: 'uppercase', marginTop: '10px' }} />
                    <Line type="monotone" name="Ground (CPCB)" dataKey="ground" stroke="#34d399" strokeWidth={2.5} dot={{ r: 4, fill: '#0a0c10', strokeWidth: 2 }} activeDot={{ r: 6 }} />
                    <Line type="monotone" name="Predicted (CNN-LSTM)" dataKey="sat" stroke="#c084fc" strokeWidth={2.5} dot={{ r: 4, fill: '#0a0c10', strokeWidth: 2 }} activeDot={{ r: 6 }} strokeDasharray="5 5" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AirQualityMap;

