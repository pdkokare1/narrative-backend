// middleware/authMiddleware.ts
import { Request, Response, NextFunction } from 'express';
import * as admin from 'firebase-admin';
import logger from '../utils/logger';

// --- App Check (Security Gate) ---
export const checkAppCheck = async (req: Request, res: Response, next: NextFunction) => {
  const appCheckToken = req.header('X-Firebase-AppCheck');
  
  if (!appCheckToken) {
      res.status(401);
      // We don't throw here to avoid crashing the process, we just send error
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

// --- User Authentication (Firebase Auth) ---
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
