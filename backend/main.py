# main.py
"""
High-performance FastAPI router serving national AQI raster grids.
Integrates Motor async MongoDB driver with a NumPy simulation fallback.
Designed for standalone or full-stack MongoDB execution.

MongoDB collection: isro_telemetry.grid_data
Expected document schema:
  {
    "day": int,
    "id": int,
    "location": { "type": "Point", "coordinates": [lng, lat] },
    "geometry": { "type": "Polygon", "coordinates": [[ [lng,lat], ... ]] },
    "properties": { "aqi": int, "aqi_value": int, "pm25": int, ... }
  }
"""
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, Query, status
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import numpy as np

# ── Configure Logging ──────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ISRO-AQI-Backend")

# ── MongoDB (Motor) ────────────────────────────────────────────────────────────
# Motor is imported inside a try/except so the server still starts when
# the package is not installed or MongoDB is unreachable.
try:
    from motor.motor_asyncio import AsyncIOMotorClient
    MONGO_URI = "mongodb://localhost:27017/isro_telemetry"
    _mongo_client: AsyncIOMotorClient | None = None
    _db = None
    MONGO_AVAILABLE = True
except ImportError:
    MONGO_AVAILABLE = False
    _mongo_client = None
    _db = None
    logger.warning("Motor not installed – falling back to NumPy simulation.")


# ── Lifespan (replaces deprecated @app.on_event) ──────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Startup: connect Motor client, ping MongoDB, build compound geospatial index.
    Shutdown: close Motor client gracefully.
    """
    global _mongo_client, _db
    if MONGO_AVAILABLE:
        try:
            _mongo_client = AsyncIOMotorClient(
                MONGO_URI,
                serverSelectionTimeoutMS=3000,
                maxPoolSize=50,
                minPoolSize=5,
            )
            # Confirm the connection is alive
            await _mongo_client.admin.command("ping")
            _db = _mongo_client["isro_telemetry"]

            # Build compound geospatial index for ultra-fast timeline slider queries
            # This makes { "day": day } filtered queries with optional $geoNear instant.
            await _db.grid_data.create_index(
                [("day", 1), ("location", "2dsphere")],
                background=True,
            )
            logger.info("✅  MongoDB connected – isro_telemetry.grid_data index ready.")
        except Exception as exc:
            logger.warning(
                f"⚠️  MongoDB unavailable ({exc}). Falling back to NumPy simulation."
            )
            _mongo_client = None
            _db = None

    logger.info("=" * 60)
    logger.info("  ISRO AQI Grid Telemetry Service API")
    logger.info("  Docs:  http://127.0.0.1:8001/docs")
    logger.info("  API:   http://127.0.0.1:8001/api/v1/aqi-grid?day=0")
    logger.info("  State: http://127.0.0.1:8001/api/v1/state-analytics?state_name=Delhi")
    logger.info("=" * 60)

    yield  # ── Application runs here ──

    # ── Shutdown ───────────────────────────────────────────────────────────────
    if _mongo_client:
        _mongo_client.close()
        logger.info("MongoDB connection closed.")


app = FastAPI(
    title="ISRO Hackathon Air Quality API",
    description="High-performance FastAPI service rendering India AQI grids – Motor + NumPy.",
    version="2.0.0",
    lifespan=lifespan,
)

# Enable CORS for frontend integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── India bounding box limits ──────────────────────────────────────────────────
LNG_MIN, LNG_MAX = 68.0, 97.0
LAT_MIN, LAT_MAX = 8.0, 37.0
STEP = 0.5  # 0.5 degree grid

# Coordinates of major hubs for organic landmass masking
INDIA_HUBS = np.array([
    [77.2, 28.6],  # Delhi
    [72.8, 19.0],  # Mumbai
    [88.4, 22.6],  # Kolkata
    [80.3, 13.1],  # Chennai
    [77.6, 13.0],  # Bengaluru
    [79.1, 21.1],  # Nagpur
    [85.1, 25.6],  # Patna
    [91.7, 26.1],  # Guwahati
    [78.5, 17.4],  # Hyderabad
    [74.8, 34.1],  # Srinagar
    [72.6, 23.0],  # Ahmedabad
    [93.0, 24.8]   # Imphal
])

# ── CPCB AQI Breakpoint Ranges ─────────────────────────────────────────────────
PM25_BP = [((0,30),(0,50)),((31,60),(51,100)),((61,90),(101,200)),((91,120),(201,300)),((121,250),(301,400)),((251,1000),(401,500))]
PM10_BP = [((0,50),(0,50)),((51,100),(51,100)),((101,250),(101,200)),((251,350),(201,300)),((351,430),(301,400)),((431,1000),(401,500))]
NO2_BP  = [((0,40),(0,50)),((41,80),(51,100)),((81,180),(101,200)),((181,280),(201,300)),((281,400),(301,400)),((401,1000),(401,500))]
SO2_BP  = [((0,40),(0,50)),((41,80),(51,100)),((81,380),(101,200)),((381,800),(201,300)),((801,1600),(301,400)),((1601,5000),(401,500))]
CO_BP   = [((0,1),(0,50)),((1.1,2),(51,100)),((2.1,10),(101,200)),((10.1,17),(201,300)),((17.1,34),(301,400)),((34.1,100),(401,500))]
O3_BP   = [((0,50),(0,50)),((51,100),(51,100)),((101,168),(101,200)),((169,208),(201,300)),((209,748),(301,400)),((749,1000),(401,500))]


def get_sub_index_vectorized(data_arr: np.ndarray, breakpoints: list) -> np.ndarray:
    cond_list, func_list = [], []
    for (c_low, c_high), (i_low, i_high) in breakpoints:
        cond_list.append((data_arr >= c_low) & (data_arr <= c_high))
        func_list.append(lambda x, cl=c_low, ch=c_high, il=i_low, ih=i_high:
                         il + (x - cl) * (ih - il) / (ch - cl))
    max_c_high = breakpoints[-1][0][1]
    max_i_high = breakpoints[-1][1][1]
    cond_list.append(data_arr > max_c_high)
    func_list.append(lambda x: max_i_high)
    return np.piecewise(data_arr, cond_list, func_list)


def is_on_subcontinent(lngs: np.ndarray, lats: np.ndarray) -> np.ndarray:
    coords = np.column_stack((lngs, lats))
    mask = np.zeros(len(coords), dtype=bool)
    coarse_mask = (lats >= 8.2) & ~((lats < 20.0) & ((lngs < 72.0) | (lngs > 86.0)))
    for hub in INDIA_HUBS:
        hub_lng, hub_lat = hub
        dist = np.sqrt((coords[:, 0] - hub_lng)**2 + (coords[:, 1] - hub_lat)**2)
        threshold = 3.8 if hub_lng > 90 else 5.8
        mask |= (dist < threshold)
    return mask & coarse_mask


def _simulate_grid(day: int) -> list:
    """Pure NumPy simulation used as fallback when MongoDB is unavailable.

    Returns a list of GeoJSON Feature dicts with **Polygon** geometry (for
    interactive grid hover) and pollutant properties including ``aqi_value``.
    """
    lng_grid, lat_grid = np.meshgrid(
        np.arange(LNG_MIN, LNG_MAX + STEP, STEP),
        np.arange(LAT_MIN, LAT_MAX + STEP, STEP)
    )
    lngs = lng_grid.flatten()
    lats = lat_grid.flatten()
    land_mask = is_on_subcontinent(lngs, lats)
    lngs = lngs[land_mask]
    lats = lats[land_mask]
    total_points = len(lngs)

    rng = np.random.default_rng(day)
    dist_to_ganga = np.abs(lats + 0.4 * lngs - 59.5) / np.sqrt(1 + 0.16)
    in_igp = (dist_to_ganga < 2.2) & (lngs >= 73.0) & (lngs <= 89.0) & (lats >= 22.0) & (lats <= 31.0)

    pm25 = rng.uniform(15, 65, size=total_points)
    pm10 = rng.uniform(30, 110, size=total_points)
    no2  = rng.uniform(8, 30, size=total_points)
    so2  = rng.uniform(5, 20, size=total_points)
    co   = rng.uniform(0.3, 1.2, size=total_points)
    o3   = rng.uniform(15, 60, size=total_points)

    if np.any(in_igp):
        dist_to_delhi = np.sqrt((lngs[in_igp] - 77.2)**2 + (lats[in_igp] - 28.6)**2)
        plume = np.maximum(0, 1.0 - dist_to_delhi * 0.12 - dist_to_ganga[in_igp] * 0.18)
        pm25[in_igp] = 135 + plume * 185 + np.sin(lngs[in_igp] * 0.5) * 35
        pm10[in_igp] = 215 + plume * 235 + np.cos(lats[in_igp] * 0.5) * 55
        no2[in_igp]  = 42  + plume * 55
        so2[in_igp]  = 24  + plume * 18
        co[in_igp]   = 1.7 + plume * 1.8
        o3[in_igp]   = 55  + plume * 30

    si_pm25 = get_sub_index_vectorized(pm25, PM25_BP)
    si_pm10 = get_sub_index_vectorized(pm10, PM10_BP)
    si_no2  = get_sub_index_vectorized(no2,  NO2_BP)
    si_so2  = get_sub_index_vectorized(so2,  SO2_BP)
    si_co   = get_sub_index_vectorized(co,   CO_BP)
    si_o3   = get_sub_index_vectorized(o3,   O3_BP)
    aqi_values = np.rint(
        np.maximum.reduce([si_pm25, si_pm10, si_no2, si_so2, si_co, si_o3])
    ).astype(int)

    half_step = STEP / 2.0
    features = []
    for i in range(total_points):
        lng, lat = float(lngs[i]), float(lats[i])
        aqi = int(aqi_values[i])
        poly_coords = [
            [lng - half_step, lat - half_step],
            [lng + half_step, lat - half_step],
            [lng + half_step, lat + half_step],
            [lng - half_step, lat + half_step],
            [lng - half_step, lat - half_step]
        ]
        features.append({
            "type": "Feature",
            "id": i + 1,
            "geometry": {"type": "Polygon", "coordinates": [poly_coords]},
            "properties": {
                "aqi": aqi,
                "aqi_value": aqi,
                "pm25": int(round(pm25[i])),
                "pm10": int(round(pm10[i])),
                "no2":  int(round(no2[i])),
                "so2":  int(round(so2[i])),
                "co":   float(round(co[i], 2)),
                "o3":   int(round(o3[i]))
            }
        })
    return features


def _mongo_doc_to_feature(doc: dict, fallback_id: int = 1) -> dict:
    """Convert a single MongoDB grid_data document into a standard GeoJSON Feature.

    Supports two document layouts:
      1. **Nested** – properties live under a ``properties`` sub-document.
      2. **Flat** – pollutant keys sit at the document root alongside ``geometry``.
    """
    props = doc.get("properties", {})

    # Flatten: if pollutant keys exist at root level, merge them into props
    for key in ("aqi", "aqi_value", "pm25", "pm10", "no2", "so2", "co", "o3"):
        if key in doc and key not in props:
            props[key] = doc[key]

    # Ensure aqi_value is always present (some docs may only store "aqi")
    if "aqi_value" not in props and "aqi" in props:
        props["aqi_value"] = props["aqi"]
    if "aqi" not in props and "aqi_value" in props:
        props["aqi"] = props["aqi_value"]

    return {
        "type": "Feature",
        "id": doc.get("id", fallback_id),
        "geometry": doc.get("geometry", {}),
        "properties": {
            "aqi":       props.get("aqi", 0),
            "aqi_value": props.get("aqi_value", 0),
            "pm25":      props.get("pm25", 0),
            "pm10":      props.get("pm10", 0),
            "no2":       props.get("no2", 0),
            "so2":       props.get("so2", 0),
            "co":        props.get("co", 0.0),
            "o3":        props.get("o3", 0),
        },
    }


# ── Health ─────────────────────────────────────────────────────────────────────
@app.get("/api/v1/health")
async def health_check():
    """Simple liveness / readiness probe."""
    mongo_status = "connected" if (_db is not None) else "simulation"
    return {"status": "ok", "mode": mongo_status}


# ── AQI Grid ───────────────────────────────────────────────────────────────────
@app.get("/api/v1/aqi-grid")
async def get_aqi_grid(
    day: int = Query(0, description="Timeline sequence index", ge=0, le=30)
):
    """
    Queries MongoDB ``grid_data`` collection filtered by ``{ "day": day }``.
    Falls back to deterministic NumPy simulation when MongoDB is unavailable
    or the collection is empty for the requested day.

    Returns a standard **GeoJSON FeatureCollection** with Polygon geometry
    and pollutant properties attached to each Feature.
    """
    try:
        features: list[dict] = []

        # ── MongoDB path ──────────────────────────────────────────────────────
        if _db is not None:
            cursor = _db.grid_data.find(
                {"day": day},
                {"_id": 0},  # exclude Mongo internal _id from response
            )
            idx = 0
            async for doc in cursor:
                idx += 1
                features.append(_mongo_doc_to_feature(doc, fallback_id=idx))
            logger.info(f"MongoDB served {len(features)} features for day={day}")

        # ── NumPy simulation fallback ─────────────────────────────────────────
        if not features:
            logger.info(f"NumPy simulation fallback for day={day}")
            features = _simulate_grid(day)

        return JSONResponse(
            content={"type": "FeatureCollection", "features": features}
        )

    except Exception as e:
        logger.error(f"Error serving AQI grid GeoJSON: {e}")
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": "Internal Server Error", "detail": str(e)},
        )


def _simulate_predictive_grid(day: int) -> list:
    """Simulate future air quality trends using a predictive ML-like simulation pattern.
    Applies progressive scaling factors based on simulated meteorological changes
    to show forecasting.
    """
    # Base simulation using day=30 (the latest real-time base)
    features = _simulate_grid(day=30)
    
    # T+1: +12% scaling factor with slight random offsets
    # T+2: +25% scaling factor to simulate a worsening dispersion scenario
    factor = 1.12 if day == 31 else 1.25
    
    for feat in features:
        props = feat["properties"]
        # Scale values deterministically
        props["pm25"] = int(round(props["pm25"] * factor))
        props["pm10"] = int(round(props["pm10"] * factor))
        props["no2"] = int(round(props["no2"] * factor))
        props["so2"] = int(round(props["so2"] * factor))
        props["co"] = float(round(props["co"] * factor, 2))
        props["o3"] = int(round(props["o3"] * factor))
        
        # Recalculate AQI sub-indices and update the feature
        si_pm25 = float(get_sub_index_vectorized(np.array([props["pm25"]], dtype=float), PM25_BP)[0])
        si_pm10 = float(get_sub_index_vectorized(np.array([props["pm10"]], dtype=float), PM10_BP)[0])
        si_no2  = float(get_sub_index_vectorized(np.array([props["no2"]],  dtype=float), NO2_BP)[0])
        si_so2  = float(get_sub_index_vectorized(np.array([props["so2"]],  dtype=float), SO2_BP)[0])
        si_co   = float(get_sub_index_vectorized(np.array([props["co"]],   dtype=float), CO_BP)[0])
        si_o3   = float(get_sub_index_vectorized(np.array([props["o3"]],   dtype=float), O3_BP)[0])
        
        aqi_value = int(round(max(si_pm25, si_pm10, si_no2, si_so2, si_co, si_o3)))
        props["aqi"] = aqi_value
        props["aqi_value"] = aqi_value
        
    return features


# ── AI Predict AQI ─────────────────────────────────────────────────────────────
@app.get("/api/v1/predict-aqi")
async def get_predict_aqi(
    day: int = Query(31, description="Timeline forecast index (31=T+1, 32=T+2)", ge=31, le=32)
):
    """
    Returns predictive ML inference simulated grid for future timeline ticks.
    """
    try:
        features = _simulate_predictive_grid(day)
        return JSONResponse(content={"type": "FeatureCollection", "features": features})
    except Exception as e:
        logger.error(f"Error serving AQI prediction GeoJSON: {e}")
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": "Internal Server Error", "detail": str(e)}
        )



# ── State Analytics ────────────────────────────────────────────────────────────
STATE_ANALYTICS_DATA = {
    "delhi": {
        "name": "Delhi",
        "center": [77.2167, 28.6667],
        "zoom": 8.5,
        "averages": {"aqi_value": 310, "pm25": 165, "pm10": 280, "no2": 62, "so2": 18, "co": 1.9, "o3": 65}
    },
    "uttar pradesh": {
        "name": "Uttar Pradesh",
        "center": [80.9462, 26.8467],
        "zoom": 6.2,
        "averages": {"aqi_value": 240, "pm25": 115, "pm10": 210, "no2": 38, "so2": 14, "co": 1.2, "o3": 45}
    },
    "maharashtra": {
        "name": "Maharashtra",
        "center": [75.7139, 19.7515],
        "zoom": 6.0,
        "averages": {"aqi_value": 115, "pm25": 48, "pm10": 95, "no2": 22, "so2": 11, "co": 0.7, "o3": 34}
    },
    "rajasthan": {
        "name": "Rajasthan",
        "center": [74.2179, 27.0238],
        "zoom": 6.0,
        "averages": {"aqi_value": 145, "pm25": 62, "pm10": 120, "no2": 26, "so2": 13, "co": 0.8, "o3": 38}
    },
    "karnataka": {
        "name": "Karnataka",
        "center": [75.7139, 15.3173],
        "zoom": 6.0,
        "averages": {"aqi_value": 78, "pm25": 28, "pm10": 55, "no2": 14, "so2": 9, "co": 0.5, "o3": 28}
    },
    "tamil nadu": {
        "name": "Tamil Nadu",
        "center": [78.6569, 11.1271],
        "zoom": 6.2,
        "averages": {"aqi_value": 68, "pm25": 24, "pm10": 48, "no2": 12, "so2": 8, "co": 0.45, "o3": 25}
    },
    "west bengal": {
        "name": "West Bengal",
        "center": [87.8550, 23.8718],
        "zoom": 6.5,
        "averages": {"aqi_value": 165, "pm25": 72, "pm10": 130, "no2": 29, "so2": 12, "co": 0.9, "o3": 40}
    },
    "bihar": {
        "name": "Bihar",
        "center": [85.3131, 25.0961],
        "zoom": 6.5,
        "averages": {"aqi_value": 220, "pm25": 105, "pm10": 180, "no2": 35, "so2": 13, "co": 1.1, "o3": 42}
    },
    "gujarat": {
        "name": "Gujarat",
        "center": [71.1924, 22.2587],
        "zoom": 6.0,
        "averages": {"aqi_value": 125, "pm25": 52, "pm10": 100, "no2": 24, "so2": 12, "co": 0.75, "o3": 35}
    },
    "madhya pradesh": {
        "name": "Madhya Pradesh",
        "center": [78.6569, 22.9734],
        "zoom": 5.8,
        "averages": {"aqi_value": 98, "pm25": 38, "pm10": 75, "no2": 18, "so2": 10, "co": 0.6, "o3": 30}
    }
}


def _simulate_city_telemetry(lat: float, lon: float) -> dict:
    """Generate deterministic simulated pollutant averages for a geocoded city.

    Uses the lat/lon as a seed so the same location always returns the same
    numbers, but different cities produce varied results.
    """
    seed = int(abs(lat * 1000) + abs(lon * 1000)) % (2**31)
    rng = np.random.default_rng(seed)

    # Northern Indo-Gangetic Plain cities trend more polluted
    is_igp = 22.0 <= lat <= 31.0 and 73.0 <= lon <= 89.0
    if is_igp:
        pm25 = int(rng.integers(90, 250))
        pm10 = int(rng.integers(150, 350))
        no2  = int(rng.integers(30, 80))
        so2  = int(rng.integers(15, 45))
        co   = round(float(rng.uniform(1.2, 3.5)), 2)
        o3   = int(rng.integers(40, 90))
    else:
        pm25 = int(rng.integers(15, 90))
        pm10 = int(rng.integers(30, 150))
        no2  = int(rng.integers(5, 40))
        so2  = int(rng.integers(3, 25))
        co   = round(float(rng.uniform(0.2, 1.5)), 2)
        o3   = int(rng.integers(10, 60))

    # Compute sub-indices and take maximum (CPCB method)
    si = [
        float(get_sub_index_vectorized(np.array([pm25], dtype=float), PM25_BP)[0]),
        float(get_sub_index_vectorized(np.array([pm10], dtype=float), PM10_BP)[0]),
        float(get_sub_index_vectorized(np.array([no2],  dtype=float), NO2_BP)[0]),
        float(get_sub_index_vectorized(np.array([so2],  dtype=float), SO2_BP)[0]),
        float(get_sub_index_vectorized(np.array([co],   dtype=float), CO_BP)[0]),
        float(get_sub_index_vectorized(np.array([o3],   dtype=float), O3_BP)[0]),
    ]
    aqi_value = int(round(max(si)))

    return {
        "aqi_value": aqi_value,
        "pm25": pm25,
        "pm10": pm10,
        "no2": no2,
        "so2": so2,
        "co": co,
        "o3": o3,
    }


# ── Unified Search: States + Cities via Nominatim fallback ─────────────────────
@app.get("/api/v1/search-location")
async def search_location(
    query: str = Query(..., description="City or State name to search in India"),
):
    """
    1. Check hardcoded STATE_ANALYTICS_DATA first (instant, zero-latency).
    2. If not a known state, geocode via OpenStreetMap Nominatim API
       (free, no API key) and generate simulated telemetry for the city.
    3. Return coordinates, zoom level, and pollutant averages.
    """
    normalized = query.strip().lower()

    # ── Fast path: known Indian state ──────────────────────────────────────────
    if normalized in STATE_ANALYTICS_DATA:
        return JSONResponse(
            content={
                "status": "SUCCESS",
                "type": "state",
                "state": STATE_ANALYTICS_DATA[normalized],
            }
        )

    # ── Fallback: Nominatim geocoding for cities / other locations ─────────────
    import urllib.request
    import urllib.parse
    import json as json_mod

    nominatim_url = (
        "https://nominatim.openstreetmap.org/search?"
        + urllib.parse.urlencode({
            "q": query.strip(),
            "countrycodes": "in",
            "format": "json",
            "limit": "1",
        })
    )

    try:
        req = urllib.request.Request(
            nominatim_url,
            headers={"User-Agent": "ISRO-AQI-Dashboard/2.0 (student-hackathon)"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            results = json_mod.loads(resp.read().decode())
    except Exception as exc:
        logger.error(f"Nominatim geocoding failed: {exc}")
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={
                "status": "ERROR",
                "message": "Geocoding service unavailable. Please try again.",
            },
        )

    if not results:
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={
                "status": "ERROR",
                "message": f"Location '{query}' not found in India.",
                "available_states": [s["name"] for s in STATE_ANALYTICS_DATA.values()],
            },
        )

    hit = results[0]
    lat = float(hit["lat"])
    lon = float(hit["lon"])
    display_name = hit.get("display_name", query.strip().title())
    # Use the short part before the first comma as the location name
    short_name = display_name.split(",")[0].strip()
    osm_type = hit.get("type", "city")

    # Determine zoom level based on OSM place type
    zoom_map = {
        "administrative": 6.0,
        "state": 6.0,
        "county": 7.5,
        "city": 9.0,
        "town": 10.0,
        "village": 11.0,
        "suburb": 12.0,
        "neighbourhood": 13.0,
    }
    zoom = zoom_map.get(osm_type, 9.0)

    averages = _simulate_city_telemetry(lat, lon)

    return JSONResponse(
        content={
            "status": "SUCCESS",
            "type": "city",
            "state": {
                "name": short_name,
                "center": [lon, lat],
                "zoom": zoom,
                "averages": averages,
            },
        }
    )


# ── Backward-compatible alias ──────────────────────────────────────────────────
@app.get("/api/v1/state-analytics")
async def state_analytics_legacy(
    state_name: str = Query(..., description="Name of the Indian State"),
):
    """Legacy endpoint — redirects to the unified search-location handler."""
    return await search_location(query=state_name)
