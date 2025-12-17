import { Request } from 'express';

// Extend the global Express Request interface
declare global {
  namespace Express {
    interface Request {
      user?: {
        uid: string;
        email?: string;
        [key: string]: any; 
      };
    }
  }
}

export {};
