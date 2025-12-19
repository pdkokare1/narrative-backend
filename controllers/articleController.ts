// controllers/articleController.ts
import { Request, Response } from 'express';
import asyncHandler from '../utils/asyncHandler';
import articleService from '../services/articleService';
import schemas from '../utils/validationSchemas';
import AppError from '../utils/AppError';

// --- 1. Smart Trending Topics ---
export const getTrendingTopics = asyncHandler(async (req: Request, res: Response) => {
    // Validate
    schemas.trending.parse({ query: req.query });

    const topics = await articleService.getTrendingTopics();

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
    // Strict Validation - We allow the service to handle defaults if params are missing
    let queryParams: any = {};
    try {
        const parsed = schemas.feedFilters.parse({ query: req.query });
        queryParams = parsed.query;
    } catch (e) {
        // Fallback: If strict validation fails on an optional field, just use raw query
        console.warn("Validation Warning (MainFeed):", e);
        
        // FIX: Ensure limit and offset are NUMBERS if we fallback to raw query
        const raw = req.query as any;
        queryParams = {
            ...raw,
            limit: raw.limit ? parseInt(raw.limit as string, 10) : 20,
            offset: raw.offset ? parseInt(raw.offset as string, 10) : 0
        };
    }

    const result = await articleService.getMainFeed(queryParams);
    
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
