// utils/KeyManager.ts
import redisClient from './redisClient';
import logger from './logger';

interface IKey {
    key: string;
    provider: string;
}

class KeyManager {
    private keys: Map<string, IKey>;
    
    // Config: How long to ban a key if it fails?
    private readonly COOLDOWN_TIME_SECONDS = 600; // 10 minutes
    private readonly MAX_ERRORS_BEFORE_COOLDOWN = 5;
    
    // Redis Keys Prefixes
    private readonly REDIS_PREFIX_COOLDOWN = 'key_cooldown:';
    private readonly REDIS_PREFIX_ERROR = 'key_errors:';
    private readonly REDIS_KEY_CIRCUIT_BREAKER = 'global_circuit_breaker';

    private readonly GLOBAL_ERROR_THRESHOLD = 20;

    constructor() {
        this.keys = new Map();
    }

    /**
     * Registers a list of API keys for a specific provider.
     */
    public registerProviderKeys(providerName: string, keys: string[]): void {
        if (!keys || keys.length === 0) {
            logger.warn(`⚠️ No API Keys provided for ${providerName}`);
            return;
        }

        let addedCount = 0;
        keys.forEach(k => {
            if (!this.keys.has(k)) {
                this.keys.set(k, {
                    key: k,
                    provider: providerName
                });
                addedCount++;
            }
        });

        logger.info(`✅ Registered ${addedCount} keys for ${providerName}`);
    }

    /**
     * Gets the best available key.
     * Strategy: PRIORITY (Failover) with Distributed State.
     * Always tries keys in order [0, 1, 2...]. Returns the first one that is NOT in cooldown (checked via Redis).
     */
    public async getKey(providerName: string): Promise<string> {
        // 1. Check Global Circuit Breaker (Redis-based for distributed awareness)
        // If the system is in panic mode, stop everything.
        const cbResetTime = await redisClient.get(this.REDIS_KEY_CIRCUIT_BREAKER);
        
        if (cbResetTime) {
            const resetTime = parseInt(cbResetTime, 10);
            if (Date.now() < resetTime) {
                const waitTime = Math.ceil((resetTime - Date.now()) / 1000);
                throw new Error(`CIRCUIT_BREAKER_ACTIVE: System cooling down for ${waitTime}s.`);
            }
        }

        // 2. Filter keys for this provider
        const allKeys = Array.from(this.keys.values()).filter(k => k.provider === providerName);
        if (allKeys.length === 0) throw new Error(`NO_KEYS_CONFIGURED: No keys for ${providerName}`);

        // 3. Priority Search
        // Loop through all configured keys for this provider
        for (const candidate of allKeys) {
            // Check REDIS: Is this key cooling down?
            const isCoolingDown = await redisClient.get(`${this.REDIS_PREFIX_COOLDOWN}${candidate.key}`);
            
            if (isCoolingDown) {
                // If this key is burnt, skip to the next backup key
                continue; 
            }

            // Found a working key!
            return candidate.key;
        }

        throw new Error(`NO_KEYS_AVAILABLE: All ${providerName} keys are currently cooling down.`);
    }

    /**
     * Reports a failure. 
     * Uses Redis to track errors across multiple instances.
     */
    public async reportFailure(key: string, isRateLimit: boolean = false): Promise<void> {
        
        // 1. Handle Global Circuit Breaker Logic
        const globalErrorsKey = 'system:global_errors';
        const currentGlobalErrors = await redisClient.incr(globalErrorsKey);
        await redisClient.expire(globalErrorsKey, 300); // Window of 5 minutes

        if (currentGlobalErrors >= this.GLOBAL_ERROR_THRESHOLD) {
            const resetTime = Date.now() + (5 * 60 * 1000); // 5 mins
            await redisClient.set(this.REDIS_KEY_CIRCUIT_BREAKER, resetTime.toString(), 300);
            logger.error("⛔ CRITICAL: Too many API failures. Global Circuit Breaker TRIPPED.");
        }

        // 2. Handle Individual Key Failure
        const keyObj = this.keys.get(key);
        if (!keyObj) return;
        
        let shouldBan = false;

        if (isRateLimit) {
            logger.warn(`⏳ Rate Limit hit on ...${key.slice(-4)}. Switching to backup key.`);
            shouldBan = true;
        } else {
            // Increment shared error counter in Redis
            const errorKey = `${this.REDIS_PREFIX_ERROR}${key}`;
            const errorCount = await redisClient.incr(errorKey);
            await redisClient.expire(errorKey, 3600); // Reset count every hour

            if (errorCount >= this.MAX_ERRORS_BEFORE_COOLDOWN) {
                logger.warn(`⚠️ Key ...${key.slice(-4)} unstable (${errorCount} errors). Cooling down.`);
                shouldBan = true;
            }
        }

        if (shouldBan) {
            // SET COOLDOWN IN REDIS
            await redisClient.set(
                `${this.REDIS_PREFIX_COOLDOWN}${key}`, 
                'true', 
                this.COOLDOWN_TIME_SECONDS
            );
            
            // Clear error count so it starts fresh after cooldown
            await redisClient.del(`${this.REDIS_PREFIX_ERROR}${key}`);
        }
    }

    public async reportSuccess(key: string): Promise<void> {
        // Clear global error count slightly to indicate system health
        // (We don't clear it fully to prevent flickering, but we could expire it faster)
        // For individual keys, we reset their error count on success
        await redisClient.del(`${this.REDIS_PREFIX_ERROR}${key}`);
    }

    /**
     * CENTRALIZED RETRY LOGIC (New Feature)
     * Executes a function using available keys, rotating automatically on failure.
     * @param provider The provider name (e.g., 'GEMINI', 'NEWS_API')
     * @param operation The async function that uses the key
     */
    public async executeWithRetry<T>(
        provider: string, 
        operation: (key: string) => Promise<T>
    ): Promise<T> {
        const errors: any[] = [];
        // Try up to 3 distinct keys/attempts before giving up
        const MAX_ATTEMPTS = 3; 

        for (let i = 0; i < MAX_ATTEMPTS; i++) {
            let currentKey = '';
            try {
                currentKey = await this.getKey(provider);
                const result = await operation(currentKey);
                
                // If we reach here, the operation succeeded
                await this.reportSuccess(currentKey);
                return result;
            } catch (err: any) {
                errors.push(err);
                
                // If we got a key and failed, report it so it might be rotated next time
                if (currentKey) {
                    const isRateLimit = err.status === 429 || err?.response?.status === 429;
                    await this.reportFailure(currentKey, isRateLimit);
                }

                logger.warn(`🔄 Retry attempt ${i+1}/${MAX_ATTEMPTS} for ${provider} failed. Moving to next key.`);
            }
        }
        
        throw new Error(`Failed to execute ${provider} operation after ${MAX_ATTEMPTS} attempts. Last error: ${errors.pop()?.message}`);
    }
}

export default new KeyManager();
