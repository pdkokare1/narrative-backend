// utils/firebaseInit.ts
import * as admin from 'firebase-admin';
import config from './config';
import logger from './logger';

export const initFirebase = () => {
  try {
    if (config.firebase.serviceAccount) {
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert(config.firebase.serviceAccount)
        });
        logger.info('🔥 Firebase Admin SDK Initialized');
      }
    }
  } catch (error: any) {
    logger.error(`Firebase Admin Init Error: ${error.message}`);
  }
};
