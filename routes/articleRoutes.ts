// routes/articleRoutes.ts
import express from 'express';
import validate from '../middleware/validate';
import schemas from '../utils/validationSchemas';

// Middleware
import { checkAuth, optionalAuth } from '../middleware/authMiddleware';
import { searchLimiter } from '../middleware/rateLimiters'; 

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
// FIXED: Removed 'query' arg to enable strict mode validation
router.get('/search', searchLimiter, validate(schemas.search), searchArticles);

// 3. Main Feed (Filterable & Cached)
// FIXED: Removed 'query' arg to enable strict mode validation
router.get('/articles', validate(schemas.feedFilters), getMainFeed);

// 4. For You (Challenger Feed - Personalized for Guests & Users)
router.get('/articles/for-you', optionalAuth, getForYouFeed);

// --- Protected Routes (Require Login) ---

// 5. Personalized Feed (Vector AI Match)
router.get('/articles/personalized', checkAuth, getPersonalizedFeed);

// 6. Saved Articles
router.get('/saved', checkAuth, getSavedArticles);

// FIXED: Removed 'params' arg to match the schema structure { params: { id: ... } }
router.post('/:id/save', checkAuth, validate(schemas.saveArticle), toggleSaveArticle);

export default router;
