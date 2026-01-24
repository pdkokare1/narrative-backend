// narrative-backend/controllers/adminController.ts
import { Request, Response, NextFunction } from 'express';
import Prompt from '../models/aiPrompts';
import Article from '../models/articleModel';
import Profile from '../models/profileModel'; 
import SystemConfig from '../models/systemConfigModel';
import ActivityLog from '../models/activityLogModel';
import Narrative from '../models/narrativeModel';
import AnalyticsSession from '../models/analyticsSession'; 
import UserStats from '../models/userStatsModel'; // NEW IMPORT
import AppError from '../utils/AppError';
import { CONSTANTS } from '../utils/constants';
import logger from '../utils/logger';

// --- DASHBOARD STATS ---

// @desc    Get Admin Dashboard Stats (with Charts)
// @route   GET /api/admin/dashboard
// @access  Admin
export const getDashboardStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // 1. Basic Counters
    const [userCount, articleCount, trashedArticleCount, configCount] = await Promise.all([
      Profile.countDocuments({}),
      Article.countDocuments({ deletedAt: null }),
      Article.countDocuments({ deletedAt: { $ne: null } }),
      SystemConfig.countDocuments({})
    ]);

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // 2. NEW: Engagement Split Graph (Reading vs Listening)
    // We sum up duration per day for the last 7 days
    const engagementStats = await AnalyticsSession.aggregate([
      { $match: { date: { $gte: sevenDaysAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
          reading: { $sum: "$articleDuration" },
          listening: { $sum: "$radioDuration" }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // 3. NEW: Political Compass Data (Pie Chart)
    // Summing up total minutes spent on Left/Center/Right across ALL users
    const leanAgg = await UserStats.aggregate([
        {
          $group: {
              _id: null,
              left: { $sum: "$leanExposure.Left" },
              center: { $sum: "$leanExposure.Center" },
              right: { $sum: "$leanExposure.Right" }
          }
        }
    ]);
    // Default to 0 if no stats exist yet
    const leanData = leanAgg[0] || { left: 0, center: 0, right: 0 };

    // 4. Deep Engagement Metrics (Avg Session, Scroll, Retention)
    
    // A. Average Session Time
    const sessionTimeAgg = await AnalyticsSession.aggregate([
        { $match: { date: { $gte: sevenDaysAgo } } },
        { $group: { _id: null, avgTime: { $avg: "$totalDuration" } } }
    ]);
    const avgSessionTime = sessionTimeAgg[0]?.avgTime || 0;

    // B. Average Scroll Depth
    const scrollDepthAgg = await AnalyticsSession.aggregate([
        { $match: { date: { $gte: sevenDaysAgo } } },
        { $unwind: "$interactions" },
        { $match: { 
            "interactions.contentType": { $in: ["article", "narrative"] },
            "interactions.scrollDepth": { $exists: true, $gt: 0 } 
        }},
        { $group: { _id: null, avgDepth: { $avg: "$interactions.scrollDepth" } } }
    ]);
    const avgScrollDepth = scrollDepthAgg[0]?.avgDepth || 0;

    // C. Audio Stickiness
    const audioStatsAgg = await AnalyticsSession.aggregate([
        { $match: { date: { $gte: sevenDaysAgo } } },
        { $unwind: "$interactions" },
        { $match: { 
            "interactions.contentType": "audio_action",
            "interactions.audioAction": { $in: ["start", "complete"] }
        }},
        { $group: {
            _id: null,
            starts: { $sum: { $cond: [{ $eq: ["$interactions.audioAction", "start"] }, 1, 0] } },
            completes: { $sum: { $cond: [{ $eq: ["$interactions.audioAction", "complete"] }, 1, 0] } }
        }}
    ]);
    
    const audioStarts = audioStatsAgg[0]?.starts || 0;
    const audioCompletes = audioStatsAgg[0]?.completes || 0;
    const audioRetention = audioStarts > 0 ? Math.round((audioCompletes / audioStarts) * 100) : 0;

    res.status(200).json({
      status: 'success',
      data: {
        stats: {
          totalUsers: userCount,
          activeArticles: articleCount,
          archivedArticles: trashedArticleCount,
          systemConfigs: configCount,
          systemStatus: 'Operational', 
          databaseStatus: 'Connected',
          // Metrics
          avgSessionTime: Math.round(avgSessionTime),
          avgScrollDepth: Math.round(avgScrollDepth),
          audioRetention
        },
        // Updated Graph Data Structure
        graphData: engagementStats, 
        // New Pie Data
        leanData: { 
            left: Math.round(leanData.left / 60), // Convert seconds to minutes
            center: Math.round(leanData.center / 60),
            right: Math.round(leanData.right / 60)
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// --- ACTIVITY LOGS ---

// @desc    Get Activity Logs (Paginated)
// @route   GET /api/admin/logs
// @access  Admin
export const getActivityLogs = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = (page - 1) * limit;

    const logs = await ActivityLog.find({})
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit);

    const total = await ActivityLog.countDocuments({});

    res.status(200).json({
      status: 'success',
      results: logs.length,
      total,
      page,
      pages: Math.ceil(total / limit),
      data: {
        logs
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

// @desc    Create a System Prompt (For Seeding)
// @route   POST /api/admin/prompts
// @access  Admin
export const createSystemPrompt = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { type, text, description } = req.body;

    // Check if exists
    const existing = await Prompt.findOne({ type });
    if (existing) {
       return next(new AppError('Prompt type already exists', 400, CONSTANTS.ERROR_CODES.VALIDATION_ERROR));
    }

    const prompt = await Prompt.create({
        type,
        text,
        description,
        active: true,
        version: 1
    });

    logger.info(`Admin ${req.user?.uid || 'Unknown'} created prompt: ${type}`);

    res.status(201).json({
      status: 'success',
      data: { prompt }
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

// --- USER MANAGEMENT ---

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

// --- SYSTEM CONFIGURATION ---

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

// --- NARRATIVE MANAGEMENT (NEW) ---

// @desc    Get All Narratives
// @route   GET /api/admin/narratives
// @access  Admin
export const getAllNarratives = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const skip = (page - 1) * limit;

        // Sort by lastUpdated to see newest stories first
        const narratives = await Narrative.find({})
            .sort({ lastUpdated: -1 })
            .skip(skip)
            .limit(limit);

        const total = await Narrative.countDocuments({});

        res.status(200).json({
            status: 'success',
            results: narratives.length,
            total,
            page,
            pages: Math.ceil(total / limit),
            data: { narratives }
        });
    } catch (error) {
        next(error);
    }
};

// @desc    Get Single Narrative
// @route   GET /api/admin/narratives/:id
// @access  Admin
export const getNarrativeById = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { id } = req.params;
        const narrative = await Narrative.findById(id);

        if (!narrative) {
            return next(new AppError('Narrative not found', 404, CONSTANTS.ERROR_CODES.NOT_FOUND));
        }

        res.status(200).json({
            status: 'success',
            data: { narrative }
        });
    } catch (error) {
        next(error);
    }
};

// @desc    Update Narrative Content
// @route   PATCH /api/admin/narratives/:id
// @access  Admin
export const updateNarrative = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        delete updates._id; // Prevent ID tampering

        const narrative = await Narrative.findByIdAndUpdate(id, updates, {
            new: true,
            runValidators: true
        });

        if (!narrative) {
            return next(new AppError('Narrative not found', 404, CONSTANTS.ERROR_CODES.NOT_FOUND));
        }

        logger.info(`Admin ${req.user?.uid || 'Unknown'} updated narrative: ${id}`);

        res.status(200).json({
            status: 'success',
            data: { narrative }
        });
    } catch (error) {
        next(error);
    }
};
