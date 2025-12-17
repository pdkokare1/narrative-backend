// types/express.d.ts
import { DecodedIdToken } from 'firebase-admin/auth';

declare global {
  namespace Express {
    interface Request {
      // Improved: Now specifically uses Firebase's official user definition
      user?: DecodedIdToken;
    }
  }
}
