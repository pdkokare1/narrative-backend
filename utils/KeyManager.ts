// utils/KeyManager.ts
import redis from './redisClient';

interface IKey {
    key: string;
    provider: string;
    status: 'active' | 'cooldown' | 'failed';
    errorCount: number;
    lastUsed: number;
    lastFailed: number;
}

class KeyManager {
    private keys: Map<string, IKey>;
    private providerIndices: Map<string, number>;
    private readonly COOLDOWN_TIME = 10 * 60 * 1000; // 10 minutes
    private readonly MAX_ERRORS_BEFORE_COOLDOWN = 5;
    
    // Circuit Breaker State
    private globalCircuitBreaker: boolean = false;
    private circuitBreakerResetTime: number = 0;
    private consecutiveGlobalErrors: number = 0;
    private readonly GLOBAL_ERROR_THRESHOLD = 20;

    constructor() {
        this.keys = new Map();
        this.providerIndices = new Map();
    }

    /**
     * Loads keys from Environment Variables into memory.
     */
    public loadKeys(providerName: string, envPrefix: string): void {
        const foundKeys: string[] = [];
        for (let i = 1; i <= 20; i++) {
            const key = process.env[`${envPrefix}_API_KEY_${i}`]?.trim();
            if (key) foundKeys.push(key);
        }
        const defaultKey = process.env[`${envPrefix}_API_KEY`]?.trim();
        if (defaultKey && !foundKeys.includes(defaultKey)) foundKeys.push(defaultKey);

        if (foundKeys.length === 0) {
            console.warn(`⚠️ No API Keys found for ${providerName} (Prefix: ${envPrefix})`);
            return;
        }

        foundKeys.forEach(k => {
            if (!this.keys.has(k)) {
                this.keys.set(k, {
                    key: k,
                    provider: providerName,
                    status: 'active',
                    errorCount: 0,
                    lastUsed: 0,
                    lastFailed: 0
                });
            }
        });

        console.log(`✅ Loaded ${foundKeys.length} keys for ${providerName}`);
    }

    /**
     * Gets the next available active key (Round Robin with Redis Check).
     * Throws error if Circuit Breaker is active or no keys available.
     */
    public async getKey(providerName: string): Promise<string> {
        // 1. Check Circuit Breaker
        if (this.globalCircuitBreaker) {
            if (Date.now() > this.circuitBreakerResetTime) {
                console.log("🟢 Global Circuit Breaker Reset. Resuming AI operations.");
                this.globalCircuitBreaker = false;
                this.consecutiveGlobalErrors = 0;
            } else {
                const waitTime = Math.ceil((this.circuitBreakerResetTime - Date.now()) / 1000);
                throw new Error(`CIRCUIT_BREAKER_ACTIVE: System cooling down for ${waitTime}s.`);
            }
        }

        // 2. Get Keys for Provider
        const allKeys = Array.from(this.keys.values()).filter(k => k.provider === providerName);
        if (allKeys.length === 0) throw new Error(`NO_KEYS_CONFIGURED: No keys for ${providerName}`);

        // 3. Round Robin Search
        let currentIndex = this.providerIndices.get(providerName) || 0;
        let attempts = 0;

        // Try every key in the list once
        while (attempts < allKeys.length) {
            const candidate = allKeys[currentIndex % allKeys.length];
            currentIndex++; 
            attempts++;

            // Update index for next caller immediately
            this.providerIndices.set(providerName, currentIndex % allKeys.length);

            // A. Check Local Status
            if (candidate.status === 'cooldown') {
                if (Date.now() - candidate.lastFailed > this.COOLDOWN_TIME) {
                    // Local Cooldown expired, check Redis to be sure
                } else {
                    continue; // Still cooling locally
                }
            }

            // B. Check Redis Status (Persistence)
            // @ts-ignore
            if (redis.isReady && redis.isReady()) {
                const redisStatus = await redis.get(`key_status:${candidate.key}`);
                if (redisStatus === 'cooldown') {
                    // Update local state to match Redis
                    candidate.status = 'cooldown';
                    candidate.lastFailed = Date.now(); // Reset local timer
                    continue; // Skip this key
                }
            }

            // If we got here, the key is good
            candidate.status = 'active';
            candidate.errorCount = 0;
            candidate.lastUsed = Date.now();
            return candidate.key;
        }

        throw new Error(`NO_KEYS_AVAILABLE: All ${providerName} keys are exhausted or cooling down.`);
    }

    /**
     * Reports a failure. If it's a Rate Limit (429), instant cooldown.
     * If other error, increments counter.
     */
    public async reportFailure(key: string, isRateLimit: boolean = false): Promise<void> {
        this.consecutiveGlobalErrors++;
        
        // Trigger Circuit Breaker if system is failing globally
        if (this.consecutiveGlobalErrors >= this.GLOBAL_ERROR_THRESHOLD) {
            this.globalCircuitBreaker = true;
            this.circuitBreakerResetTime = Date.now() + (5 * 60 * 1000); // 5 minutes
            console.error("⛔ CRITICAL: Too many API failures. Global Circuit Breaker TRIPPED.");
        }

        const keyObj = this.keys.get(key);
        if (!keyObj) return;
        
        keyObj.lastFailed = Date.now();
        
        if (isRateLimit) {
            keyObj.status = 'cooldown';
            console.warn(`⏳ KeyManager: Rate Limit hit on ...${key.slice(-4)}. Cooling down.`);
            // Persist Cooldown to Redis (TTL = Cooldown Time)
            // @ts-ignore
            if (redis.isReady && redis.isReady()) {
                await redis.set(`key_status:${key}`, 'cooldown', this.COOLDOWN_TIME / 1000);
            }
        } else {
            keyObj.errorCount++;
            if (keyObj.errorCount >= this.MAX_ERRORS_BEFORE_COOLDOWN) {
                keyObj.status = 'cooldown';
                console.warn(`⚠️ KeyManager: Key ...${key.slice(-4)} unstable. Cooling down.`);
            }
        }
    }

    public reportSuccess(key: string): void {
        this.consecutiveGlobalErrors = 0; // Reset global error count on success
        const keyObj = this.keys.get(key);
        if (keyObj) {
            keyObj.errorCount = 0;
            if (keyObj.status !== 'active') keyObj.status = 'active';
        }
    }
}

export default new KeyManager();
