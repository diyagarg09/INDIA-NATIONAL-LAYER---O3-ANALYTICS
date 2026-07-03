# cpcb_formula.py
"""
Implements the Central Pollution Control Board (CPCB) India AQI formula.
Calculates sub-indices for PM2.5, PM10, NO2, and SO2, and returns the aggregate AQI.
"""

def calculate_sub_index(value: float, breakpoints: list) -> float:
    """
    Interpolates the sub-index for a pollutant value based on CPCB breakpoint ranges.
    
    Breakpoints are list of tuples: ((low_concentration, high_concentration), (low_aqi, high_aqi))
    """
    for (c_low, c_high), (i_low, i_high) in breakpoints:
        if c_low <= value <= c_high:
            # Linear interpolation formula
            return i_low + (value - c_low) * (i_high - i_low) / (c_high - c_low)
    
    # If it exceeds the maximum breakpoint, cap it or scale it to Severe max (500)
    last_range = breakpoints[-1]
    c_high = last_range[0][1]
    i_high = last_range[1][1]
    if value > c_high:
        return i_high
    return 0.0

# Breakpoint ranges defined by CPCB guidelines
PM25_BREAKPOINTS = [
    ((0, 30), (0, 50)),
    ((31, 60), (51, 100)),
    ((61, 90), (101, 200)),
    ((91, 120), (201, 300)),
    ((121, 250), (301, 400)),
    ((250.1, 1000), (401, 500))
]

PM10_BREAKPOINTS = [
    ((0, 50), (0, 50)),
    ((51, 100), (51, 100)),
    ((101, 250), (101, 200)),
    ((251, 350), (201, 300)),
    ((351, 430), (301, 400)),
    ((430.1, 1000), (401, 500))
]

NO2_BREAKPOINTS = [
    ((0, 40), (0, 50)),
    ((41, 80), (51, 100)),
    ((81, 180), (101, 200)),
    ((181, 280), (201, 300)),
    ((281, 400), (301, 400)),
    ((400.1, 1000), (401, 500))
]

SO2_BREAKPOINTS = [
    ((0, 40), (0, 50)),
    ((41, 80), (51, 100)),
    ((81, 380), (101, 200)),
    ((381, 800), (201, 300)),
    ((801, 1600), (301, 400)),
    ((1600.1, 5000), (401, 500))
]

def calculate_cpcb_aqi(pm25: float, pm10: float, no2: float, so2: float) -> int:
    """
    Computes overall CPCB AQI based on the maximum sub-index.
    """
    sub_indices = [
        calculate_sub_index(pm25, PM25_BREAKPOINTS),
        calculate_sub_index(pm10, PM10_BREAKPOINTS),
        calculate_sub_index(no2, NO2_BREAKPOINTS),
        calculate_sub_index(so2, SO2_BREAKPOINTS),
    ]
    # Overall AQI is the max sub-index
    return int(round(max(sub_indices)))
