// services/news/GNewsProvider.ts
import { z } from 'zod';
import https from 'https'; // Added for custom agent
import { inspect } from 'util';
import { INewsProvider } from './INewsProvider';
import { INewsSourceArticle } from '../../types';
import KeyManager from '../../utils/KeyManager';
import apiClient from '../../utils/apiClient';
import config from '../../utils/config';
import logger from '../../utils/logger';
import { normalizeUrl } from '../../utils/helpers';

// Specific Schema for GNews Response
const GNewsArticleSchema = z.object({
    source: z.object({ name: z.string().optional() }).optional(),
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    content: z.string().nullable().optional(),
    url: z.string().url(),
    image: z.string().nullable().optional(),
    publishedAt: z.string().optional()
});

const GNewsResponseSchema = z.object({
    totalArticles: z.number().optional(),
    articles: z.array(GNewsArticleSchema).optional()
});

export class GNewsProvider implements INewsProvider {
    name = 'GNews';

    constructor() {
        KeyManager.registerProviderKeys('GNEWS', config.keys.gnews);
    }

    async fetchArticles(params: any): Promise<INewsSourceArticle[]> {
        // FAIL FAST: If no keys are configured
        if (!config.keys.gnews || config.keys.gnews.length === 0) {
            logger.warn('❌ GNews Fetch Skipped: No API keys configured (GNEWS_API_KEY or GNEWS_KEYS).');
            return [];
        }

        return KeyManager.executeWithRetry<INewsSourceArticle[]>('GNEWS', async (apiKey) => {
            
            // Validation: Ensure key is usable
            if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
                throw new Error('GNews Internal Error: Invalid API Key provided by KeyManager.');
            }

            const cleanKey = apiKey.trim();
            const isPaidKey = config.keys.gnews.length > 0 && cleanKey === config.keys.gnews[0];
            const dynamicMax = isPaidKey ? 25 : 10;

            if (isPaidKey) {
                logger.debug(`🚀 Using PAID GNews Key. Fetching ${dynamicMax} articles.`);
            } else {
                logger.debug(`🛡️ Using BACKUP GNews Key. Throttling to ${dynamicMax} articles.`);
            }

            const queryParams = { 
                lang: 'en', 
                sortby: 'publishedAt', 
                max: dynamicMax,
                ...params, 
                apikey: cleanKey 
            };
            
            const url = 'https://gnews.io/api/v4/top-headlines';

            // NETWORK FIX: Force IPv4 and Disable Keep-Alive
            // This bypasses common sticky-connection blocks on shared cloud IPs (Railway/Vercel)
            const agent = new https.Agent({
                keepAlive: false, 
                family: 4 
            });

            try {
                const response = await apiClient.get<unknown>(url, { 
                    params: queryParams,
                    timeout: 30000, // Increased to 30s
                    httpsAgent: agent,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Connection': 'close' // Explicitly close connection
                    }
                });
                
                return this.normalize(response.data);

            } catch (error: any) {
                const status = error.response?.status;
                let errorMessage = error.message || 'Unknown Error';
                const errorCode = error.code || 'UNKNOWN_CODE';

                // 1. Try to extract API-specific error message
                if (error.response?.data?.errors) {
                    const gnewsErrors = error.response.data.errors;
                    if (Array.isArray(gnewsErrors)) {
                        errorMessage = gnewsErrors.join(', ');
                    } else if (typeof gnewsErrors === 'object') {
                         errorMessage = JSON.stringify(gnewsErrors);
                    } else {
                        errorMessage = String(gnewsErrors);
                    }
                }

                // 2. Log based on Error Type
                if (status === 401 || status === 403) {
                    logger.error(`❌ GNews Auth Failed (${status}): ${errorMessage}`);
                } else if (status === 429) {
                    logger.warn(`⏳ GNews Rate Limited (429). Key ending in ...${cleanKey.slice(-4)}`);
                } else {
                    // CRITICAL: Log the full error object for "Local" errors
                    logger.error(`❌ GNews Fetch Failed [${errorCode}]: ${errorMessage}`);
                    if (!status) {
                        // Log full network error for debugging (DNS/Timeout)
                        logger.error(`🔍 Full Error Details: ${inspect(error, { depth: 2, colors: false })}`);
                    }
                }

                // 3. Throw descriptive error for KeyManager
                throw new Error(`[GNews ${status || errorCode}] ${errorMessage}`);
            }
        });
    }

    private normalize(data: any): INewsSourceArticle[] {
        const result = GNewsResponseSchema.safeParse(data);

        if (!result.success) {
            logger.error(`[GNews] Schema Mismatch: ${JSON.stringify(result.error.format())}`);
            return [];
        }

        return (result.data.articles || [])
            .filter(a => a.url)
            .map(a => ({
                source: { name: a.source?.name || 'GNews' },
                title: a.title || "",
                description: a.description || a.content || "",
                url: normalizeUrl(a.url!),
                image: a.image || undefined,
                publishedAt: a.publishedAt || new Date().toISOString()
            }));
    }
}
