// controllers/adminController.ts
import { Request, Response, NextFunction } from 'express';
import Prompt from '../models/aiPrompts';
import Article from '../models/articleModel';
import AppError from '../utils/AppError';
import { CONSTANTS } from '../utils/constants';
import logger from '../utils/logger';

// REMOVED: Local IAuthRequest interface to fix TS2430 conflict.
// We now rely on the global definition in types/express.d.ts

// --- AI PROMPT MANAGEMENT (Existing) ---

// @desc    Get all AI System Prompts
// @route   GET /api/admin/prompts
// @access  Admin
export const getSystemPrompts = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prompts = await Prompt.find({}).sort({ type: 1 });
    
    res.status(200).json({
      status: 'success',
      results: prompts.length,
      data: {
        prompts
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update a System Prompt
// @route   PATCH /api/admin/prompts/:id
// @access  Admin
export const updateSystemPrompt = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { text, active, description } = req.body;

    const prompt = await Prompt.findById(id);

    if (!prompt) {
      return next(new AppError('Prompt not found', 404, CONSTANTS.ERROR_CODES.NOT_FOUND));
    }

    // Update fields if provided
    if (text !== undefined) prompt.text = text;
    if (active !== undefined) prompt.active = active;
    if (description !== undefined) prompt.description = description;

    // Increment version automatically on change
    prompt.version = (prompt.version || 1) + 1;

    await prompt.save();

    // Use req.user directly (typed via global declaration)
    logger.info(`Admin ${req.user?.uid || 'Unknown'} updated prompt: ${prompt.type} (v${prompt.version})`);

    res.status(200).json({
      status: 'success',
      data: {
        prompt
      }
    });
  } catch (error) {
    next(error);
  }
};

// --- ARTICLE MANAGEMENT (New - Batch 1) ---

// @desc    Get All Articles (Admin View - Includes Hidden)
// @route   GET /api/admin/articles
// @access  Admin
export const getAllArticles = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    // Fetch all articles sorted by newest first
    const articles = await Article.find({})
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Article.countDocuments();

    res.status(200).json({
      status: 'success',
      results: articles.length,
      total,
      page,
      pages: Math.ceil(total / limit),
      data: {
        articles
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get Single Article by ID (Raw Data)
// @route   GET /api/admin/articles/:id
// @access  Admin
export const getArticleById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const article = await Article.findById(id);

    if (!article) {
      return next(new AppError('Article not found', 404, CONSTANTS.ERROR_CODES.NOT_FOUND));
    }

    res.status(200).json({
      status: 'success',
      data: {
        article
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update Article Metadata (Manual Override)
// @route   PATCH /api/admin/articles/:id
// @access  Admin
export const updateArticle = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    // Whitelist allowed fields to prevent overwriting system IDs or timestamps unintentionally
    const { 
      headline, 
      summary, 
      category, 
      politicalLean, 
      biasScore, 
      biasLabel,
      trustScore,
      source 
    } = req.body;

    const article = await Article.findById(id);

    if (!article) {
      return next(new AppError('Article not found', 404, CONSTANTS.ERROR_CODES.NOT_FOUND));
    }

    // Apply updates if they exist in the body
    if (headline !== undefined) article.headline = headline;
    if (summary !== undefined) article.summary = summary;
    if (category !== undefined) article.category = category;
    if (politicalLean !== undefined) article.politicalLean = politicalLean;
    if (biasScore !== undefined) article.biasScore = biasScore;
    if (biasLabel !== undefined) article.biasLabel = biasLabel;
    if (trustScore !== undefined) article.trustScore = trustScore;
    if (source !== undefined) article.source = source;

    await article.save();

    logger.info(`Admin ${req.user?.uid || 'Unknown'} manually updated article: ${id}`);

    res.status(200).json({
      status: 'success',
      data: {
        article
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Toggle Article Visibility (Kill Switch)
// @route   POST /api/admin/articles/:id/toggle-visibility
// @access  Admin
export const toggleArticleVisibility = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const article = await Article.findById(id);

    if (!article) {
      return next(new AppError('Article not found', 404, CONSTANTS.ERROR_CODES.NOT_FOUND));
    }

    // Toggle the isLatest boolean (which controls feed visibility)
    // If it was true (visible), it becomes false (hidden), and vice versa
    article.isLatest = !article.isLatest;
    
    await article.save();

    logger.warn(`Admin ${req.user?.uid || 'Unknown'} toggled visibility for article ${id}. New status: ${article.isLatest ? 'Visible' : 'Hidden'}`);

    res.status(200).json({
      status: 'success',
      data: {
        id: article._id,
        isLatest: article.isLatest
      }
    });
  } catch (error) {
    next(error);
  }
};
