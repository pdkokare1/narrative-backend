// controllers/weatherController.ts
import { Request, Response } from 'express';
import { fetchWeather } from '../services/weatherService';
import asyncHandler from '../utils/asyncHandler';

export const getWeather = asyncHandler(async (req: Request, res: Response) => {
  const { lat, lon } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ success: false, message: 'Latitude and Longitude required' });
  }

  const latitude = parseFloat(lat as string);
  const longitude = parseFloat(lon as string);

  if (isNaN(latitude) || isNaN(longitude)) {
    return res.status(400).json({ success: false, message: 'Invalid coordinates' });
  }

  const data = await fetchWeather(latitude, longitude);

  if (!data) {
    return res.status(503).json({ success: false, message: 'Weather service unavailable' });
  }

  res.json({
    success: true,
    data
  });
});
