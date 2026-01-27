// services/analyticsBufferService.ts
import AnalyticsSession from '../models/analyticsSession';
import redisClient from '../utils/redisClient';
import logger from '../utils/logger';

class AnalyticsBufferService {
  private BATCH_SIZE = 50; // Process 50 sessions at a time
  private FLUSH_INTERVAL = 10000; // Flush every 10 seconds
  private QUEUE_KEY = 'analytics:session:buffer';
  private isFlushing = false;
  private flushTimer: NodeJS.Timeout | null = null;

  /**
   * Add session data to the Redis Buffer.
   * If Redis is not ready, falls back to direct MongoDB write to prevent data loss.
   */
  async bufferSessionData(sessionId: string, updateOps: any) {
    if (!redisClient.isReady()) {
      return this.writeDirectly(sessionId, updateOps);
    }

    try {
      const client = redisClient.getClient();
      // Safe check: ensure client exists
      if (!client) {
          return this.writeDirectly(sessionId, updateOps);
      }

      const payload = JSON.stringify({ sessionId, updateOps });
      await client.lPush(this.QUEUE_KEY, payload);
    } catch (error) {
      logger.error('Buffer Push Error, falling back to direct write:', error);
      return this.writeDirectly(sessionId, updateOps);
    }
  }

  /**
   * Fallback method: Writes directly to DB if Redis fails.
   */
  private async writeDirectly(sessionId: string, updateOps: any) {
    try {
       await AnalyticsSession.findOneAndUpdate(
        { sessionId },
        updateOps,
        { upsert: true, new: true }
      );
    } catch (e) { 
        logger.error('Direct Write Error:', e); 
    }
  }

  /**
   * The Engine: Pops items from Redis and Bulk Writes to MongoDB.
   */
  async flush() {
    if (this.isFlushing || !redisClient.isReady()) return;
    this.isFlushing = true;

    try {
       const client = redisClient.getClient();
       if (!client) {
           this.isFlushing = false;
           return;
       }
       
       // 1. Retrieve a batch of items
       // Note: We use a loop to pop items to ensure we respect BATCH_SIZE
       const items: any[] = [];
       for(let i = 0; i < this.BATCH_SIZE; i++) {
           const item = await client.rPop(this.QUEUE_KEY);
           if (!item) break;
           items.push(JSON.parse(item));
       }

       if (items.length > 0) {
           // 2. Prepare Bulk Operations
           // specific syntax for Mongoose bulkWrite
           const ops = items.map(item => ({
               updateOne: {
                   filter: { sessionId: item.sessionId },
                   update: item.updateOps,
                   upsert: true
               }
           }));

           // 3. Execute Bulk Write (1 DB Call instead of 50)
           await AnalyticsSession.bulkWrite(ops);
           // logger.info(`⚡ Analytics Buffer: Flushed ${items.length} sessions.`);
       }
    } catch (err) {
       logger.error('Analytics Flush Error:', err);
    } finally {
       this.isFlushing = false;
    }
  }

  /**
   * Start the auto-flush interval. Call this in server.ts.
   */
  startService() {
      if (this.flushTimer) clearInterval(this.flushTimer);
      this.flushTimer = setInterval(() => this.flush(), this.FLUSH_INTERVAL);
      logger.info('🚀 Analytics Buffer Service Started (Interval: 10s)');
  }
}

export default new AnalyticsBufferService();
