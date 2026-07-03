# tasks.py
"""
Celery worker task runner.
Runs the ONNX Runtime model engine, performs CPCB calculations,
and compresses outputs into MessagePack format.
"""
import os
import time
import logging
import numpy as np
import msgpack
import redis
import onnxruntime as ort
from celery import Celery
from cpcb_formula import calculate_cpcb_aqi

# Configure Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("CeleryWorker")

# Initialize Celery
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
celery_app = Celery("aqi_tasks", broker=REDIS_URL, backend=REDIS_URL)

# Global variables to cache model session and redis connection
_ort_session = None
_redis_client = None

def get_ort_session():
    """Initializes and retrieves the ONNX Runtime Inference Session."""
    global _ort_session
    if _ort_session is None:
        model_path = os.path.join(os.path.dirname(__file__), "model.onnx")
        if not os.path.exists(model_path):
            # Create model dynamically if missing
            from generate_dummy_onnx import create_model
            create_model(model_path)
        logger.info(f"Loading ONNX Model from {model_path}...")
        _ort_session = ort.InferenceSession(model_path)
    return _ort_session

def get_redis_client():
    """Initializes and retrieves the Redis client."""
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.from_url(REDIS_URL)
    return _redis_client


@celery_app.task(bind=True, name="tasks.generate_aqi_map_task")
def generate_aqi_map_task(self, target_date: str):
    """
    Background pipeline:
    1. Loads pre-aligned array features for target_date.
    2. Runs inference using ONNX model.
    3. Calculates CPCB AQI for all grid coordinates.
    4. Compresses outputs into MessagePack format.
    5. Caches in Redis memory store.
    """
    logger.info(f"Starting AQI model execution for target date: {target_date}")
    
    try:
      # Step 1: Simulate loading pre-aligned input array of shape (1, 4, 120, 80)
      # Features: [0] Temperature, [1] Humidity, [2] Wind Speed, [3] Prior Pollution index
      np.random.seed(int(time.time()) % 1000000)
      input_features = np.random.rand(1, 4, 120, 80).astype(np.float32) * 50.0

      # Step 2: Run ONNX Runtime Deep Learning inference engine
      session = get_ort_session()
      inputs = {session.get_inputs()[0].name: input_features}
      outputs = session.run(None, inputs)
      
      # Model output is PM2.5, PM10, NO2, SO2 concentrations across the grid
      concentrations = outputs[0][0] # Shape: (4, 120, 80)
      
      # Step 3: Run CPCB Formula Conversion cell by cell
      pm25_grid = concentrations[0]
      pm10_grid = concentrations[1]
      no2_grid = concentrations[2]
      so2_grid = concentrations[3]
      
      width, height = 120, 80
      aqi_values = []
      
      for y in range(height):
          for x in range(width):
              val = calculate_cpcb_aqi(
                  pm25=float(pm25_grid[x, y]),
                  pm10=float(pm10_grid[x, y]),
                  no2=float(no2_grid[x, y]),
                  so2=float(so2_grid[x, y])
              )
              aqi_values.append(val)
              
      # Calculate stats
      stats = {
          "min": int(min(aqi_values)),
          "max": int(max(aqi_values)),
          "avg": float(np.mean(aqi_values)),
          "count": len(aqi_values)
      }

      # Step 4: Serialize with high-density MessagePack
      result_payload = {
          "date": target_date,
          "width": width,
          "height": height,
          "values": aqi_values,
          "stats": stats,
          "processed_at": time.time()
      }
      packed_bytecode = msgpack.packb(result_payload, use_bin_type=True)
      
      # Step 5: Save in Redis cache under 'aqi:india:YYYY-MM-DD'
      redis_client = get_redis_client()
      cache_key = f"aqi:india:{target_date}"
      redis_client.set(cache_key, packed_bytecode)
      logger.info(f"Successfully cached bytecode in Redis under key: {cache_key}")
      
      return {
          "status": "COMPLETED",
          "date": target_date,
          "stats": stats
      }

    except Exception as e:
        logger.error(f"Error during Celery task execution: {str(e)}")
        self.update_state(state="FAILURE", meta={"error": str(e)})
        raise e
