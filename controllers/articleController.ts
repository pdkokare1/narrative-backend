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
    
    // 1. Try Cache
    try {
        const cached = await redisClient.get(CACHE_KEY);
        if (cached) {
            // Redis wrapper returns parsed JSON or null
            return res.status(200).json({ topics: cached });
        }
    } catch (err) {
        console.warn("Redis Cache Error (Trending):", err);
    }

    // 2. Fetch Fresh
    const topics = await articleService.getTrendingTopics();

    // 3. Save to Cache (10 minutes = 600s)
    // FIX: Use .set(key, value, ttl) matching your wrapper
    try {
        await redisClient.set(CACHE_KEY, topics, 600);
    } catch (err) { /* ignore cache write errors */ }

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
    
    // STRICT VALIDATION FIX
    try {
        const parsed = schemas.feedFilters.parse({ query: req.query });
        queryParams = parsed.query;
    } catch (e) {
        console.warn("⚠️ Feed Validation Failed. Using Defaults.");
        queryParams = {
            limit: 20,
            offset: 0,
            category: 'All Categories'
        };
    }

    // Ensure numeric types for pagination
    if (queryParams.limit) queryParams.limit = Number(queryParams.limit) || 20;
    if (queryParams.offset) queryParams.offset = Number(queryParams.offset) || 0;

    // CACHE LOGIC for Default Feed (Page 0 only)
    const isDefaultPage = queryParams.offset === 0 && 
                          queryParams.category === 'All Categories' && 
                          (!queryParams.lean || queryParams.lean === 'All Leans');
    
    const CACHE_KEY = 'feed:default:page0';

    if (isDefaultPage) {
        try {
            const cached = await redisClient.get(CACHE_KEY);
            if (cached) {
                res.set('X-Cache', 'HIT');
                // Wrapper returns parsed object
                return res.status(200).json(cached);
            }
        } catch (err) { console.warn("Redis Error:", err); }
    }

    // Fetch Fresh Data
    const result = await articleService.getMainFeed(queryParams);
    
    // Save to Cache if default page (5 minutes = 300s)
    // FIX: Use .set(key, value, ttl)
    if (isDefaultPage) {
        try {
            await redisClient.set(CACHE_KEY, result, 300);
        } catch (err) { /* ignore */ }
    }
    
    // Set headers for Browser Caching
    res.set('Cache-Control', 'public, max-age=300');
    res.status(200).json(result);
});

// --- 4. "For You" Feed ---
export const getForYouFeed = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.uid;
    
    // FIX: Ensure User ID is present before calling service
    if (!userId) {
        throw new AppError('User not authenticated for personalized feed', 401);
    }

    try {
        const result = await articleService.getForYouFeed(userId);
        res.status(200).json(result);
    } catch (error: any) {
        console.error("For You Feed Error:", error);
        // Fallback to avoid crushing the app if personalization fails
        res.status(200).json({ 
            articles: [], 
            meta: { basedOnCategory: 'General', usualLean: 'Neutral' } 
        });
    }
});

// --- 5. Personalized "My Mix" Feed ---
export const getPersonalizedFeed = asyncHandler(async (req: Request, res: Response) => {
    // FIX: Safely access uid instead of force unwrap (!)
    const userId = req.user?.uid;
    
    if (!userId) {
        throw new AppError('User not authenticated for personalized feed', 401);
    }

    try {
        const result = await articleService.getPersonalizedFeed(userId);
        res.status(200).json(result);
    } catch (error: any) {
         console.error("Personalized Feed Error:", error);
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
