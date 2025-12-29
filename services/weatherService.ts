// services/weatherService.ts
import axios from 'axios';
import logger from '../utils/logger';

const WEATHER_BASE_URL = 'https://api.open-meteo.com/v1/forecast';
const GEO_BASE_URL = 'https://geocoding-api.open-meteo.com/v1/reverse';

interface WeatherData {
  city: string; // Added city name
  temperature: number;
  weatherCode: number;
  isDay: boolean;
}

export const fetchWeather = async (lat: number, lon: number): Promise<WeatherData | null> => {
  try {
    // 1. Fetch Weather Data
    const weatherPromise = axios.get(WEATHER_BASE_URL, {
      params: {
        latitude: lat,
        longitude: lon,
        current_weather: true,
        temperature_unit: 'celsius',
      },
      timeout: 5000
    });

    // 2. Fetch Location Name (Reverse Geocoding)
    const locationPromise = axios.get(GEO_BASE_URL, {
        params: {
            latitude: lat,
            longitude: lon,
            count: 1, // Just need the closest one
            language: 'en'
        },
        timeout: 5000
    });

    // Execute both in parallel for speed
    const [weatherRes, locationRes] = await Promise.all([weatherPromise, locationPromise]);

    const current = weatherRes.data.current_weather;
    
    // Extract city name safely
    let cityName = "Unknown Location";
    if (locationRes.data.results && locationRes.data.results.length > 0) {
        // Prefer 'name' (usually city/town), fallback to other fields if necessary
        cityName = locationRes.data.results[0].name || locationRes.data.results[0].admin1 || "Local Weather";
    }

    return {
      city: cityName,
      temperature: current.temperature,
      weatherCode: current.weathercode,
      isDay: current.is_day === 1
    };

  } catch (error: any) {
    // Log details if axios error
    if (axios.isAxiosError(error)) {
        logger.error(`❌ Weather/Geo Service Error: ${error.response?.status} - ${error.message}`);
    } else {
        logger.error(`❌ Weather Service Error: ${error.message}`);
    }
    return null;
  }
};
