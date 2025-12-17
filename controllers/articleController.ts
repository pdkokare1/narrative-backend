// controllers/articleController.ts
import { Request, Response } from 'express';
import asyncHandler from '../utils/asyncHandler';
import articleService from '../services/articleService';

// --- 1. Smart Trending Topics ---
export const getTrendingTopics = asyncHandler(async (req: Request, res: Response) => {
    const topics = await articleService.getTrendingTopics();
    res.set('Cache-Control', 'public, max-age=1800'); 
    res.status(200).json({ topics });
});

// --- 2. Intelligent Search ---
export const searchArticles = asyncHandler(async (req: Request, res: Response) => {
    const query = (req.query.q as string)?.trim() || '';
    const limit = parseInt(req.query.limit as string) || 12;

    const result = await articleService.searchArticles(query, limit);
    res.status(200).json({ articles: result.articles, pagination: { total: result.total } });
});

// --- 3. Main Feed ---
export const getMainFeed = asyncHandler(async (req: Request, res: Response) => {
    const result = await articleService.getMainFeed(req.query);
    
    // Set headers for Browser Caching (reduces hits to your server)
    res.set('Cache-Control', 'public, max-age=300');
    res.status(200).json(result);
});

// --- 4. "For You" Feed ---
export const getForYouFeed = asyncHandler(async (req: Request, res: Response) => {
    // @ts-ignore - 'user' is populated by auth middleware
    const userId = req.user?.uid;
    const result = await articleService.getForYouFeed(userId);
    res.status(200).json(result);
});

// --- 5. Personalized "My Mix" Feed ---
export const getPersonalizedFeed = asyncHandler(async (req: Request, res: Response) => {
    // @ts-ignore
    const userId = req.user!.uid; 
    const result = await articleService.getPersonalizedFeed(userId);
    res.status(200).json(result);
});

// --- 6. Saved Articles ---
export const getSavedArticles = asyncHandler(async (req: Request, res: Response) => {
    // @ts-ignore
    const userId = req.user!.uid;
    const articles = await articleService.getSavedArticles(userId);
    res.status(200).json({ articles });
});

// --- 7. Toggle Save ---
export const toggleSaveArticle = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    // @ts-ignore
    const userId = req.user!.uid;
    
    const result = await articleService.toggleSaveArticle(userId, id);
    res.status(200).json(result);
});
