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
    getBalancedFeed, 
    getPersonalizedFeed,
    getSavedArticles,
    toggleSaveArticle,
    getSmartBriefing,
    getInFocusFeed
} from '../controllers/articleController';

const router = express.Router();

// --- Public / Semi-Public Routes ---

// 1. Trending Topics (Cached via Service)
router.get('/trending', getTrendingTopics);

// 2. Smart Briefing (AI Generated Daily Summary)
router.get('/articles/smart-briefing', getSmartBriefing);

// 3. Search (Atlas Search -> Text Fallback)
router.get('/search', searchLimiter, validate(schemas.search), searchArticles);

// 4. Main Feed (Filterable & Cached)
router.get('/articles', validate(schemas.feedFilters), getMainFeed);

// 5. In Focus Feed (Narratives / Developing Stories)
router.get('/articles/infocus', validate(schemas.feedFilters), getInFocusFeed);

// 6. Balanced Feed (Replaces For You - Anti-Echo Chamber)
router.get('/articles/balanced', optionalAuth, getBalancedFeed);

// --- Protected Routes (Require Login) ---

// 7. Personalized Feed (Vector AI Match - Legacy/Deep Personalization)
router.get('/articles/personalized', checkAuth, getPersonalizedFeed);

// 8. Saved Articles
router.get('/saved', checkAuth, getSavedArticles);

// 9. Toggle Save
router.post('/:id/save', checkAuth, validate(schemas.saveArticle), toggleSaveArticle);

export default router;
