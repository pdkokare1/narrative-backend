// services/weatherService.ts
import axios from 'axios';
import logger from '../utils/logger';

const WEATHER_BASE_URL = 'https://api.open-meteo.com/v1/forecast';
const GEO_BASE_URL = 'https://geocoding-api.open-meteo.com/v1/reverse';

interface WeatherData {
  city: string;
  temperature: number;
  weatherCode: number;
  isDay: boolean;
}

export const fetchWeather = async (lat: number, lon: number): Promise<WeatherData | null> => {
  try {
    // 1. Fetch Weather Data (Primary - Must Succeed)
    const weatherResponse = await axios.get(WEATHER_BASE_URL, {
      params: {
        latitude: lat,
        longitude: lon,
        current_weather: true,
        temperature_unit: 'celsius',
      },
      timeout: 5000
    });

    const current = weatherResponse.data.current_weather;
    let cityName = "Local Weather";

    // 2. Fetch Location Name (Secondary - Optional)
    // We wrap this in its own try/catch so it doesn't break the weather display if it fails
    try {
        const locationResponse = await axios.get(GEO_BASE_URL, {
            params: {
                latitude: lat,
                longitude: lon,
                count: 1, 
                language: 'en'
            },
            timeout: 3000 // Shorter timeout for name lookup
        });

        if (locationResponse.data.results && locationResponse.data.results.length > 0) {
            cityName = locationResponse.data.results[0].name || locationResponse.data.results[0].admin1 || "Local Weather";
        }
    } catch (geoError) {
        // Silently fail on city name, just log it as a warning
        logger.warn('⚠️ Weather Geo-lookup failed, using default name.');
    }

    return {
      city: cityName,
      temperature: current.temperature,
      weatherCode: current.weathercode,
      isDay: current.is_day === 1
    };

  } catch (error: any) {
    logger.error(`❌ Weather Service Error: ${error.message}`);
    return null;
  }
};
