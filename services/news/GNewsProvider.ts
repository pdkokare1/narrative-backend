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
        KeyManager.registerProviderKeys('GNEWS', config.keys.gnews);
    }

    async fetchArticles(params: any): Promise<INewsSourceArticle[]> {
        return KeyManager.executeWithRetry<INewsSourceArticle[]>('GNEWS', async (apiKey) => {
            const queryParams = { 
                lang: 'en', 
                sortby: 'publishedAt', 
                max: CONSTANTS.NEWS.FETCH_LIMIT, 
                ...params, 
                apikey: apiKey 
            };
            const url = 'https://gnews.io/api/v4/top-headlines';

            const response = await apiClient.get<unknown>(url, { params: queryParams });
            return this.normalize(response.data);
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
