// middleware/authMiddleware.ts
import { Request, Response, NextFunction } from 'express';
import * as admin from 'firebase-admin';
import logger from '../utils/logger';
import config from '../utils/config';

// --- App Check (Security Gate) ---
export const checkAppCheck = async (req: Request, res: Response, next: NextFunction) => {
  const appCheckToken = req.header('X-Firebase-AppCheck');
  
  if (!appCheckToken) {
      // Allow passing if explicitly disabled in dev (optional, keeping strict for now)
      if (!config.isProduction) {
          // logger.warn('Dev Mode: Skipping App Check');
          // return next();
      }

      res.status(401);
      return next(new Error('Unauthorized: No App Check token.'));
  }
  
  try {
    await admin.appCheck().verifyToken(appCheckToken);
    next(); 
  } catch (err: any) {
    logger.warn(`App Check Error: ${err.message}`);
    res.status(403);
    return next(new Error('Forbidden: Invalid App Check token.'));
  }
};

// --- User Authentication (Strict: Must be logged in) ---
export const checkAuth = async (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  
  if (!token) {
      res.status(401);
      return next(new Error('Unauthorized: No token provided'));
  }
  
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error: any) {
    logger.warn(`Auth Error: ${error.code || 'Unknown'} - ${error.message}`);
    res.status(403);
    return next(new Error('Forbidden: Invalid or expired token'));
  }
};

// --- Optional Authentication (Loose: Logged in OR Guest) ---
export const optionalAuth = async (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split('Bearer ')[1];

  if (!token) return next();

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
  } catch (error: any) {
    logger.warn(`Optional Auth Failed (Treating as Guest): ${error.message}`);
  }
  next();
};

// --- Admin Authentication (System & Jobs) ---
export const checkAdmin = (req: Request, res: Response, next: NextFunction) => {
    const adminSecret = req.header('x-admin-secret');

    if (!adminSecret || adminSecret !== config.adminSecret) {
        logger.warn(`🛑 Admin access denied from IP: ${req.ip}`);
        res.status(403);
        return next(new Error('Forbidden: Admin access required'));
    }

    next();
};
