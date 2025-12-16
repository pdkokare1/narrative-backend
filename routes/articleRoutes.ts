// src/routes/articleRoutes.ts
import express from 'express';
import validate from '../middleware/validate';
import schemas from '../utils/validationSchemas';

// Middleware
import { checkAuth, optionalAuth } from '../middleware/authMiddleware';

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

// Public / Semi-Public Routes
router.get('/trending', getTrendingTopics);
router.get('/search', validate(schemas.search, 'query'), searchArticles);
router.get('/articles', validate(schemas.feedFilters, 'query'), getMainFeed);
router.get('/articles/for-you', optionalAuth, getForYouFeed);

// Protected Routes (Require Login)
router.get('/articles/personalized', checkAuth, getPersonalizedFeed);
router.get('/saved', checkAuth, getSavedArticles);
router.post('/:id/save', checkAuth, validate(schemas.saveArticle, 'params'), toggleSaveArticle);

export default router;
