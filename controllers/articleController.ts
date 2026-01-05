// controllers/articleController.ts
import { Request, Response } from 'express';
import asyncHandler from '../utils/asyncHandler';
import articleService from '../services/articleService';
import schemas from '../utils/validationSchemas';
import AppError from '../utils/AppError';
import redisClient from '../utils/redisClient'; 

// --- 1. Smart Trending Topics ---
export const getTrendingTopics = asyncHandler(async (req: Request, res: Response) => {
    // Validate
    schemas.trending.parse({ query: req.query });

    const CACHE_KEY = 'trending:topics';
    
    // REFACTOR: Use centralized getOrFetch logic
    // Automatically handles: Cache Hit -> Return, Cache Miss -> Fetch -> Cache -> Return
    // Also handles anti-stampede (multiple users hitting same endpoint simultaneously)
    const topics = await redisClient.getOrFetch(
        CACHE_KEY, 
        async () => await articleService.getTrendingTopics(), 
        600 // 10 minutes
    );

    // Cache-Control Header for Browser/CDN
    res.set('Cache-Control', 'public, max-age=300'); 
    res.status(200).json({ topics });
});

// --- 2. Intelligent Search ---
export const searchArticles = asyncHandler(async (req: Request, res: Response) => {
    // Strict Validation
    const { query } = schemas.search.parse({ query: req.query });
    
    const searchTerm = query.q || '';
    const limit = query.limit || 20;

    const result = await articleService.searchArticles(searchTerm, limit);

    res.status(200).json({ articles: result.articles, pagination: { total: result.total } });
});

// --- 3. Main Feed ---
export const getMainFeed = asyncHandler(async (req: Request, res: Response) => {
    let queryParams: any = {};
    
    // STRICT VALIDATION
    try {
        const parsed = schemas.feedFilters.parse({ query: req.query });
        queryParams = parsed.query;
    } catch (e) {
        console.warn("⚠️ Feed Validation Failed. Using Defaults.");
        queryParams = {
            limit: 24, // Updated default to match frontend
            offset: 0,
            category: 'All Categories'
        };
    }

    // Ensure numeric types for pagination
    if (queryParams.limit) queryParams.limit = Number(queryParams.limit) || 24;
    if (queryParams.offset) queryParams.offset = Number(queryParams.offset) || 0;

    // CACHE LOGIC for Default Feed (Page 0 only)
    // FIX: Updated to accept 20 or 24 limit to match Frontend BATCH_SIZE
    const isDefaultPage = queryParams.offset === 0 && 
                          (queryParams.limit === 20 || queryParams.limit === 24) && 
                          (queryParams.category === 'All Categories' || queryParams.category === 'All') && 
                          (!queryParams.lean || queryParams.lean === 'All Leans');
    
    const CACHE_KEY = 'feed:default:page0';

    let result;

    if (isDefaultPage) {
        // Use Controller-level caching (5 mins). 
        // This is the primary defense against high traffic.
        result = await redisClient.getOrFetch(
            CACHE_KEY,
            async () => await articleService.getMainFeed(queryParams),
            300 // 5 minutes TTL
        );
    } else {
        // Dynamic filters or deeper pages (not cached at controller level)
        result = await articleService.getMainFeed(queryParams);
    }
    
    // --- CACHE HEADER STRATEGY (CRITICAL FIX) ---
    // 1. Polling Requests (limit=1): DISABLE CACHE to ensure "New Articles" pill appears instantly.
    if (queryParams.limit === 1) {
        res.set('Cache-Control', 'no-store, max-age=0');
    }
    // 2. Default Page: Cache for 5 mins (Matches Redis TTL)
    else if (isDefaultPage) {
        res.set('Cache-Control', 'public, max-age=300');
    }
    // 3. Filtered Pages: Cache for 1 min (Short lived)
    else {
        res.set('Cache-Control', 'public, max-age=60');
    }

    res.status(200).json(result);
});

// --- 4. "For You" Feed ---
export const getForYouFeed = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.uid;
    
    if (!userId) {
        throw new AppError('User not authenticated for personalized feed', 401);
    }

    try {
        const result = await articleService.getForYouFeed(userId);
        res.status(200).json(result);
    } catch (error: any) {
        // Log specifically for monitoring
        console.error(`[PERSONALIZATION_FAILURE] User: ${userId} - ${error.message}`);
        
        // Fallback to avoid crushing the app
        res.status(200).json({ 
            articles: [], 
            meta: { basedOnCategory: 'General', usualLean: 'Neutral' } 
        });
    }
});

// --- 5. Personalized "My Mix" Feed ---
export const getPersonalizedFeed = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.uid;
    
    if (!userId) {
        throw new AppError('User not authenticated for personalized feed', 401);
    }

    try {
        const result = await articleService.getPersonalizedFeed(userId);
        res.status(200).json(result);
    } catch (error: any) {
         console.error(`[PERSONALIZATION_FAILURE] User: ${userId} - ${error.message}`);
         // Graceful fallback
         res.status(200).json({ articles: [], meta: { topCategories: [] } });
    }
});

// --- 6. Saved Articles ---
export const getSavedArticles = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.uid;
    if (!userId) throw new AppError('User not authenticated', 401);

    const articles = await articleService.getSavedArticles(userId);
    res.status(200).json({ articles });
});

// --- 7. Toggle Save ---
export const toggleSaveArticle = asyncHandler(async (req: Request, res: Response) => {
    // Validate ID format
    const { params } = schemas.saveArticle.parse({ params: req.params });
    const userId = req.user?.uid;
    if (!userId) throw new AppError('User not authenticated', 401);
    
    const result = await articleService.toggleSaveArticle(userId, params.id);
    res.status(200).json(result);
});
