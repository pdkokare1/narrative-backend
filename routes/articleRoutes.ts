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
    toggleSaveArticle,
    getSmartBriefing // <--- IMPORTED
} from '../controllers/articleController';

const router = express.Router();

// --- Public / Semi-Public Routes ---

// 1. Trending Topics (Cached via Service)
router.get('/trending', getTrendingTopics);

// 2. Smart Briefing (AI Generated Daily Summary)
// Must be defined before generic routes
router.get('/articles/smart-briefing', getSmartBriefing);

// 3. Search (Atlas Search -> Text Fallback)
// FIXED: Removed 'query' arg to enable strict mode validation
router.get('/search', searchLimiter, validate(schemas.search), searchArticles);

// 4. Main Feed (Filterable & Cached)
// FIXED: Removed 'query' arg to enable strict mode validation
router.get('/articles', validate(schemas.feedFilters), getMainFeed);

// 5. For You (Challenger Feed - Personalized for Guests & Users)
router.get('/articles/for-you', optionalAuth, getForYouFeed);

// --- Protected Routes (Require Login) ---

// 6. Personalized Feed (Vector AI Match)
router.get('/articles/personalized', checkAuth, getPersonalizedFeed);

// 7. Saved Articles
router.get('/saved', checkAuth, getSavedArticles);

// FIXED: Removed 'params' arg to match the schema structure { params: { id: ... } }
router.post('/:id/save', checkAuth, validate(schemas.saveArticle), toggleSaveArticle);

export default router;
