import { z } from 'zod';
import { INewsProvider } from './INewsProvider';
import { INewsSourceArticle } from '../../types';
import KeyManager from '../../utils/KeyManager';
import apiClient from '../../utils/apiClient';
import config from '../../utils/config';
import logger from '../../utils/logger';
import { normalizeUrl } from '../../utils/helpers';
import { CONSTANTS } from '../../utils/constants';

// Specific Schema for NewsAPI Response
const NewsApiArticleSchema = z.object({
    source: z.object({ name: z.string().optional() }).optional(),
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    content: z.string().nullable().optional(),
    url: z.string().url(),
    urlToImage: z.string().nullable().optional(), // NewsAPI uses 'urlToImage'
    publishedAt: z.string().optional()
});

const NewsApiResponseSchema = z.object({
    status: z.string().optional(),
    totalResults: z.number().optional(),
    articles: z.array(NewsApiArticleSchema).optional()
});

export class NewsApiProvider implements INewsProvider {
    name = 'NewsAPI';

    constructor() {
        KeyManager.registerProviderKeys('NEWS_API', config.keys.newsApi);
    }

    async fetchArticles(params: any): Promise<INewsSourceArticle[]> {
        return KeyManager.executeWithRetry<INewsSourceArticle[]>('NEWS_API', async (apiKey) => {
            const endpoint = params.q ? 'everything' : 'top-headlines';
            const queryParams = { 
                pageSize: CONSTANTS.NEWS.FETCH_LIMIT, 
                ...params, 
                apiKey: apiKey 
            };
            const url = `https://newsapi.org/v2/${endpoint}`;

            const response = await apiClient.get<unknown>(url, { params: queryParams });
            return this.normalize(response.data);
        });
    }

    private normalize(data: any): INewsSourceArticle[] {
        const result = NewsApiResponseSchema.safeParse(data);

        if (!result.success) {
            logger.error(`[NewsAPI] Schema Mismatch: ${JSON.stringify(result.error.format())}`);
            return [];
        }

        return (result.data.articles || [])
            .filter(a => a.url)
            .map(a => ({
                source: { name: a.source?.name || 'NewsAPI' },
                title: a.title || "",
                description: a.description || a.content || "",
                url: normalizeUrl(a.url!),
                image: a.urlToImage || undefined, // Mapping happens here
                publishedAt: a.publishedAt || new Date().toISOString()
            }));
    }
}
