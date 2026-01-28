// services/notificationService.ts
import * as admin from 'firebase-admin';
import Profile from '../models/profileModel';
import redisClient from '../utils/redisClient';
import logger from '../utils/logger';
import statsService from './statsService'; // Updated to import statsService

class NotificationService {

    /**
     * Entry Point for Scheduler: Sends alerts to users whose Golden Hour is NOW.
     * @param hour Current hour (0-23)
     */
    async sendGoldenHourBriefings(hour: number): Promise<void> {
        try {
            // 1. Get Users matched to this hour
            const candidates = await statsService.getUsersByPeakHour(hour);
            if (!candidates || candidates.length === 0) return;

            logger.info(`🔔 Golden Hour: Found ${candidates.length} users active at hour ${hour}.`);

            // 2. Process individually (Promise.allSettled to avoid blocking)
            await Promise.allSettled(
                candidates.map(user => this.sendSmartAlert(user.userId, hour.toString()))
            );

        } catch (err) {
            logger.error('Golden Hour Batch Failed:', err);
        }
    }

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
                // logger.debug(`🔕 Notification skipped for ${userId}: Already sent today.`);
                return false;
            }

            // 2. Get User Token
            const profile = await Profile.findOne({ userId });
            if (!profile || !profile.fcmToken || !profile.notificationsEnabled) {
                return false;
            }

            // 3. Construct Message
            // We personalize the title based on the time context
            const message = {
                notification: {
                    title: "Your Daily Briefing",
                    body: "We've curated stories matching your peak learning time."
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
