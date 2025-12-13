// middleware/errorMiddleware.ts
import { Request, Response, NextFunction } from 'express';

const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  // Default to 500 (Server Error) if status code isn't set or is 200
  const statusCode = res.statusCode === 200 ? 500 : res.statusCode;

  console.error('🔥 Error:', err.message);

  res.status(statusCode);
  res.json({
    message: err.message,
    // Only show the stack trace if we are NOT in production
    stack: process.env.NODE_ENV === 'production' ? null : err.stack,
  });
};

export { errorHandler };
