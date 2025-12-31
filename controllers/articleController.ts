// controllers/articleController.ts
import { Request, Response } from 'express';
import asyncHandler from '../utils/asyncHandler';
import articleService from '../services/articleService';
import schemas from '../utils/validationSchemas';
import AppError from '../utils/AppError';
import redisClient from '../utils/redisClient'; 

// --- 1. Smart Trending Topics ---
export const getTrendingTopics = asyncHandler(async (req: Request, res: Response) => {
    schemas.trending.parse({ query: req.query });

    const CACHE_KEY = 'trending:topics';
    
    const topics = await redisClient.getOrFetch(
        CACHE_KEY, 
        async () => await articleService.getTrendingTopics(), 
        600 
    );

    res.set('Cache-Control', 'public, max-age=300'); 
    res.status(200).json({ topics });
});

// --- 2. Intelligent Search ---
export const searchArticles = asyncHandler(async (req: Request, res: Response) => {
    const { query } = schemas.search.parse({ query: req.query });
    
    const searchTerm = query.q || '';
    const limit = query.limit || 20;

    const result = await articleService.searchArticles(searchTerm, limit);

    res.status(200).json({ articles: result.articles, pagination: { total: result.total } });
});

// --- 3. Main Feed ---
export const getMainFeed = asyncHandler(async (req: Request, res: Response) => {
    let queryParams: any = {};
    
    try {
        const parsed = schemas.feedFilters.parse({ query: req.query });
        queryParams = parsed.query;
    } catch (e) {
        console.warn("⚠️ Feed Validation Failed. Using Defaults.");
        queryParams = { limit: 20, offset: 0, category: 'All Categories' };
    }

    if (queryParams.limit) queryParams.limit = Number(queryParams.limit) || 20;
    if (queryParams.offset) queryParams.offset = Number(queryParams.offset) || 0;

    const result = await articleService.getMainFeed(queryParams);
    
    // UI/UX IMPROVEMENT:
    // Added 'stale-while-revalidate=60'. 
    // This serves slightly old content INSTANTLY while updating in the background.
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
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
        console.error(`[PERSONALIZATION_FAILURE] User: ${userId} - ${error.message}`);
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
    const { params } = schemas.saveArticle.parse({ params: req.params });
    const userId = req.user?.uid;
    if (!userId) throw new AppError('User not authenticated', 401);
    
    const result = await articleService.toggleSaveArticle(userId, params.id);
    res.status(200).json(result);
});
