// routes/jobRoutes.ts
import express from 'express';
import { triggerNewsFetch } from '../controllers/jobController';
// import { checkAuth } from '../middleware/authMiddleware'; // Uncomment to protect this route

const router = express.Router();

// Route: POST /api/fetch-news
// Description: Manually triggers the news fetching job
router.post('/fetch-news', triggerNewsFetch); 

export default router;
