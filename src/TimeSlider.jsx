// TimeSlider.jsx
import React, { useState, useEffect, useRef } from 'react';
import './TimeSlider.css';

const TimeSlider = ({ min = 0, max = 24, step = 1, initialValue = 0, onChange, formatLabel }) => {
  const [value, setValue] = useState(initialValue);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1000); // ms per step
  const intervalRef = useRef(null);

  // Debounced callback to notify map parent of changes
  useEffect(() => {
    const handler = setTimeout(() => {
      onChange(value);
    }, 100); // 100ms debounce to prevent layout/map rendering thrashing

    return () => clearTimeout(handler);
  }, [value, onChange]);

  // Handle Playback Interval
  useEffect(() => {
    if (isPlaying) {
      intervalRef.current = setInterval(() => {
        setValue((prevValue) => {
          if (prevValue >= max) {
            return min; // Loop playback
          }
          return prevValue + step;
        });
      }, speed);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isPlaying, max, min, step, speed]);

  const togglePlay = () => setIsPlaying(!isPlaying);
  const handleSliderChange = (e) => {
    setValue(Number(e.target.value));
  };

  const getLabel = (val) => {
    return formatLabel ? formatLabel(val) : `Day ${val}`;
  };

  return (
    <div className="time-slider-container">
      <div className="time-slider-header">
        <span className="time-slider-label">Timeline: <strong>{getLabel(value)}</strong></span>
        <div className="time-slider-controls">
          <button 
            className={`control-btn play-btn ${isPlaying ? 'playing' : ''}`} 
            onClick={togglePlay}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            ) : (
              <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
            )}
          </button>
          
          <select 
            className="speed-select" 
            value={speed} 
            onChange={(e) => setSpeed(Number(e.target.value))}
            aria-label="Playback Speed"
          >
            <option value={2000}>0.5x Speed</option>
            <option value={1000}>1.0x Speed</option>
            <option value={500}>2.0x Speed</option>
            <option value={250}>4.0x Speed</option>
          </select>
        </div>
      </div>
      
      <div className="slider-track-wrapper">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={handleSliderChange}
          className="timeline-slider"
        />
        <div className="slider-ticks">
          {Array.from({ length: Math.floor((max - min) / step) + 1 }).map((_, idx) => {
            const tickVal = min + idx * step;
            // Only show labels for some ticks to avoid clutter
            const showLabel = idx % Math.max(1, Math.floor((max - min) / 6)) === 0;
            return (
              <div key={tickVal} className="slider-tick">
                <div className="tick-line"></div>
                {showLabel && <span className="tick-label">{getLabel(tickVal)}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default TimeSlider;
