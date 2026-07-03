# generate_dummy_onnx.py
"""
Generates a lightweight, valid ONNX model file that runs a simple scaling prediction
on meteorological feature arrays to generate air pollutant estimates.
"""
import onnx
from onnx import helper, TensorProto

def create_model(output_path="model.onnx"):
    # Define model inputs: Shape (1, 4, 120, 80) representing meteorological variables
    # (e.g. Temperature, Relative Humidity, Wind Speed, Prior Day AQI)
    input_value = helper.make_tensor_value_info('input', TensorProto.FLOAT, [1, 4, 120, 80])
    
    # Define model outputs: Shape (1, 4, 120, 80) representing predicted concentrations of
    # PM2.5, PM10, NO2, SO2 across the 120x80 national grid.
    output_value = helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, 4, 120, 80])
    
    # Create a scaling factor initializer (constant tensor)
    scale_val = [1.25]
    scale_tensor = helper.make_tensor(
        name='scale_factor',
        data_type=TensorProto.FLOAT,
        dims=[1],
        vals=scale_val
    )
    
    # Create an additive offset initializer to simulate base pollutant levels
    offset_val = [15.0]
    offset_tensor = helper.make_tensor(
        name='offset_value',
        data_type=TensorProto.FLOAT,
        dims=[1],
        vals=offset_val
    )

    # Node 1: Scale input (Multiply)
    mul_node = helper.make_node(
        'Mul',
        inputs=['input', 'scale_factor'],
        outputs=['scaled_input']
    )
    
    # Node 2: Add base levels (Add)
    add_node = helper.make_node(
        'Add',
        inputs=['scaled_input', 'offset_value'],
        outputs=['output']
    )

    # Graph
    graph_def = helper.make_graph(
        [mul_node, add_node],
        'aqi_prediction_graph',
        [input_value],
        [output_value],
        [scale_tensor, offset_tensor]
    )

    # Model
    model_def = helper.make_model(graph_def, producer_name='aero-grid-generator')
    
    # Save model
    onnx.save(model_def, output_path)
    print(f"ONNX model saved successfully to {output_path}")

if __name__ == '__main__':
    create_model()
