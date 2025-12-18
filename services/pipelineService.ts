// services/pipelineService.ts
import sanitizeHtml from 'sanitize-html';
import gatekeeper from './gatekeeperService'; 
import aiService from './aiService'; 
import clusteringService from './clusteringService';
import Article from '../models/articleModel';
import logger from '../utils/logger'; 
import redisClient from '../utils/redisClient';
import { IArticle } from '../types';

const SEMANTIC_SIMILARITY_MAX_AGE_HOURS = 24;
const BATCH_SIZE = 10;
const BATCH_TIMEOUT_MS = 2000;

class PipelineService {
    private batchQueue: any[] = [];
    private batchTimer: NodeJS.Timeout | null = null;

    private async isDuplicate(url: string): Promise<boolean> {
        if (!url) return true;
        if (await redisClient.sIsMember('processed_urls', url)) return true;
        if (await Article.exists({ url })) {
            await redisClient.sAdd('processed_urls', url); 
            return true;
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

    // New: Batch Embedding Processor
    private async processEmbeddingsBatch() {
        if (this.batchQueue.length === 0) return;

        const currentBatch = [...this.batchQueue];
        this.batchQueue = [];
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }

        try {
            const textsToEmbed = currentBatch.map(item => `${item.article.title}. ${item.article.description}`);
            const embeddings = await aiService.createBatchEmbeddings(textsToEmbed);

            if (embeddings && embeddings.length === currentBatch.length) {
                for (let i = 0; i < currentBatch.length; i++) {
                    currentBatch[i].resolve(embeddings[i]);
                }
            } else {
                throw new Error('Batch embedding response mismatch or failure');
            }
        } catch (error: any) {
            logger.error(`❌ Batch Embedding Failure: ${error.message}`);
            currentBatch.forEach(item => item.reject(error));
        }
    }

    private async getEmbeddingWithBatching(article: any): Promise<number[]> {
        return new Promise((resolve, reject) => {
            this.batchQueue.push({ article, resolve, reject });

            if (this.batchQueue.length >= BATCH_SIZE) {
                this.processEmbeddingsBatch();
            } else if (!this.batchTimer) {
                this.batchTimer = setTimeout(() => this.processEmbeddingsBatch(), BATCH_TIMEOUT_MS);
            }
        });
    }

    async processSingleArticle(article: any): Promise<string> {
        try {
            if (!article?.url || !article?.title) return 'ERROR_INVALID';
            
            if (await this.isDuplicate(article.url)) return 'DUPLICATE_URL';

            article.title = this.sanitizeContent(article.title);
            article.description = this.sanitizeContent(article.description);

            const contentLen = (article.description || "").length + (article.content || "").length;
            if (contentLen < 50) {
                logger.warn(`Skipping short content: ${article.title}`);
                return 'JUNK_CONTENT';
            }

            const gatekeeperResult = await gatekeeper.evaluateArticle(article);
            if (gatekeeperResult.isJunk) return 'JUNK_CONTENT';

            let existingMatch = await clusteringService.findSimilarHeadline(article.title);
            let usedFuzzyMatch = !!existingMatch;
            let embedding: number[] | null = null;

            // --- OPTIMIZED: Using the new Batching Engine ---
            if (!existingMatch) {
                embedding = await this.getEmbeddingWithBatching(article);
                if (embedding) {
                    existingMatch = await clusteringService.findSemanticDuplicate(embedding, 'Global');
                }
            }

            let analysis: Partial<IArticle>;
            let isSemanticSkip = false;

            if (existingMatch) {
                const hoursDiff = (new Date().getTime() - new Date(existingMatch.createdAt!).getTime()) / (1000 * 60 * 60);
                const isMatchFresh = hoursDiff < SEMANTIC_SIMILARITY_MAX_AGE_HOURS;
                const isMatchValid = !!existingMatch.summary && existingMatch.summary !== "Summary Unavailable";

                if (isMatchFresh && isMatchValid) {
                    const matchType = usedFuzzyMatch ? "Fuzzy" : "Semantic";
                    logger.info(`💰 Cost Saver! Inheriting analysis from recent ${matchType} match (ID: ${existingMatch._id})`);
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
                        analysisType: existingMatch.analysisType || 'Full', 
                        clusterTopic: existingMatch.clusterTopic,
                        country: 'Global',
                        clusterId: existingMatch.clusterId,
                        primaryNoun: existingMatch.primaryNoun,
                        secondaryNoun: existingMatch.secondaryNoun,
                        keyFindings: existingMatch.keyFindings || [],
                        recommendations: existingMatch.recommendations || []
                    };
                } else {
                    analysis = await aiService.analyzeArticle(article, gatekeeperResult.recommendedModel);
                }
            } else {
                analysis = await aiService.analyzeArticle(article, gatekeeperResult.recommendedModel);
            }

            const newArticleData: Partial<IArticle> = {
                headline: article.title,
                summary: analysis.summary || "Summary Unavailable",
                source: article.source?.name,
                category: analysis.category || "General", 
                politicalLean: analysis.politicalLean || "Not Applicable",
                url: article.url,
                imageUrl: article.image, 
                publishedAt: article.publishedAt ? new Date(article.publishedAt) : new Date(),
                analysisType: analysis.analysisType || 'Full',
                sentiment: analysis.sentiment || 'Neutral',
                biasScore: analysis.biasScore || 0,
                credibilityScore: analysis.credibilityScore || 0,
                reliabilityScore: analysis.reliabilityScore || 0,
                trustScore: analysis.trustScore || 0,
                clusterTopic: analysis.clusterTopic,
                country: analysis.country || 'Global',
                primaryNoun: analysis.primaryNoun,
                secondaryNoun: analysis.secondaryNoun,
                clusterId: analysis.clusterId, 
                keyFindings: analysis.keyFindings || [],
                recommendations: analysis.recommendations || [],
                analysisVersion: isSemanticSkip ? '3.8-Inherited' : '3.8-Full',
                embedding: embedding || [] 
            };
            
            if (!newArticleData.clusterId) {
                newArticleData.clusterId = await clusteringService.assignClusterId(newArticleData, embedding || undefined);
            }
            
            await Article.create(newArticleData);
            await redisClient.set(`processed:${article.url}`, '1', 48 * 60 * 60);
            await redisClient.sAdd('processed_urls', article.url);

            return isSemanticSkip ? 'SAVED_INHERITED' : 'SAVED_FRESH';

        } catch (error: any) {
            logger.error(`❌ Pipeline Error for "${article.title}": ${error.message}`);
            if (error.message.includes('Embedding') || error.message.includes('Connection')) {
                throw error;
            }
            return 'ERROR_PIPELINE';
        }
    }
}

export default new PipelineService();
