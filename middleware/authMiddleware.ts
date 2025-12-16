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
// Used for feeds where we prefer personalization but don't require it.
export const optionalAuth = async (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split('Bearer ')[1];

  // If no token, just proceed as a Guest (req.user remains undefined)
  if (!token) return next();

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
  } catch (error: any) {
    // If token is bad/expired, just log a warning but let them proceed as Guest
    logger.warn(`Optional Auth Failed (Treating as Guest): ${error.message}`);
  }
  next();
};
