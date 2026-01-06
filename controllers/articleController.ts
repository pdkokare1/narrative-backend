// controllers/articleController.ts
import { Request, Response, NextFunction } from 'express';
import { Article } from '../models/articleModel';
import aiService from '../services/aiService'; // Default import
import articleService from '../services/articleService'; // Default import
import { catchAsync } from '../utils/asyncHandler';
import AppError from '../utils/AppError'; // FIXED: Default import
import { FeedFilters } from '../types';

// --- 1. Trending Topics ---
export const getTrendingTopics = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const topics = await articleService.getTrendingTopics();
  
  res.status(200).json({
    status: 'success',
    data: topics
  });
});

// --- 2. Intelligent Search ---
export const searchArticles = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const query = req.query.q as string;
  // Fallback to strict schema validation output if q isn't there (middleware might handle this)
  if (!query) return next(new AppError('Please provide a search query', 400));

  const result = await articleService.searchArticles(query);

  res.status(200).json({
    status: 'success',
    results: result.total,
    data: result.articles
  });
});

// --- 3. Main Feed ---
export const getMainFeed = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  // Cast query params to FeedFilters type
  const filters: FeedFilters = {
    category: req.query.category as string,
    politicalLean: req.query.politicalLean as string,
    sentiment: req.query.sentiment as string,
    source: req.query.source as string,
    sort: req.query.sort as string,
    limit: Number(req.query.limit) || 20,
    offset: Number(req.query.offset) || 0,
    startDate: req.query.startDate as string,
    endDate: req.query.endDate as string
  };

  const result = await articleService.getMainFeed(filters);

  res.status(200).json({
    status: 'success',
    results: result.articles.length,
    total: result.pagination.total,
    data: result.articles
  });
});

// --- 4. For You Feed ---
export const getForYouFeed = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  // req.user is populated by checkAuth/optionalAuth middleware
  const userId = (req as any).user?.uid;
  
  const result = await articleService.getForYouFeed(userId);

  res.status(200).json({
    status: 'success',
    meta: result.meta,
    data: result.articles
  });
});

// --- 5. Personalized Feed (Protected) ---
export const getPersonalizedFeed = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req as any).user.uid; // Protected route, user exists
  
  const result = await articleService.getPersonalizedFeed(userId);

  res.status(200).json({
    status: 'success',
    meta: result.meta,
    data: result.articles
  });
});

// --- 6. Saved Articles ---
export const getSavedArticles = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const userId = (req as any).user.uid;
  
  const articles = await articleService.getSavedArticles(userId);

  res.status(200).json({
    status: 'success',
    results: articles.length,
    data: articles
  });
});

// --- 7. Toggle Save ---
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

// --- 8. Smart Briefing (Daily AI Summary) ---
export const getSmartBriefing = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    // 1. Fetch top significant articles from last 24h
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
  
    // We look for articles that have a high viral score or trust score
    const topArticles = await Article.find({
      publishedAt: { $gte: oneDayAgo },
      analysisVersion: { $ne: 'pending' }
    })
    .sort({ trustScore: -1 }) 
    .limit(10) // Give AI the top 10 stories
    .select('headline summary source category')
    .lean();
  
    if (!topArticles || topArticles.length < 3) {
      // Not enough data for a briefing
      return res.status(200).json({
        status: 'success',
        data: {
          title: "Briefing Unavailable",
          content: "We are still collecting enough high-quality reports to generate today's briefing. Please check back later.",
          keyPoints: []
        }
      });
    }
  
    // 2. Use existing Narrative AI logic to synthesize them
    // We map the "Narrative" format to "Briefing" format
    try {
        const narrative = await aiService.generateNarrative(topArticles as any[]);
        
        if (narrative) {
            return res.status(200).json({
                status: 'success',
                data: {
                    title: narrative.masterHeadline || "Today's Smart Briefing",
                    content: narrative.executiveSummary || "Here is a summary of the latest top stories.",
                    keyPoints: narrative.consensusPoints || []
                }
            });
        } 
        
        throw new Error('AI returned null narrative');

    } catch (error) {
        // Fallback if AI fails (e.g., rate limit)
        console.error("Briefing Generation Failed:", error);
        
        return res.status(200).json({
            status: 'success',
            data: {
                title: "Today's Headlines",
                content: "Our AI is currently recharging. Here are the top stories you should know about right now.",
                keyPoints: topArticles.slice(0, 5).map(a => a.headline)
            }
        });
    }
});

// --- Legacy / Generic CRUD (Optional, kept for admin compatibility) ---

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
