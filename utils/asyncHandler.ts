// utils/asyncHandler.ts
import { Request, Response, NextFunction } from 'express';

// Defines a function that takes Express arguments and returns a Promise
type AsyncFunction = (req: Request, res: Response, next: NextFunction) => Promise<any>;

const asyncHandler = (fn: AsyncFunction) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export default asyncHandler;
