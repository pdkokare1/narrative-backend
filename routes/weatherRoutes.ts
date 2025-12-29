// routes/weatherRoutes.ts
import express from 'express';
import { getWeather } from '../controllers/weatherController';
// Optionally add rate limiting here if needed, but the main api limiter covers it

const router = express.Router();

router.get('/', getWeather);

export default router;
