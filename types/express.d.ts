// types/express.d.ts
import { DecodedIdToken } from 'firebase-admin/auth';
import { IUserRole } from './index'; 

declare global {
  namespace Express {
    interface Request {
      user?: DecodedIdToken & {
        role?: IUserRole; 
        uid: string;
        email?: string;
        [key: string]: any;
      };
    }
  }
}

export {}; // Important: Ensures this is treated as a module
