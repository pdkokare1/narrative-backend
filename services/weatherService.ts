// services/weatherService.ts
import axios from 'axios';
import logger from '../utils/logger';

const BASE_URL = 'https://api.open-meteo.com/v1/forecast';

interface WeatherData {
  temperature: number;
  weatherCode: number;
  isDay: boolean;
}

export const fetchWeather = async (lat: number, lon: number): Promise<WeatherData | null> => {
  try {
    const response = await axios.get(BASE_URL, {
      params: {
        latitude: lat,
        longitude: lon,
        current_weather: true,
        temperature_unit: 'celsius',
      },
      timeout: 5000 // 5 second timeout
    });

    const current = response.data.current_weather;

    return {
      temperature: current.temperature,
      weatherCode: current.weathercode,
      isDay: current.is_day === 1
    };
  } catch (error: any) {
    logger.error(`❌ Weather Service Error: ${error.message}`);
    return null;
  }
};
