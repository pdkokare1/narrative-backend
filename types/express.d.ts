// types/express.d.ts
import { DecodedIdToken } from 'firebase-admin/auth';
import { IUserRole } from './index'; // Adjust path if needed

declare global {
  namespace Express {
    interface Request {
      user?: DecodedIdToken & {
        role?: IUserRole; // Custom claim
        [key: string]: any;
      };
    }
  }
}
