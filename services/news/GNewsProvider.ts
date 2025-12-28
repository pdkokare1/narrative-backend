import { z } from 'zod';
import { INewsProvider } from './INewsProvider';
import { INewsSourceArticle } from '../../types';
import KeyManager from '../../utils/KeyManager';
import apiClient from '../../utils/apiClient';
import config from '../../utils/config';
import logger from '../../utils/logger';
import { normalizeUrl } from '../../utils/helpers';
import { CONSTANTS } from '../../utils/constants';

// Specific Schema for GNews Response
const GNewsArticleSchema = z.object({
    source: z.object({ name: z.string().optional() }).optional(),
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    content: z.string().nullable().optional(),
    url: z.string().url(),
    image: z.string().nullable().optional(), // GNews uses 'image'
    publishedAt: z.string().optional()
});

const GNewsResponseSchema = z.object({
    totalArticles: z.number().optional(),
    articles: z.array(GNewsArticleSchema).optional()
});

export class GNewsProvider implements INewsProvider {
    name = 'GNews';

    constructor() {
        // Register keys specifically for this provider
        // config.keys.gnews is an array of strings (e.g., [PaidKey, FreeKey1, FreeKey2...])
        KeyManager.registerProviderKeys('GNEWS', config.keys.gnews);
    }

    async fetchArticles(params: any): Promise<INewsSourceArticle[]> {
        return KeyManager.executeWithRetry<INewsSourceArticle[]>('GNEWS', async (apiKey) => {
            
            // ⚡ SMART OPTIMIZATION: Check if this is the Paid Essential Key (Key #1)
            // Essential Plan allows 25 articles. Free Plan allows 10.
            const isPaidKey = config.keys.gnews.length > 0 && apiKey === config.keys.gnews[0];
            const dynamicMax = isPaidKey ? 25 : 10;

            if (isPaidKey) {
                logger.debug(`🚀 Using PAID GNews Key. Fetching ${dynamicMax} articles.`);
            } else {
                logger.debug(`🛡️ Using BACKUP GNews Key. Throttling to ${dynamicMax} articles.`);
            }

            const queryParams = { 
                lang: 'en', 
                sortby: 'publishedAt', 
                max: dynamicMax, // Use the dynamic limit
                ...params, 
                apikey: apiKey 
            };
            const url = 'https://gnews.io/api/v4/top-headlines';

            try {
                const response = await apiClient.get<unknown>(url, { params: queryParams });
                return this.normalize(response.data);
            } catch (error: any) {
                // EXPLICIT DEBUGGING for GNews Errors
                const status = error.response?.status;
                if (status === 401 || status === 403) {
                    logger.error(`❌ GNews Auth Failed (${status}). Check API Key.`);
                } else if (status === 429) {
                    logger.warn(`⏳ GNews Rate Limited (429). Key: ...${apiKey.slice(-4)}`);
                }
                throw error;
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
