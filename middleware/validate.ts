// middleware/validate.ts
import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
import logger from '../utils/logger';

const validate = (schema: ZodSchema<any>, property: 'body' | 'query' | 'params' = 'body') => {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[property]);

    if (!result.success) {
      // Format Zod errors into a readable string
      const errorMessage = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
      
      logger.warn(`Validation Error [${req.originalUrl}]: ${errorMessage}`);
      return res.status(400).json({ error: errorMessage });
    }

    // Replace request data with the clean, validated data (handles type coercion)
    req[property] = result.data;
    next();
  };
};

export default validate;
