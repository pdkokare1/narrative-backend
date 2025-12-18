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

// Types for the Batch Queue
interface BatchItem {
    article: Partial<IArticle>;
    resolve: (value: number[]) => void;
    reject: (reason?: any) => void;
}

const SEMANTIC_SIMILARITY_MAX_AGE_HOURS = 24;
const BATCH_SIZE = 10;
const BATCH_TIMEOUT_MS = 2000;

class PipelineService {
    private batchQueue: BatchItem[] = [];
    private batchTimer: NodeJS.Timeout | null = null;

    /**
     * Checks if the URL has already been processed using Redis Set and MongoDB
     */
    private async isDuplicate(url: string): Promise<boolean> {
        if (!url) return true;
        // 1. Fast Check (Redis)
        if (await redisClient.sIsMember('processed_urls', url)) return true;
        // 2. Deep Check (Mongo)
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

    /**
     * BATCH PROCESSOR: Sends accumulated texts to AI Service
     */
    private async processEmbeddingsBatch() {
        if (this.batchQueue.length === 0) return;

        // Copy and clear queue immediately to unblock new additions
        const currentBatch = [...this.batchQueue];
        this.batchQueue = [];
        
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }

        try {
            const textsToEmbed = currentBatch.map(item => 
                `${item.article.headline || ''}. ${item.article.summary || ''}`
            );
            
            const embeddings = await aiService.createBatchEmbeddings(textsToEmbed);

            if (embeddings && embeddings.length === currentBatch.length) {
                // Success: Resolve all promises
                for (let i = 0; i < currentBatch.length; i++) {
                    currentBatch[i].resolve(embeddings[i]);
                }
            } else {
                throw new AppError('Batch embedding count mismatch', 502);
            }
        } catch (error: any) {
            logger.error(`❌ Batch Embedding Failure: ${error.message}`);
            // Critical: Reject all items so the worker knows to retry them individually or fail the job
            currentBatch.forEach(item => item.reject(error));
        }
    }

    /**
     * Adds an article to the batch queue and waits for its embedding
     */
    private async getEmbeddingWithBatching(article: Partial<IArticle>): Promise<number[]> {
        return new Promise((resolve, reject) => {
            this.batchQueue.push({ article, resolve, reject });

            if (this.batchQueue.length >= BATCH_SIZE) {
                this.processEmbeddingsBatch();
            } else if (!this.batchTimer) {
                this.batchTimer = setTimeout(() => this.processEmbeddingsBatch(), BATCH_TIMEOUT_MS);
            }
        });
    }

    /**
     * Main Pipeline Logic
     */
    async processSingleArticle(rawArticle: any): Promise<string> {
        try {
            if (!rawArticle?.url || !rawArticle?.title) {
                logger.warn('Skipping invalid article structure');
                return 'ERROR_INVALID';
            }
            
            // 1. Duplicate Check
            if (await this.isDuplicate(rawArticle.url)) return 'DUPLICATE_URL';

            // 2. Prep & Sanitize
            const article: Partial<IArticle> = {
                url: rawArticle.url,
                headline: this.sanitizeContent(rawArticle.title),
                summary: this.sanitizeContent(rawArticle.description), // Initial summary is often the description
                source: rawArticle.source?.name || 'Unknown',
                imageUrl: rawArticle.image || rawArticle.urlToImage,
                publishedAt: rawArticle.publishedAt ? new Date(rawArticle.publishedAt) : new Date(),
                content: rawArticle.content // Temporary field for analysis
            } as any;

            const contentLen = (article.summary || "").length + (rawArticle.content || "").length;
            if (contentLen < 50) {
                return 'JUNK_CONTENT';
            }

            // 3. Gatekeeper (Is this news?)
            const gatekeeperResult = await gatekeeper.evaluateArticle(article);
            if (gatekeeperResult.isJunk) return 'JUNK_CONTENT';

            // 4. Similarity Check & Embeddings
            let existingMatch = await clusteringService.findSimilarHeadline(article.headline!);
            let usedFuzzyMatch = !!existingMatch;
            let embedding: number[] | null = null;

            if (!existingMatch) {
                // Try to get embedding via Batch System
                try {
                    embedding = await this.getEmbeddingWithBatching(article);
                    if (embedding) {
                        existingMatch = await clusteringService.findSemanticDuplicate(embedding, 'Global');
                    }
                } catch (batchErr) {
                    // If batch fails, we don't crash, but we might skip semantic check
                    logger.warn(`Batch embedding failed, proceeding without vector check: ${batchErr}`);
                }
            }

            // 5. Analysis (Fresh vs Inherited)
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

            // 6. Merge & Save
            const newArticleData: Partial<IArticle> = {
                ...article,
                ...analysis,
                analysisVersion: isSemanticSkip ? '3.8-Inherited' : '3.8-Full',
                embedding: embedding || [],
                clusterId: analysis.clusterId 
            };
            
            // Assign Cluster ID if missing
            if (!newArticleData.clusterId) {
                newArticleData.clusterId = await clusteringService.assignClusterId(newArticleData, embedding || undefined);
            }
            
            await Article.create(newArticleData);

            // 7. Post-Save Caching
            await redisClient.set(`processed:${article.url}`, '1', 48 * 60 * 60);
            await redisClient.sAdd('processed_urls', article.url!);

            return isSemanticSkip ? 'SAVED_INHERITED' : 'SAVED_FRESH';

        } catch (error: any) {
            // Throwing AppError allows the Worker to decide whether to retry
            if (error instanceof AppError) throw error;
            throw new AppError(`Pipeline Error: ${error.message}`, 500);
        }
    }
}

export default new PipelineService();
