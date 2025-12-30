// middleware/authMiddleware.ts
import { Request, Response, NextFunction } from 'express';
import * as admin from 'firebase-admin';
import logger from '../utils/logger';
import config from '../utils/config';
import { CONSTANTS } from '../utils/constants';
import AppError from '../utils/AppError';

// --- App Check (Security Gate) ---
// Enforces that requests come from YOUR specific frontend app.
export const checkAppCheck = async (req: Request, res: Response, next: NextFunction) => {
  // If explicitly disabled in config (e.g. for testing), skip
  if (!config.enableAppCheck) return next();

  const appCheckToken = req.header('X-Firebase-AppCheck');
  
  if (!appCheckToken) {
      if (config.isProduction) {
          logger.warn(`🛑 Blocked Request: Missing App Check Token [IP: ${req.ip}]`);
          return next(new AppError('Unauthorized: App Check Token Missing', 401, CONSTANTS.ERROR_CODES.AUTH_NO_APP_CHECK));
      } else {
          // Dev Mode: Allow with warning
          logger.debug('⚠️ Missing App Check Token (Allowed in Dev)');
          return next();
      }
  }
  
  try {
    await admin.appCheck().verifyToken(appCheckToken);
    next(); 
  } catch (err: any) {
    logger.warn(`🛑 App Check Validation Failed: ${err.message} [IP: ${req.ip}]`);
    
    // In production, this is a hard stop.
    if (config.isProduction) {
        return next(new AppError('Forbidden: Invalid App Check Token', 403, CONSTANTS.ERROR_CODES.AUTH_INVALID_TOKEN));
    }
    next();
  }
};

// --- User Authentication (Strict: Must be logged in) ---
export const checkAuth = async (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers.authorization?.split('Bearer ')[1];
  
  if (!token) {
      return next(new AppError('Unauthorized: No token provided', 401, CONSTANTS.ERROR_CODES.AUTH_MISSING_TOKEN));
  }
  
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error: any) {
    logger.warn(`Auth Error: ${error.code || 'Unknown'} - ${error.message}`);
    
    if (error.code === 'auth/id-token-expired') {
         return next(new AppError('Unauthorized: Token Expired', 401, CONSTANTS.ERROR_CODES.AUTH_INVALID_TOKEN));
    }
    return next(new AppError('Forbidden: Invalid token', 403, CONSTANTS.ERROR_CODES.ACCESS_DENIED));
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

// --- Role Based Access Control (RBAC) ---
// Universal middleware to check for ANY role
export const requireRole = (role: string) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        // 1. Ensure user is logged in first
        if (!req.user) {
            return next(new AppError('Unauthorized: Login required', 401, CONSTANTS.ERROR_CODES.AUTH_MISSING_TOKEN));
        }

        // 2. Check hardcoded Super Admins (Always allowed)
        if (config.adminUids.includes(req.user.uid)) {
            return next();
        }

        // 3. Check Custom Claims (Recommended way for Firebase)
        // Note: You need to set custom claims on the user object in Firebase
        if (req.user[role] === true || req.user.role === role) {
            return next();
        }

        // 4. Fallback: Check Profile in DB (Slower, but easier to manage initially)
        // We skip this for now to keep middleware fast. Use Custom Claims or AdminUIDs.

        logger.warn(`🛑 Access Denied: User ${req.user.uid} needs role '${role}'`);
        return next(new AppError(`Forbidden: Requires ${role} privileges`, 403, CONSTANTS.ERROR_CODES.ACCESS_DENIED));
    };
};

// --- Admin Authentication (Legacy Wrapper) ---
// Uses the new requireRole but keeps specific admin logic if needed
export const checkAdmin = requireRole('admin');
