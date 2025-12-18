// middleware/validate.ts
import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError } from 'zod';
import logger from '../utils/logger';

/**
 * Validates the request body/query/params against a Zod Schema.
 * Strips unknown keys to prevent Mass Assignment attacks.
 */
const validate = (schema: AnyZodObject) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    // 1. Parse and clean the data
    // strict() ensures no extra fields are passed, but using safeParse with
    // specific schemas is usually enough. Here we rely on the schema definition.
    await schema.parseAsync({
      body: req.body,
      query: req.query,
      params: req.params,
    });

    return next();
  } catch (error) {
    if (error instanceof ZodError) {
      // 2. Log validation failures (useful for debugging hacking attempts)
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
