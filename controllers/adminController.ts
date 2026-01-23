// controllers/adminController.ts
import { Request, Response, NextFunction } from 'express';
import Prompt from '../models/aiPrompts';
import Article from '../models/articleModel';
import Profile from '../models/profileModel'; // Assumes default export is the Model
import SystemConfig from '../models/systemConfigModel';
import AppError from '../utils/AppError';
import { CONSTANTS } from '../utils/constants';
import logger from '../utils/logger';

// --- AI PROMPT MANAGEMENT ---

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

// --- ARTICLE MANAGEMENT (Newsroom) ---

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

    article.isLatest = !article.isLatest;
    await article.save();

    logger.warn(`Admin ${req.user?.uid || 'Unknown'} toggled visibility for article ${id}`);

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

// --- USER MANAGEMENT (Batch 2) ---

// @desc    Get All Users (Searchable)
// @route   GET /api/admin/users
// @access  Admin
export const getAllUsers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string;
    const skip = (page - 1) * limit;

    let query = {};
    if (search) {
      // Simple regex search for email or display name
      query = {
        $or: [
          { email: { $regex: search, $options: 'i' } },
          { displayName: { $regex: search, $options: 'i' } }
        ]
      };
    }

    const users = await Profile.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Profile.countDocuments(query);

    res.status(200).json({
      status: 'success',
      results: users.length,
      total,
      page,
      pages: Math.ceil(total / limit),
      data: {
        users
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get Single User Profile
// @route   GET /api/admin/users/:id
// @access  Admin
export const getUserById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const userProfile = await Profile.findOne({ uid: id }); // Assuming look up by UID

    if (!userProfile) {
      return next(new AppError('User profile not found', 404, CONSTANTS.ERROR_CODES.NOT_FOUND));
    }

    res.status(200).json({
      status: 'success',
      data: {
        userProfile
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update User Status (Ban/Suspend/Role)
// @route   PATCH /api/admin/users/:id
// @access  Admin
export const updateUserStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { role, isBanned, accountStatus } = req.body; 

    // Look up by UID
    const userProfile = await Profile.findOne({ uid: id });

    if (!userProfile) {
      return next(new AppError('User profile not found', 404, CONSTANTS.ERROR_CODES.NOT_FOUND));
    }

    // Only allow updating specific administrative fields
    // We treat 'any' casting here to allow flexibility if the model interface hasn't been updated yet
    if (role !== undefined) (userProfile as any).role = role; 
    if (isBanned !== undefined) (userProfile as any).isBanned = isBanned;
    if (accountStatus !== undefined) (userProfile as any).accountStatus = accountStatus;

    await userProfile.save();

    logger.warn(`Admin ${req.user?.uid} updated user ${id} status.`);

    res.status(200).json({
      status: 'success',
      data: {
        uid: userProfile.uid,
        role: (userProfile as any).role,
        isBanned: (userProfile as any).isBanned
      }
    });
  } catch (error) {
    next(error);
  }
};

// --- SYSTEM CONFIGURATION (Batch 2) ---

// @desc    Get System Configs
// @route   GET /api/admin/config
// @access  Admin
export const getSystemConfigs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const configs = await SystemConfig.find({});
    
    res.status(200).json({
      status: 'success',
      results: configs.length,
      data: {
        configs
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update or Create System Config
// @route   POST /api/admin/config
// @access  Admin
export const updateSystemConfig = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { key, value } = req.body;

    if (!key) {
      return next(new AppError('Config key is required', 400, CONSTANTS.ERROR_CODES.VALIDATION_ERROR));
    }

    // Upsert: Update if exists, Insert if new
    const config = await SystemConfig.findOneAndUpdate(
      { key },
      { 
        value: Array.isArray(value) ? value : [value], // Ensure value is array
        lastUpdated: new Date()
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    logger.info(`Admin ${req.user?.uid} updated system config: ${key}`);

    res.status(200).json({
      status: 'success',
      data: {
        config
      }
    });
  } catch (error) {
    next(error);
  }
};
