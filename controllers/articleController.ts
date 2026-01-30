// controllers/articleController.ts
import { Request, Response, NextFunction } from 'express';
import Article from '../models/articleModel'; 
import articleService from '../services/articleService'; 
import statsService from '../services/statsService'; 
import catchAsync from '../utils/asyncHandler'; 
import AppError from '../utils/AppError'; 
import { FeedFilters } from '../types';

// --- 1. Trending Topics ---
export const getTrendingTopics = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const topics = await articleService.getTrendingTopics();
  res.status(200).json({ status: 'success', data: topics });
});

// --- 2. Intelligent Search ---
export const searchArticles = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const query = req.query.q as string;
  if (!query) return next(new AppError('Please provide a search query', 400));

  const result = await articleService.searchArticles(query);

  statsService.logSearch(query, result.total).catch(err => console.error(err));

  res.status(200).json({
    status: 'success',
    pagination: { total: result.total },
    articles: result.articles
  });
});

// --- 3. Main Feed (Triple Zone) ---
export const getMainFeed = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req as any).user?.uid; 
  
  const filters: FeedFilters = {
    category: req.query.category as string,
    politicalLean: req.query.politicalLean as string,
    sentiment: req.query.sentiment as string,
    source: req.query.source as string,
    sort: req.query.sort as string,
    limit: Number(req.query.limit) || 20,
    offset: Number(req.query.offset) || 0,
    startDate: req.query.startDate as string,
    endDate: req.query.endDate as string,
    topic: req.query.topic as string 
  };

  const result = await articleService.getMainFeed(filters, userId);

  res.status(200).json({
    status: 'success',
    results: result.articles.length,
    total: result.pagination.total,
    data: result.articles
  });
});

// --- 4. In Focus Feed (Narratives) ---
export const getInFocusFeed = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const filters: FeedFilters = { 
      category: req.query.category as string,
      limit: Number(req.query.limit) || 20,
      offset: Number(req.query.offset) || 0
  };
  
  const result = await articleService.getInFocusFeed(filters);

  res.status(200).json({
    status: 'success',
    meta: result.meta,
    data: result.articles
  });
});

// --- 5. Balanced Feed (Anti-Echo Chamber) ---
export const getBalancedFeed = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req as any).user?.uid; 
  const result = await articleService.getBalancedFeed(userId);

  // Updated to be safe if meta is missing in new blended feed logic
  res.status(200).json({
    status: 'success',
    meta: (result as any).meta || {},
    data: result.articles
  });
});

// --- 6. Personalized Feed (Legacy/Deep) ---
export const getPersonalizedFeed = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req as any).user.uid;
  const result = await articleService.getPersonalizedFeed(userId);

  // Updated to be safe if meta is missing
  res.status(200).json({
    status: 'success',
    meta: (result as any).meta || {},
    data: result.articles
  });
});

// --- 7. Saved Articles ---
export const getSavedArticles = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req as any).user.uid;
  const articles = await articleService.getSavedArticles(userId);

  res.status(200).json({
    status: 'success',
    results: articles.length,
    data: articles
  });
});

// --- 8. Toggle Save ---
export const toggleSaveArticle = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req as any).user.uid;
  const articleId = req.params.id;

  const result = await articleService.toggleSaveArticle(userId, articleId);

  res.status(200).json({
    status: 'success',
    message: result.message,
    data: result.savedArticles
  });
});

// --- 9. Smart Briefing (Single Article) ---
export const getSmartBriefing = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const articleId = req.query.articleId as string;
    if (!articleId) return next(new AppError('Article ID required for briefing', 400));

    const article = await Article.findById(articleId).select('headline summary keyFindings recommendations trustScore politicalLean source');
    if (!article) return next(new AppError('Article not found', 404));

    const points = (article.keyFindings && article.keyFindings.length > 0) 
        ? article.keyFindings 
        : ["Analysis in progress. Key findings will appear shortly."];
        
    const recommendations = (article.recommendations && article.recommendations.length > 0)
        ? article.recommendations
        : ["Follow this topic for updates.", "Compare sources to verify details."];

    res.status(200).json({
        status: 'success',
        data: {
            title: article.headline,
            content: article.summary,
            keyPoints: points,
            recommendations: recommendations,
            meta: {
                trustScore: article.trustScore,
                politicalLean: article.politicalLean,
                source: article.source
            }
        }
    });
});

// --- CRUD Operations (Admin) ---

export const getArticle = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const article = await Article.findById(req.params.id);
  if (!article) return next(new AppError('No article found with that ID', 404));
  res.status(200).json({ status: 'success', data: article });
});

export const createArticle = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const newArticle = await Article.create(req.body);
  res.status(201).json({ status: 'success', data: newArticle });
});

export const updateArticle = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const article = await Article.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!article) return next(new AppError('No article found with that ID', 404));
  res.status(200).json({ status: 'success', data: article });
});

export const deleteArticle = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const article = await Article.findByIdAndDelete(req.params.id);
  if (!article) return next(new AppError('No article found with that ID', 404));
  res.status(204).json({ status: 'success', data: null });
});
