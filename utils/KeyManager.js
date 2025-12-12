// utils/KeyManager.js
// Centralized manager for API Key rotation, cooldowns, and error tracking.

class KeyManager {
    constructor() {
        this.keys = new Map(); // Stores key state: { key, provider, status, errorCount, lastUsed, lastFailed }
        this.providerIndices = new Map(); // Tracks current index for rotation per provider
        
        // Configuration
        this.COOLDOWN_TIME = 10 * 60 * 1000; // 10 Minutes
        this.MAX_ERRORS_BEFORE_COOLDOWN = 5; // Allow a few hiccups before cooling down
    }

    /**
     * Loads keys from process.env based on a prefix (e.g., 'GEMINI', 'GNEWS').
     */
    loadKeys(providerName, envPrefix) {
        const foundKeys = [];
        
        // 1. Look for indexed keys (PREFIX_API_KEY_1, PREFIX_API_KEY_2...)
        for (let i = 1; i <= 20; i++) {
            const key = process.env[`${envPrefix}_API_KEY_${i}`]?.trim();
            if (key) foundKeys.push(key);
        }
        
        // 2. Look for default key (PREFIX_API_KEY)
        const defaultKey = process.env[`${envPrefix}_API_KEY`]?.trim();
        if (defaultKey && !foundKeys.includes(defaultKey)) {
            foundKeys.push(defaultKey);
        }

        if (foundKeys.length === 0) {
            console.warn(`⚠️ KeyManager: No keys found for ${providerName} (Prefix: ${envPrefix})`);
            return;
        }

        // 3. Initialize state for each key
        foundKeys.forEach(k => {
            if (!this.keys.has(k)) {
                this.keys.set(k, {
                    key: k,
                    provider: providerName,
                    status: 'active', // active, cooldown, failed
                    errorCount: 0,
                    lastUsed: 0,
                    lastFailed: 0
                });
            }
        });

        // 4. Initialize rotation index if new
        if (!this.providerIndices.has(providerName)) {
            this.providerIndices.set(providerName, 0);
        }

        console.log(`🔐 KeyManager: Loaded ${foundKeys.length} keys for ${providerName}`);
    }

    /**
     * Gets the next available 'active' key for a provider.
     * Automatically skips keys on cooldown.
     */
    getKey(providerName) {
        const allKeys = Array.from(this.keys.values()).filter(k => k.provider === providerName);
        if (allKeys.length === 0) throw new Error(`No keys configured for ${providerName}`);

        let currentIndex = this.providerIndices.get(providerName) || 0;
        let attempts = 0;

        // Loop through keys to find a valid one
        while (attempts < allKeys.length) {
            const keyObj = allKeys[currentIndex];
            
            // Check Cooldown Expiry
            if (keyObj.status === 'cooldown') {
                const timeInCooldown = Date.now() - keyObj.lastFailed;
                if (timeInCooldown > this.COOLDOWN_TIME) {
                    // Revive key
                    keyObj.status = 'active';
                    keyObj.errorCount = 0;
                    console.log(`✅ KeyManager: Key ...${keyObj.key.slice(-4)} revived for ${providerName}`);
                }
            }

            if (keyObj.status === 'active') {
                // Update rotation index for next time
                this.providerIndices.set(providerName, (currentIndex + 1) % allKeys.length);
                keyObj.lastUsed = Date.now();
                return keyObj.key;
            }

            // Move to next key
            currentIndex = (currentIndex + 1) % allKeys.length;
            attempts++;
        }

        throw new Error(`All keys for ${providerName} are exhausted or on cooldown.`);
    }

    /**
     * Reports a successful usage of a key.
     * Resets error counts if it was previously shaky.
     */
    reportSuccess(key) {
        const keyObj = this.keys.get(key);
        if (keyObj) {
            keyObj.errorCount = 0; // Reset errors on success
            // If it was somehow in a weird state but worked, mark active
            if (keyObj.status !== 'active') keyObj.status = 'active';
        }
    }

    /**
     * Reports a failure.
     * @param {string} key - The API key that failed
     * @param {boolean} isRateLimit - If true, triggers immediate cooldown.
     */
    reportFailure(key, isRateLimit = false) {
        const keyObj = this.keys.get(key);
        if (!keyObj) return;

        keyObj.lastFailed = Date.now();

        if (isRateLimit) {
            keyObj.status = 'cooldown';
            console.warn(`⏳ KeyManager: Rate Limit hit on ...${key.slice(-4)}. Cooling down for ${this.COOLDOWN_TIME / 60000}m.`);
        } else {
            keyObj.errorCount++;
            if (keyObj.errorCount >= this.MAX_ERRORS_BEFORE_COOLDOWN) {
                keyObj.status = 'cooldown';
                console.warn(`⚠️ KeyManager: Key ...${key.slice(-4)} unstable (${keyObj.errorCount} errors). Cooling down.`);
            }
        }
    }
}

// Export as a Singleton
module.exports = new KeyManager();
