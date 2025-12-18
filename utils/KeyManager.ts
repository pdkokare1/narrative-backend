// utils/KeyManager.ts
import redisClient from './redisClient';
import logger from './logger';

interface IKey {
    key: string;
    provider: string;
    errorCount: number;
}

class KeyManager {
    private keys: Map<string, IKey>;
    
    // Config: How long to ban a key if it fails?
    private readonly COOLDOWN_TIME_SECONDS = 600; // 10 minutes
    private readonly MAX_ERRORS_BEFORE_COOLDOWN = 5;
    
    // Circuit Breaker (Global Panic Button)
    private globalCircuitBreaker: boolean = false;
    private circuitBreakerResetTime: number = 0;
    private consecutiveGlobalErrors: number = 0;
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
                    provider: providerName,
                    errorCount: 0
                });
                addedCount++;
            }
        });

        logger.info(`✅ Registered ${addedCount} keys for ${providerName}`);
    }

    /**
     * Gets the best available key.
     * Strategy: PRIORITY (Failover).
     * Always tries keys in order [0, 1, 2...]. Returns the first one that is NOT in cooldown.
     * This preserves backup keys until they are actually needed.
     */
    public async getKey(providerName: string): Promise<string> {
        // 1. Check Global Circuit Breaker (Stop everything if API is down)
        if (this.globalCircuitBreaker) {
            if (Date.now() > this.circuitBreakerResetTime) {
                logger.info("🟢 Global Circuit Breaker Reset. Resuming AI operations.");
                this.globalCircuitBreaker = false;
                this.consecutiveGlobalErrors = 0;
            } else {
                const waitTime = Math.ceil((this.circuitBreakerResetTime - Date.now()) / 1000);
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
            const isCoolingDown = await redisClient.get(`key_cooldown:${candidate.key}`);
            
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
     * If Rate Limit (429): Instantly sets cooldown in Redis.
     * If other error: Increments local counter, then sets cooldown in Redis if too many errors.
     */
    public async reportFailure(key: string, isRateLimit: boolean = false): Promise<void> {
        this.consecutiveGlobalErrors++;
        
        // Trip Circuit Breaker if massive failures occur
        if (this.consecutiveGlobalErrors >= this.GLOBAL_ERROR_THRESHOLD) {
            this.globalCircuitBreaker = true;
            this.circuitBreakerResetTime = Date.now() + (5 * 60 * 1000); // 5 mins
            logger.error("⛔ CRITICAL: Too many API failures. Global Circuit Breaker TRIPPED.");
        }

        const keyObj = this.keys.get(key);
        if (!keyObj) return;
        
        let shouldBan = false;

        if (isRateLimit) {
            logger.warn(`⏳ Rate Limit hit on ...${key.slice(-4)}. Switching to backup key.`);
            shouldBan = true;
        } else {
            keyObj.errorCount++;
            if (keyObj.errorCount >= this.MAX_ERRORS_BEFORE_COOLDOWN) {
                logger.warn(`⚠️ Key ...${key.slice(-4)} unstable (${keyObj.errorCount} errors). Cooling down.`);
                shouldBan = true;
            }
        }

        if (shouldBan) {
            // SET COOLDOWN IN REDIS
            // This 'true' flag will expire automatically after COOLDOWN_TIME_SECONDS
            await redisClient.set(
                `key_cooldown:${key}`, 
                'true', 
                this.COOLDOWN_TIME_SECONDS
            );
            
            // Reset local error count so it's fresh when it comes back
            keyObj.errorCount = 0;
        }
    }

    public reportSuccess(key: string): void {
        this.consecutiveGlobalErrors = 0; 
        const keyObj = this.keys.get(key);
        if (keyObj) {
            keyObj.errorCount = 0;
        }
    }
}

export default new KeyManager();
