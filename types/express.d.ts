import { Request } from 'express';

declare global {
  namespace Express {
    interface Request {
      user?: any; // We will improve this type later, but for now this fixes the server.ts error
    }
  }
}
