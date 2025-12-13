// utils/KeyManager.ts
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
    private readonly COOLDOWN_TIME = 10 * 60 * 1000;
    private readonly MAX_ERRORS_BEFORE_COOLDOWN = 5;

    constructor() {
        this.keys = new Map();
        this.providerIndices = new Map();
    }

    public loadKeys(providerName: string, envPrefix: string): void {
        const foundKeys: string[] = [];
        for (let i = 1; i <= 20; i++) {
            const key = process.env[`${envPrefix}_API_KEY_${i}`]?.trim();
            if (key) foundKeys.push(key);
        }
        const defaultKey = process.env[`${envPrefix}_API_KEY`]?.trim();
        if (defaultKey && !foundKeys.includes(defaultKey)) foundKeys.push(defaultKey);

        if (foundKeys.length === 0) {
            console.warn(`⚠️ KeyManager: No keys found for ${providerName} (Prefix: ${envPrefix})`);
            return;
        }

        foundKeys.forEach(k => {
            if (!this.keys.has(k)) {
                this.keys.set(k, { key: k, provider: providerName, status: 'active', errorCount: 0, lastUsed: 0, lastFailed: 0 });
            }
        });

        if (!this.providerIndices.has(providerName)) this.providerIndices.set(providerName, 0);
        console.log(`🔐 KeyManager: Loaded ${foundKeys.length} keys for ${providerName}`);
    }

    public getKey(providerName: string): string {
        const allKeys = Array.from(this.keys.values()).filter(k => k.provider === providerName);
        if (allKeys.length === 0) throw new Error(`No keys configured for ${providerName}`);

        let currentIndex = this.providerIndices.get(providerName) || 0;
        let attempts = 0;

        while (attempts < allKeys.length) {
            const keyObj = allKeys[currentIndex];
            if (keyObj.status === 'cooldown') {
                const timeInCooldown = Date.now() - keyObj.lastFailed;
                if (timeInCooldown > this.COOLDOWN_TIME) {
                    keyObj.status = 'active';
                    keyObj.errorCount = 0;
                    console.log(`✅ KeyManager: Key ...${keyObj.key.slice(-4)} revived for ${providerName}`);
                }
            }
            if (keyObj.status === 'active') {
                this.providerIndices.set(providerName, (currentIndex + 1) % allKeys.length);
                keyObj.lastUsed = Date.now();
                return keyObj.key;
            }
            currentIndex = (currentIndex + 1) % allKeys.length;
            attempts++;
        }
        throw new Error(`All keys for ${providerName} are exhausted or on cooldown.`);
    }

    public reportSuccess(key: string): void {
        const keyObj = this.keys.get(key);
        if (keyObj) {
            keyObj.errorCount = 0;
            if (keyObj.status !== 'active') keyObj.status = 'active';
        }
    }

    public reportFailure(key: string, isRateLimit: boolean = false): void {
        const keyObj = this.keys.get(key);
        if (!keyObj) return;
        keyObj.lastFailed = Date.now();
        if (isRateLimit) {
            keyObj.status = 'cooldown';
            console.warn(`⏳ KeyManager: Rate Limit hit on ...${key.slice(-4)}. Cooling down.`);
        } else {
            keyObj.errorCount++;
            if (keyObj.errorCount >= this.MAX_ERRORS_BEFORE_COOLDOWN) {
                keyObj.status = 'cooldown';
                console.warn(`⚠️ KeyManager: Key ...${key.slice(-4)} unstable. Cooling down.`);
            }
        }
    }
}

export = new KeyManager();
