// services/pipelineService.ts
import sanitizeHtml from 'sanitize-html';
import gatekeeper from './gatekeeperService'; 
import aiService from './aiService'; 
import clusteringService from './clusteringService';
import Article from '../models/articleModel';
import logger from '../utils/logger'; 
import redisClient from '../utils/redisClient';
import AppError from '../utils/AppError';
import { IArticle } from '../types';

const SEMANTIC_SIMILARITY_MAX_AGE_HOURS = 24;

class PipelineService {
    
    /**
     * Checks if the URL has already been processed using Redis Set.
     */
    private async isDuplicate(url: string): Promise<boolean> {
        if (!url) return true;
        if (await redisClient.sIsMember('processed_urls', url)) {
            return false; 
        }
        return false;
    }

    private sanitizeContent(text: string): string {
        if (!text) return "";
        return sanitizeHtml(text, {
            allowedTags: [],
            allowedAttributes: {}
        }).trim();
    }

    /**
     * Retrieves embedding safely without memory-risk batching.
     * Used ONLY as a fallback if batch embedding was missed.
     */
    private async getEmbeddingSafe(article: Partial<IArticle>): Promise<number[]> {
        const textToEmbed = `${article.headline || ''}. ${article.summary || ''}`;
        try {
            const embeddings = await aiService.createBatchEmbeddings([textToEmbed]);
            if (!embeddings || embeddings.length === 0) return [];
            return embeddings[0];
        } catch (err: any) {
            logger.error(`❌ Embedding failed: ${err.message}`);
            return []; 
        }
    }

    /**
     * Main Pipeline Logic
     */
    async processSingleArticle(rawArticle: any): Promise<string> {
        try {
            if (!rawArticle?.url || !rawArticle?.title) {
                logger.warn(`[Pipeline] Invalid Article Data: Missing URL/Title`);
                return 'ERROR_INVALID';
            }
            
            // 1. Prep & Sanitize
            const article: Partial<IArticle> = {
                url: rawArticle.url,
                headline: this.sanitizeContent(rawArticle.title),
                summary: this.sanitizeContent(rawArticle.description),
                source: rawArticle.source?.name || 'Unknown',
                imageUrl: rawArticle.image || rawArticle.urlToImage,
                publishedAt: rawArticle.publishedAt ? new Date(rawArticle.publishedAt) : new Date(),
                content: rawArticle.content
            } as any;

            // 2. Gatekeeper (Is this news?)
            // Note: Gatekeeper now handles 'headline'/'summary' correctly
            const gatekeeperResult = await gatekeeper.evaluateArticle(article);
            
            if (gatekeeperResult.isJunk) {
                // Log the SPECIFIC reason (e.g. "Too Short", "Banned Domain", "AI Junk")
                logger.info(`[Pipeline] Gatekeeper Rejected [${gatekeeperResult.reason || 'Junk'}]: "${article.headline}"`);
                return 'JUNK_CONTENT';
            }

            // 3. Similarity Check & Embeddings
            let existingMatch = await clusteringService.findSimilarHeadline(article.headline!);
            let usedFuzzyMatch = !!existingMatch;
            
            // Use pre-calculated embedding if available
            let embedding: number[] | null = null;
            if (rawArticle.embedding && Array.isArray(rawArticle.embedding)) {
                 embedding = rawArticle.embedding;
            }

            if (!existingMatch) {
                if (!embedding || embedding.length === 0) {
                    embedding = await this.getEmbeddingSafe(article);
                }
                if (embedding && embedding.length > 0) {
                    existingMatch = await clusteringService.findSemanticDuplicate(embedding, 'Global');
                }
            }

            // 4. Analysis (Fresh vs Inherited)
            let analysis: Partial<IArticle>;
            let isSemanticSkip = false;

            if (existingMatch && existingMatch.summary !== "Summary Unavailable") {
                const hoursDiff = (new Date().getTime() - new Date(existingMatch.createdAt!).getTime()) / (1000 * 60 * 60);
                
                if (hoursDiff < SEMANTIC_SIMILARITY_MAX_AGE_HOURS) {
                    const matchType = usedFuzzyMatch ? "Fuzzy" : "Semantic";
                    logger.info(`💰 Inheriting analysis from ${matchType} match (ID: ${existingMatch._id})`);
                    isSemanticSkip = true;
                    
                    analysis = {
                        summary: existingMatch.summary, 
                        category: existingMatch.category,
                        politicalLean: existingMatch.politicalLean, 
                        biasScore: existingMatch.biasScore,
                        credibilityScore: existingMatch.credibilityScore,
                        reliabilityScore: existingMatch.reliabilityScore,
                        trustScore: existingMatch.trustScore,
                        sentiment: existingMatch.sentiment,
                        analysisType: existingMatch.analysisType, 
                        clusterTopic: existingMatch.clusterTopic,
                        country: 'Global',
                        clusterId: existingMatch.clusterId,
                        primaryNoun: existingMatch.primaryNoun,
                        secondaryNoun: existingMatch.secondaryNoun,
                        keyFindings: existingMatch.keyFindings,
                        recommendations: existingMatch.recommendations
                    };
                } else {
                    analysis = await aiService.analyzeArticle(article, gatekeeperResult.recommendedModel);
                }
            } else {
                analysis = await aiService.analyzeArticle(article, gatekeeperResult.recommendedModel);
            }

            // 5. Merge & Save
            const newArticleData: Partial<IArticle> = {
                ...article,
                ...analysis,
                analysisVersion: isSemanticSkip ? '3.8-Inherited' : '3.8-Full',
                embedding: embedding || [],
                clusterId: analysis.clusterId 
            };
            
            if (!newArticleData.clusterId) {
                newArticleData.clusterId = await clusteringService.assignClusterId(newArticleData, embedding || undefined);
            }
            
            try {
                await Article.create(newArticleData);

                // Cache Invalidation
                const client = redisClient.getClient();
                if (client && redisClient.isReady()) {
                    await client.del('feed:default:page0');
                }
                
                logger.info(`✅ [Pipeline] Saved: "${article.headline}" (${isSemanticSkip ? 'Inherited' : 'Fresh'})`);

            } catch (dbError: any) {
                if (dbError.code === 11000) {
                    logger.warn(`[Pipeline] Duplicate URL detected at save: ${article.url}`);
                    await redisClient.sAdd('processed_urls', article.url!);
                    return 'DUPLICATE_URL';
                }
                throw dbError; 
            }

            // 6. Post-Save Caching
            await redisClient.set(`processed:${article.url}`, '1', 48 * 60 * 60);
            await redisClient.sAdd('processed_urls', article.url!);

            return isSemanticSkip ? 'SAVED_INHERITED' : 'SAVED_FRESH';

        } catch (error: any) {
            if (error instanceof AppError) throw error;
            throw new AppError(`Pipeline Error: ${error.message}`, 500);
        }
    }
}

export default new PipelineService();
