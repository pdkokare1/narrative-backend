// middleware/errorMiddleware.ts
import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  // Default to 500 (Server Error) if status code isn't set or is 200
  const statusCode = res.statusCode === 200 ? 500 : res.statusCode;

  // Improved Logging: Include Method and URL for context
  logger.error(`🔥 API Error [${req.method} ${req.url}]: ${err.message}`);

  // Log stack trace only in development/test for debugging
  if (process.env.NODE_ENV !== 'production' && err.stack) {
      logger.error(err.stack);
  }

  res.status(statusCode);
  res.json({
    message: err.message,
    // Do not leak stack traces to the public in production
    stack: process.env.NODE_ENV === 'production' ? null : err.stack,
  });
};

export { errorHandler };
