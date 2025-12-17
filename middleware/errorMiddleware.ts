// middleware/errorMiddleware.ts
import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import AppError from '../utils/AppError';

const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  let error = { ...err };
  error.message = err.message;

  // 1. Log the Error
  // We log the stack trace if it's not an operational error (meaning it might be a bug)
  if (!err.isOperational) {
    logger.error(`🔥 Unexpected Error [${req.method} ${req.url}]:`);
    logger.error(err); 
  } else {
    logger.warn(`⚠️ Operational Error [${req.method} ${req.url}]: ${err.message}`);
  }

  // 2. Handle specific Mongoose/Database Errors
  
  // Bad ObjectId (CastError)
  if (err.name === 'CastError') {
    const message = `Resource not found. Invalid ${err.path}: ${err.value}`;
    error = new AppError(message, 400);
  }

  // Duplicate Key (E11000)
  if (err.code === 11000) {
    const value = err.errmsg ? err.errmsg.match(/(["'])(\\?.)*?\1/)[0] : 'Duplicate field';
    const message = `Duplicate field value: ${value}. Please use another value.`;
    error = new AppError(message, 400);
  }

  // Validation Error
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map((el: any) => el.message);
    const message = `Invalid input data. ${errors.join('. ')}`;
    error = new AppError(message, 400);
  }

  // 3. Send Response
  const statusCode = error.statusCode || 500;
  const status = error.status || 'error';

  res.status(statusCode).json({
    status: status,
    message: error.message || 'Internal Server Error',
    // Only show stack in development
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });
};

export { errorHandler };
