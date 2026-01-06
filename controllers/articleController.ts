import { Request, Response, NextFunction } from 'express';
import { Article } from '../models/articleModel';
import { aiService } from '../services/aiService';
import { catchAsync } from '../utils/asyncHandler';
import { AppError } from '../utils/AppError';

// Get all articles with filtering, sorting, and pagination
export const getArticles = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const skip = (page - 1) * limit;

  // Build filter object
  const filter: any = {};
  
  // Filter by category
  if (req.query.category && req.query.category !== 'All') {
    filter.category = req.query.category;
  }

  // Filter by sentiment
  if (req.query.sentiment) {
    filter['analysis.sentiment'] = req.query.sentiment;
  }

  // Filter by source
  if (req.query.source) {
    filter['source.name'] = req.query.source;
  }

  // Search query
  if (req.query.search) {
    filter.$text = { $search: req.query.search as string };
  }

  // Date range
  if (req.query.startDate || req.query.endDate) {
    filter.publishedAt = {};
    if (req.query.startDate) filter.publishedAt.$gte = new Date(req.query.startDate as string);
    if (req.query.endDate) filter.publishedAt.$lte = new Date(req.query.endDate as string);
  }

  const articles = await Article.find(filter)
    .sort({ publishedAt: -1 })
    .skip(skip)
    .limit(limit);

  const total = await Article.countDocuments(filter);

  res.status(200).json({
    status: 'success',
    results: articles.length,
    total,
    page,
    totalPages: Math.ceil(total / limit),
    data: articles
  });
});

// Get single article by ID
export const getArticle = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const article = await Article.findById(req.params.id);

  if (!article) {
    return next(new AppError('No article found with that ID', 404));
  }

  res.status(200).json({
    status: 'success',
    data: article
  });
});

// Create new article (usually internal use or via scraper)
export const createArticle = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const newArticle = await Article.create(req.body);

  res.status(201).json({
    status: 'success',
    data: newArticle
  });
});

// Update article
export const updateArticle = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const article = await Article.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true
  });

  if (!article) {
    return next(new AppError('No article found with that ID', 404));
  }

  res.status(200).json({
    status: 'success',
    data: article
  });
});

// Delete article
export const deleteArticle = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  const article = await Article.findByIdAndDelete(req.params.id);

  if (!article) {
    return next(new AppError('No article found with that ID', 404));
  }

  res.status(204).json({
    status: 'success',
    data: null
  });
});

// Get trending articles (simplified logic for now)
export const getTrendingArticles = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  // Logic: recently published + high engagement score (if available) or simply recent
  const articles = await Article.find()
    .sort({ publishedAt: -1 })
    .limit(5);

  res.status(200).json({
    status: 'success',
    data: articles
  });
});

// GENERATE SMART BRIEFING
export const getSmartBriefing = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
  // 1. Fetch top relevant articles from the last 24 hours
  const oneDayAgo = new Date();
  oneDayAgo.setDate(oneDayAgo.getDate() - 1);

  const recentArticles = await Article.find({
    publishedAt: { $gte: oneDayAgo }
  })
  .sort({ 'metrics.viralityScore': -1 }) // Assuming metrics exist, otherwise sort by date
  .limit(10)
  .select('title summary category source');

  if (!recentArticles || recentArticles.length === 0) {
    return res.status(200).json({
      status: 'success',
      data: {
        title: "Daily Briefing",
        content: "No significant updates found for the last 24 hours.",
        keyPoints: []
      }
    });
  }

  // 2. Prepare context for AI
  const articlesContext = recentArticles.map(a => `- ${a.title} (${a.source.name}): ${a.summary}`).join('\n');

  // 3. Generate Briefing
  const prompt = `
    You are an expert news analyst. Create a "Smart Briefing" based on the following top news headlines from the last 24 hours.
    
    Headlines:
    ${articlesContext}

    Format the output as a valid JSON object with the following keys:
    - "title": A catchy title for today's briefing (e.g., "Market Shifts & Tech Breakthroughs").
    - "content": A concise paragraph summarizing the overall mood and major themes (approx 80-100 words).
    - "keyPoints": An array of strings, each being a bullet point of a critical update (max 5 points).

    Do not include markdown code blocks in the output, just the raw JSON string.
  `;

  let briefingData;
  try {
    const aiResponse = await aiService.generateText(prompt);
    // Clean up potential markdown formatting from AI (e.g., ```json ... ```)
    const cleanedResponse = aiResponse.replace(/```json/g, '').replace(/```/g, '').trim();
    briefingData = JSON.parse(cleanedResponse);
  } catch (error) {
    console.error("Error parsing AI briefing response:", error);
    // Fallback if AI fails to return valid JSON
    briefingData = {
      title: "Today's Headlines",
      content: "Here is a summary of the latest news based on recent reporting.",
      keyPoints: recentArticles.slice(0, 5).map(a => a.title)
    };
  }

  res.status(200).json({
    status: 'success',
    data: briefingData
  });
});
