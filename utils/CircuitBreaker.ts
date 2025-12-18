// utils/CircuitBreaker.ts
import redisClient from './redisClient';
import logger from './logger';

/**
 * Standardized Circuit Breaker to protect external APIs (NewsAPI, Gemini, etc.)
 * from being hammered when they are down or rate-limited.
 */
class CircuitBreaker {
    
    /**
     * Checks if the circuit is OPEN (Blocked).
     * Returns TRUE if requests are allowed (Closed).
     * Returns FALSE if requests are blocked (Open).
     */
    async isOpen(provider: string): Promise<boolean> {
        if (!redisClient.isReady()) return true; // Fail open (allow traffic) if Redis is down
        
        const key = `breaker:open:${provider}`;
        const isBlocked = await redisClient.get(key);
        
        // If key exists, breaker is OPEN (Blocked).
        return !isBlocked; 
    }

    /**
     * Records a failure for a provider.
     * If failures exceed the threshold, it opens the circuit.
     */
    async recordFailure(provider: string, threshold: number = 3, cooldownSeconds: number = 1800) {
        if (!redisClient.isReady()) return;

        const failKey = `breaker:fail:${provider}`;
        const openKey = `breaker:open:${provider}`;

        try {
            // Increment failure count
            const count = await redisClient.incr(failKey);
            
            // Set a short expiry for the failure counter window (e.g., 10 mins)
            if (count === 1) await redisClient.expire(failKey, 600);

            // If failures exceed threshold, OPEN THE BREAKER
            if (count >= threshold) {
                logger.error(`🔥 ${provider} is failing repeatedly (${count} times). Opening Circuit Breaker for ${cooldownSeconds}s.`);
                await redisClient.set(openKey, '1', cooldownSeconds); 
                await redisClient.del(failKey); // Reset counter
            }
        } catch (error: any) {
            logger.warn(`CircuitBreaker Error: ${error.message}`);
        }
    }

    /**
     * Resets the failure count. Call this on a successful request.
     */
    async recordSuccess(provider: string) {
        if (!redisClient.isReady()) return;
        // We simply delete the failure counter. 
        // We do NOT delete the 'open' key because if it was open, we wouldn't be here 
        // (unless we are implementing half-open logic, but for now simple is better).
        await redisClient.del(`breaker:fail:${provider}`);
    }
}

export default new CircuitBreaker();
