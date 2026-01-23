// narrative-backend/controllers/adminController.ts
import { Request, Response, NextFunction } from 'express';
import Prompt from '../models/aiPrompts';
import Article from '../models/articleModel';
import Profile from '../models/profileModel'; 
import SystemConfig from '../models/systemConfigModel';
import AppError from '../utils/AppError';
import { CONSTANTS } from '../utils/constants';
import logger from '../utils/logger';

// --- DASHBOARD STATS (NEW) ---

// @desc    Get Admin Dashboard Stats
// @route   GET /api/admin/dashboard
// @access  Admin
export const getDashboardStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Run queries in parallel for performance
    const [userCount, articleCount, trashedArticleCount, configCount] = await Promise.all([
      Profile.countDocuments({}),
      Article.countDocuments({ deletedAt: null }),
      Article.countDocuments({ deletedAt: { $ne: null } }),
      SystemConfig.countDocuments({})
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        stats: {
          totalUsers: userCount,
          activeArticles: articleCount,
          archivedArticles: trashedArticleCount,
          systemConfigs: configCount,
          systemStatus: 'Operational', // You could expand this to check Redis/DB health later
          databaseStatus: 'Connected'
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

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

// @desc    Get All Articles (Active Only - Default)
// @route   GET /api/admin/articles
// @access  Admin
export const getAllArticles = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    // Filter: By default, only show articles NOT in the trash
    const query = { deletedAt: null };

    const articles = await Article.find(query)
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Article.countDocuments(query);

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

// @desc    Get Archived Articles (Trash Bin)
// @route   GET /api/admin/trash/articles
// @access  Admin
export const getArchivedArticles = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    // Filter: Show ONLY articles in the trash
    const query = { deletedAt: { $ne: null } };

    const articles = await Article.find(query)
      .sort({ deletedAt: -1 }) // Show recently deleted first
      .skip(skip)
      .limit(limit);

    const total = await Article.countDocuments(query);

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

// @desc    Create Manual Article
// @route   POST /api/admin/articles
// @access  Admin
export const createArticle = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // We allow passing partial data, but headline/summary are required by Schema
    const article = await Article.create({
        ...req.body,
        source: req.body.source || 'Narrative Editorial',
        publishedAt: req.body.publishedAt || new Date(),
        isLatest: true
    });

    logger.info(`Admin ${req.user?.uid || 'Unknown'} created manual article: ${article.headline}`);

    res.status(201).json({
      status: 'success',
      data: {
        article
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get Single Article by ID
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
    const updates = req.body;

    // Prevent overwriting ID or immutable fields
    delete updates._id;
    delete updates.createdAt;
    
    const article = await Article.findByIdAndUpdate(id, updates, {
        new: true,
        runValidators: true
    });

    if (!article) {
      return next(new AppError('Article not found', 404, CONSTANTS.ERROR_CODES.NOT_FOUND));
    }

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

// @desc    Archive Article (Move to Trash)
// @route   DELETE /api/admin/articles/:id
// @access  Admin
export const archiveArticle = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    
    const article = await Article.findByIdAndUpdate(id, {
        deletedAt: new Date(),
        isLatest: false // Hide from feed immediately
    }, { new: true });

    if (!article) {
      return next(new AppError('Article not found', 404, CONSTANTS.ERROR_CODES.NOT_FOUND));
    }

    logger.info(`Admin ${req.user?.uid} archived article ${id}`);

    res.status(200).json({
      status: 'success',
      message: 'Article moved to trash. Will be permanently deleted in 30 days.',
      data: { id: article._id }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Restore Article (From Trash)
// @route   POST /api/admin/articles/:id/restore
// @access  Admin
export const restoreArticle = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    
    const article = await Article.findByIdAndUpdate(id, {
        deletedAt: null,
        isLatest: true // Re-enable visibility (or keep previous state if more complex)
    }, { new: true });

    if (!article) {
      return next(new AppError('Article not found', 404, CONSTANTS.ERROR_CODES.NOT_FOUND));
    }

    logger.info(`Admin ${req.user?.uid} restored article ${id}`);

    res.status(200).json({
      status: 'success',
      message: 'Article restored from trash.',
      data: { article }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Toggle Article Visibility (Quick Hide without Trash)
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
    const userProfile = await Profile.findOne({ userId: id });

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

    const userProfile = await Profile.findOne({ userId: id });

    if (!userProfile) {
      return next(new AppError('User profile not found', 404, CONSTANTS.ERROR_CODES.NOT_FOUND));
    }

    if (role !== undefined) (userProfile as any).role = role; 
    if (isBanned !== undefined) (userProfile as any).isBanned = isBanned;
    if (accountStatus !== undefined) (userProfile as any).accountStatus = accountStatus;

    await userProfile.save();

    logger.warn(`Admin ${req.user?.uid} updated user ${id} status.`);

    res.status(200).json({
      status: 'success',
      data: {
        uid: userProfile.userId,
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
