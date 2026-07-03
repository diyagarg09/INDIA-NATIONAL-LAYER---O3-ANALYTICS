/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        cpcb: {
          good: '#22c55e',       // 0-50 (Green)
          satisfactory: '#84cc16', // 51-100 (Light Green/Lime)
          moderate: '#eab308',   // 101-200 (Yellow)
          poor: '#f97316',       // 201-300 (Orange)
          verypoor: '#ef4444',   // 301-400 (Red)
          severe: '#7e22ce',     // 401-500 (Purple/Maroon)
        }
      }
    },
  },
  plugins: [],
}
