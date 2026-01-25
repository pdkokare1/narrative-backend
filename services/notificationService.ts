// services/notificationService.ts
import * as admin from 'firebase-admin';
import Profile from '../models/profileModel';
import redisClient from '../utils/redisClient';
import logger from '../utils/logger';

class NotificationService {

    /**
     * Sends a "Smart Alert" to a user if they haven't received one today.
     * @param userId The user ID
     * @param hour The current hour context (for logging)
     */
    async sendSmartAlert(userId: string, hour: string): Promise<boolean> {
        try {
            // 1. Check Rate Limit (1 per day per user)
            const today = new Date().toISOString().split('T')[0];
            const rateKey = `notif_limit:${userId}:${today}`;
            
            const hasSent = await redisClient.get(rateKey);
            if (hasSent) {
                logger.debug(`🔕 Notification skipped for ${userId}: Already sent today.`);
                return false;
            }

            // 2. Get User Token
            const profile = await Profile.findOne({ userId });
            if (!profile || !profile.fcmToken || !profile.notificationsEnabled) {
                return false;
            }

            // 3. Construct Message
            // In the future, this can be personalized with 'negativeInterest' data
            const message = {
                notification: {
                    title: "Your Daily Briefing",
                    body: "Your feed has been updated with stories matching your active hours."
                },
                token: profile.fcmToken,
                data: {
                    type: 'smart_briefing',
                    hour: hour
                }
            };

            // 4. Send via Firebase
            await admin.messaging().send(message);
            logger.info(`🚀 Smart Notification sent to ${userId} (Hour: ${hour})`);

            // 5. Set Rate Limit (Expire in 24 hours)
            if (redisClient.isReady()) {
                const client = redisClient.getClient();
                if (client) {
                    await client.set(rateKey, '1');
                    await client.expire(rateKey, 86400); 
                }
            }

            return true;

        } catch (error: any) {
            if (error.code === 'messaging/registration-token-not-registered') {
                logger.warn(`⚠️ Invalid FCM Token for ${userId}. Removing...`);
                await Profile.updateOne({ userId }, { $unset: { fcmToken: 1 } });
            } else {
                logger.error(`❌ Notification Failed for ${userId}: ${error.message}`);
            }
            return false;
        }
    }
}

export default new NotificationService();
