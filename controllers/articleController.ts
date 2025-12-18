// controllers/articleController.ts
import { Request, Response } from 'express';
import asyncHandler from '../utils/asyncHandler';
import articleService from '../services/articleService';
import schemas from '../utils/validationSchemas';
import redisClient from '../utils/redisClient'; // Added for caching

// --- 1. Smart Trending Topics ---
export const getTrendingTopics = asyncHandler(async (req: Request, res: Response) => {
    // Validate (though params are empty, this strips unknown trash)
    schemas.trending.parse({ query: req.query });

    // CACHE IMPLEMENTATION: Cache trending topics for 30 minutes (1800s)
    // The trends don't change every second, so this saves massive DB load.
    const topics = await redisClient.getOrFetch(
        'trending:topics',
        async () => await articleService.getTrendingTopics(),
        1800
    );

    res.set('Cache-Control', 'public, max-age=1800'); 
    res.status(200).json({ topics });
});

// --- 2. Intelligent Search ---
export const searchArticles = asyncHandler(async (req: Request, res: Response) => {
    // Strict Validation
    const { query } = schemas.search.parse({ query: req.query });
    
    const searchTerm = query.q || '';
    const limit = query.limit || 20;

    // CACHE IMPLEMENTATION: Cache identical searches for 2 minutes (120s)
    // If 100 people search "Election" at the same time, we only run the query once.
    const cacheKey = `search:${searchTerm.toLowerCase().trim()}:${limit}`;
    
    const result = await redisClient.getOrFetch(
        cacheKey,
        async () => await articleService.searchArticles(searchTerm, limit),
        120
    );

    res.status(200).json({ articles: result.articles, pagination: { total: result.total } });
});

// --- 3. Main Feed ---
export const getMainFeed = asyncHandler(async (req: Request, res: Response) => {
    // Strict Validation
    const { query } = schemas.feedFilters.parse({ query: req.query });

    // CACHE IMPLEMENTATION: Cache feed results for 5 minutes (300s)
    // We create a unique key based on the filters applied.
    const cacheKey = `feed:main:${JSON.stringify(query)}`;

    const result = await redisClient.getOrFetch(
        cacheKey,
        async () => await articleService.getMainFeed(query),
        300
    );
    
    // Set headers for Browser Caching
    res.set('Cache-Control', 'public, max-age=300');
    res.status(200).json(result);
});

// --- 4. "For You" Feed ---
export const getForYouFeed = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user?.uid;
    // We don't cache "For You" feeds heavily in Redis because they are unique per user 
    // and might consume too much memory if you have millions of users. 
    // Browser caching (client-side) is sufficient here.
    
    const result = await articleService.getForYouFeed(userId);
    res.status(200).json(result);
});

// --- 5. Personalized "My Mix" Feed ---
export const getPersonalizedFeed = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.uid; 
    const result = await articleService.getPersonalizedFeed(userId);
    res.status(200).json(result);
});

// --- 6. Saved Articles ---
export const getSavedArticles = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.user!.uid;
    const articles = await articleService.getSavedArticles(userId);
    res.status(200).json({ articles });
});

// --- 7. Toggle Save ---
export const toggleSaveArticle = asyncHandler(async (req: Request, res: Response) => {
    // Validate ID format
    const { params } = schemas.saveArticle.parse({ params: req.params });
    
    const userId = req.user!.uid;
    
    const result = await articleService.toggleSaveArticle(userId, params.id);
    res.status(200).json(result);
});
