// routes/articleRoutes.ts
import express from 'express';
import validate from '../middleware/validate';
import schemas from '../utils/validationSchemas';

// Middleware
import { checkAuth, optionalAuth } from '../middleware/authMiddleware';
import { searchLimiter } from '../middleware/rateLimiters'; // CHANGED: Import specific limiter

// Controllers
import {
    getTrendingTopics,
    searchArticles,
    getMainFeed,
    getForYouFeed,
    getPersonalizedFeed,
    getSavedArticles,
    toggleSaveArticle
} from '../controllers/articleController';

const router = express.Router();

// --- Public / Semi-Public Routes ---

// 1. Trending Topics (Cached via Service)
router.get('/trending', getTrendingTopics);

// 2. Search (Atlas Search -> Text Fallback)
// CHANGED: Added searchLimiter to prevent database spam
router.get('/search', searchLimiter, validate(schemas.search, 'query'), searchArticles);

// 3. Main Feed (Filterable & Cached)
router.get('/articles', validate(schemas.feedFilters, 'query'), getMainFeed);

// 4. For You (Challenger Feed - Personalized for Guests & Users)
router.get('/articles/for-you', optionalAuth, getForYouFeed);

// --- Protected Routes (Require Login) ---

// 5. Personalized Feed (Vector AI Match)
router.get('/articles/personalized', checkAuth, getPersonalizedFeed);

// 6. Saved Articles
router.get('/saved', checkAuth, getSavedArticles);
router.post('/:id/save', checkAuth, validate(schemas.saveArticle, 'params'), toggleSaveArticle);

export default router;
