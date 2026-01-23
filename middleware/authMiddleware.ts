// narrative-backend/middleware/authMiddleware.ts
import { Request, Response, NextFunction } from 'express';
import * as admin from 'firebase-admin';
import logger from '../utils/logger';
import config from '../utils/config';
import { CONSTANTS } from '../utils/constants';
import AppError from '../utils/AppError';
import { IUserRole } from '../types';
import Profile from '../models/profileModel'; // NEW: Needed for database fallback check

// --- App Check (Security Gate) ---
// Enforces that requests come from YOUR specific frontend app.
export const checkAppCheck = async (req: Request, res: Response, next: NextFunction) => {
  if (!config.enableAppCheck) return next();

  const appCheckToken = req.header('X-Firebase-AppCheck');
  
  if (!appCheckToken) {
      if (config.isProduction) {
          logger.warn(`🛑 Blocked Request: Missing App Check Token [IP: ${req.ip}]`);
          return next(new AppError('Unauthorized: App Check Token Missing', 401, CONSTANTS.ERROR_CODES.AUTH_NO_APP_CHECK));
      } else {
          logger.debug('⚠️ Missing App Check Token (Allowed in Dev)');
          return next();
      }
  }
  
  try {
    await admin.appCheck().verifyToken(appCheckToken);
    next(); 
  } catch (err: any) {
    logger.warn(`🛑 App Check Validation Failed: ${err.message} [IP: ${req.ip}]`);
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
// IMPROVED: Checks Token Claims FIRST, then falls back to Database (MongoDB)
export const requireRole = (role: IUserRole) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        // 1. Ensure user is logged in
        if (!req.user) {
            return next(new AppError('Unauthorized: Login required', 401, CONSTANTS.ERROR_CODES.AUTH_MISSING_TOKEN));
        }

        // 2. Check hardcoded Super Admins (Emergency Access)
        if (config.adminUids.includes(req.user.uid)) {
            return next();
        }

        // 3. Fast Path: Check Custom Claims in Token (Zero DB Latency)
        if (req.user[role] === true || req.user.role === role) {
            return next();
        }

        // 4. Slow Path: Check MongoDB (Reliable for manual edits)
        // If the token claim fails, we check the actual database record
        try {
            const userProfile = await Profile.findOne({ userId: req.user.uid }).select('role').lean();
            
            if (userProfile && userProfile.role === role) {
                // Success! The database says they are admin
                return next();
            }
        } catch (err) {
            logger.error(`RBAC Database Check Failed: ${err}`);
        }

        // 5. Deny
        logger.warn(`🛑 Access Denied: User ${req.user.uid} attempted ${role} action without privileges.`);
        return next(new AppError(`Forbidden: Requires ${role} privileges`, 403, CONSTANTS.ERROR_CODES.ACCESS_DENIED));
    };
};

export const checkAdmin = requireRole('admin');
