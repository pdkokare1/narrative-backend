// controllers/adminController.ts
import { Request, Response, NextFunction } from 'express';
import Prompt from '../models/aiPrompts';
import AppError from '../utils/AppError';
import { CONSTANTS } from '../utils/constants';
import logger from '../utils/logger';

// FIX: Local interface to bypass global type definition issues
interface IAuthRequest extends Request {
  user?: {
    uid: string;
    role?: string;
    email?: string;
    [key: string]: any;
  }
}

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
    // Cast request to access custom user property safely
    const authReq = req as IAuthRequest;
    
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

    logger.info(`Admin ${authReq.user?.uid || 'Unknown'} updated prompt: ${prompt.type} (v${prompt.version})`);

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
