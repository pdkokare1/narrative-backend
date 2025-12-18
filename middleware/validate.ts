// middleware/validate.ts
import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError, ZodSchema } from 'zod';
import logger from '../utils/logger';

/**
 * Validates the request against a Zod Schema.
 * Supports both Legacy Mode (2 args) and Strict Mode (1 arg).
 */
const validate = (schema: ZodSchema<any>, source?: 'body' | 'query' | 'params') => async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (source) {
        // --- COMPATIBILITY MODE (Legacy) ---
        // Used by existing routes (e.g., clusterRoutes) that haven't been refactored yet.
        await schema.parseAsync(req[source]);
    } else {
        // --- STRICT MODE (New) ---
        // Used by new routes (e.g., profileRoutes) for full safety.
        await schema.parseAsync({
            body: req.body,
            query: req.query,
            params: req.params,
        });
    }

    return next();
  } catch (error) {
    if (error instanceof ZodError) {
      logger.warn(`🛡️ Validation Failed [${req.method} ${req.originalUrl}]: ${error.errors.map(e => e.message).join(', ')}`);
      
      return res.status(400).json({
        status: 'error',
        message: 'Invalid input data',
        errors: error.errors.map((err) => ({
            field: err.path.join('.'),
            message: err.message
        }))
      });
    }
    return next(error);
  }
};

export default validate;
