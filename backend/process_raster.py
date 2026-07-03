# process_raster.py
"""
High-performance, vectorized raster calculation pipeline for AQI mapping.
Combines Xarray alignment, parallel ONNX Runtime execution, and a fully
vectorized NumPy implementation of the CPCB AQI formula.
"""
import time
import logging
import numpy as np
import xarray as xr
import onnxruntime as ort

# Configure Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("RasterPipeline")

# --- CPCB Vectorized Breakpoints ---
# PM2.5, PM10, NO2, SO2, CO, O3 ranges mapping to AQI indices (0-50, 51-100, etc.)
PM25_BP = [((0.0, 30.0), (0.0, 50.0)), ((30.1, 60.0), (51.0, 100.0)), ((60.1, 90.0), (101.0, 200.0)), ((90.1, 120.0), (201.0, 300.0)), ((120.1, 250.0), (301.0, 400.0)), ((250.1, 1000.0), (401.0, 500.0))]
PM10_BP = [((0.0, 50.0), (0.0, 50.0)), ((50.1, 100.0), (51.0, 100.0)), ((101.0, 250.0), (101.0, 200.0)), ((251.0, 350.0), (201.0, 300.0)), ((351.0, 430.0), (301.0, 400.0)), ((430.1, 1000.0), (401.0, 500.0))]
NO2_BP = [((0.0, 40.0), (0.0, 50.0)), ((40.1, 80.0), (51.0, 100.0)), ((80.1, 180.0), (101.0, 200.0)), ((181.0, 280.0), (201.0, 300.0)), ((281.0, 400.0), (301.0, 400.0)), ((400.1, 1000.0), (401.0, 500.0))]
SO2_BP = [((0.0, 40.0), (0.0, 50.0)), ((40.1, 80.0), (51.0, 100.0)), ((80.1, 380.0), (101.0, 200.0)), ((381.0, 800.0), (201.0, 300.0)), ((801.0, 1600.0), (301.0, 400.0)), ((1600.1, 5000.0), (401.0, 500.0))]
CO_BP = [((0.0, 1.0), (0.0, 50.0)), ((1.01, 2.0), (51.0, 100.0)), ((2.01, 10.0), (101.0, 200.0)), ((10.01, 17.0), (201.0, 300.0)), ((17.01, 34.0), (301.0, 400.0)), ((34.01, 100.0), (401.0, 500.0))]
O3_BP = [((0.0, 50.0), (0.0, 50.0)), ((50.1, 100.0), (51.0, 100.0)), ((101.0, 168.0), (101.0, 200.0)), ((168.1, 208.0), (201.0, 300.0)), ((208.1, 748.0), (301.0, 400.0)), ((748.1, 1000.0), (401.0, 500.0))]


def calculate_sub_index_vectorized(data_arr: np.ndarray, breakpoints: list) -> np.ndarray:
    """
    Applies vectorized linear interpolation over numpy arrays using np.piecewise.
    Avoids slow python iterative loops.
    """
    cond_list = []
    func_list = []

    for (c_low, c_high), (i_low, i_high) in breakpoints:
        # Condition mask
        cond = (data_arr >= c_low) & (data_arr <= c_high)
        cond_list.append(cond)
        
        # Calculate sub-index interpolation for this range
        # Use lambda factory to freeze loop scope
        def make_interpolation(cl, ch, il, ih):
            return lambda x, cl=cl, ch=ch, il=il, ih=ih: il + (x - cl) * (ih - il) / (ch - cl)
            
        func_list.append(make_interpolation(c_low, c_high, i_low, i_high))
        
    # Cap value beyond severe breakpoint
    max_c_high = breakpoints[-1][0][1]
    max_i_high = breakpoints[-1][1][1]
    cond_list.append(data_arr > max_c_high)
    func_list.append(lambda x: max_i_high)

    return np.piecewise(data_arr, cond_list, func_list)


def calculate_cpcb_aqi_vectorized(pm25: np.ndarray, pm10: np.ndarray, no2: np.ndarray,
                                  so2: np.ndarray, co: np.ndarray, o3: np.ndarray) -> np.ndarray:
    """
    Performs fully vectorized maximum index calculation across grid layouts.
    Returns:
        np.ndarray containing CPCB AQI indices for each coordinate pixel.
    """
    logger.info("Running vectorized CPCB AQI sub-index conversions...")
    
    # Calculate sub-indices vectorially
    si_pm25 = calculate_sub_index_vectorized(pm25, PM25_BP)
    si_pm10 = calculate_sub_index_vectorized(pm10, PM10_BP)
    si_no2 = calculate_sub_index_vectorized(no2, NO2_BP)
    si_so2 = calculate_sub_index_vectorized(so2, SO2_BP)
    si_co = calculate_sub_index_vectorized(co, CO_BP)
    si_o3 = calculate_sub_index_vectorized(o3, O3_BP)
    
    # Take the absolute element-wise maximum across all pollutant index arrays
    aqi_grid = np.maximum.reduce([si_pm25, si_pm10, si_no2, si_so2, si_co, si_o3])
    
    # Round to nearest integer natively
    return np.rint(aqi_grid).astype(np.int32)


# --- Step 1: Feature Construction ---
def build_feature_tensor(ds_insat: xr.Dataset, ds_sentinel: xr.Dataset, ds_era5: xr.Dataset) -> np.ndarray:
    """
    Vectorially aligns raw multidimensional xarray inputs and stacks them
    into a contiguous 3D input NumPy tensor (np.ascontiguousarray).
    """
    logger.info("Aligning multidimensional Xarray datasets...")
    
    # Pre-align spatial grids vectorially (Interpolate Sentinel and ERA5 onto INSAT grid coordinates)
    # Coordinate structures: 'lat', 'lon'
    target_coords = {
        'lat': ds_insat.coords['lat'],
        'lon': ds_insat.coords['lon']
    }
    
    # Vectorized interpolation without explicit Python loops
    ds_sentinel_aligned = ds_sentinel.interp(lat=target_coords['lat'], lon=target_coords['lon'], method='linear')
    ds_era5_aligned = ds_era5.interp(lat=target_coords['lat'], lon=target_coords['lon'], method='linear')
    
    # Extract variables as arrays
    aod = ds_insat['aod'].values           # Shape: (120, 80)
    no2 = ds_sentinel_aligned['no2'].values # Shape: (120, 80)
    temp = ds_era5_aligned['temp'].values   # Shape: (120, 80)
    wind = ds_era5_aligned['wind'].values   # Shape: (120, 80)
    
    # Stack along a new features channel axis: Shape (4, 120, 80)
    stacked_tensor = np.stack([aod, no2, temp, wind], axis=0)
    
    # Make contiguous in memory for quick ONNX Runtime C-API access
    contiguous_tensor = np.ascontiguousarray(stacked_tensor, dtype=np.float32)
    
    # Expand dims to batch size 1: Shape (1, 4, 120, 80)
    return np.expand_dims(contiguous_tensor, axis=0)


# --- Step 2: Initialize Parallel ONNX Session ---
def init_onnx_session(model_path: str = "model.onnx") -> ort.InferenceSession:
    """
    Configures optimized ORT execution mode (ORT_PARALLEL) and specifies thread scales.
    """
    logger.info("Initializing optimized parallel ONNX Inference session...")
    
    opts = ort.SessionOptions()
    # Enable concurrent node execution (ORT_PARALLEL)
    opts.execution_mode = ort.ExecutionMode.ORT_PARALLEL
    
    # Fine-tune thread scale parameters for CPU scalability
    opts.intra_op_num_threads = 4
    opts.inter_op_num_threads = 4
    
    # Load with optimal providers list (CUDA GPU fallback to CPU)
    providers = ['CUDAExecutionProvider', 'CPUExecutionProvider']
    
    session = ort.InferenceSession(model_path, sess_options=opts, providers=providers)
    logger.info(f"Session established with active providers: {session.get_providers()}")
    return session


# --- Mock Execution Sandbox ---
def run_pipeline_demo():
    # 1. Create Mock Xarray Inputs for Demo
    lat = np.linspace(8.0, 35.0, 120)
    lon = np.linspace(68.0, 92.0, 80)
    
    ds_insat = xr.Dataset(
        {"aod": (["lat", "lon"], np.random.rand(120, 80).astype(np.float32))},
        coords={"lat": lat, "lon": lon}
    )
    ds_sentinel = xr.Dataset(
        {"no2": (["lat", "lon"], np.random.rand(120, 80).astype(np.float32) * 200)},
        coords={"lat": lat, "lon": lon}
    )
    ds_era5 = xr.Dataset(
        {
            "temp": (["lat", "lon"], np.random.rand(120, 80).astype(np.float32) * 45),
            "wind": (["lat", "lon"], np.random.rand(120, 80).astype(np.float32) * 15)
        },
        coords={"lat": lat, "lon": lon}
    )
    
    # 2. Build feature input
    input_tensor = build_feature_tensor(ds_insat, ds_sentinel, ds_era5)
    logger.info(f"Aligned tensor shape: {input_tensor.shape}, Contiguous: {input_tensor.flags['C_CONTIGUOUS']}")
    
    # 3. ONNX Session
    import os
    model_path = "model.onnx"
    if not os.path.exists(model_path):
        from generate_dummy_onnx import create_model
        create_model(model_path)
        
    session = init_onnx_session(model_path)
    
    # 4. Perform CNN-LSTM calculations concurrently
    logger.info("Executing CNN-LSTM inference on spatial grid...")
    ort_inputs = {session.get_inputs()[0].name: input_tensor}
    ort_outs = session.run(None, ort_inputs)
    
    # Outputs: predicted pollutant concentrations of Shape: (1, 4, 120, 80)
    output_concentrations = ort_outs[0][0]  # Shape: (4, 120, 80)
    
    # 5. CPCB Vectorized Conversion
    pm25_grid = output_concentrations[0]
    pm10_grid = output_concentrations[1]
    no2_grid = output_concentrations[2]
    so2_grid = output_concentrations[3]
    co_grid = np.random.rand(120, 80) * 5.0 # Mock remaining variables
    o3_grid = np.random.rand(120, 80) * 120.0
    
    start_time = performance_now = time.perf_counter()
    aqi_grid = calculate_cpcb_aqi_vectorized(
        pm25_grid, pm10_grid, no2_grid, so2_grid, co_grid, o3_grid
    )
    end_time = time.perf_counter()
    
    logger.info(f"Vectorized CPCB calculation finished in {(end_time - start_time) * 1000:.3f} ms!")
    logger.info(f"Calculated Grid Shape: {aqi_grid.shape}")
    logger.info(f"Grid AQI Stats -> Min: {aqi_grid.min()}, Max: {aqi_grid.max()}, Mean: {aqi_grid.mean():.2f}")

if __name__ == "__main__":
    run_pipeline_demo()
