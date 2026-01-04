// services/pipelineService.ts
import crypto from 'crypto';
import sanitizeHtml from 'sanitize-html';
import gatekeeper from './gatekeeperService'; 
import aiService from './aiService'; 
import clusteringService from './clusteringService';
import statsService from './statsService'; // RESTORED
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
        const isMember = await redisClient.sIsMember('processed_urls', url);
        return !!isMember; 
    }

    /**
     * Checks if the TITLE has already been processed.
     * Optimization for syndicated content (same title, different URL).
     */
    private async isTitleDuplicate(title: string): Promise<boolean> {
        if (!title) return false;
        // Create a simple slug: "Man Bites Dog" -> "man-bites-dog"
        const slug = title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');
        const isMember = await redisClient.sIsMember('processed_titles', slug);
        return !!isMember;
    }

    private sanitizeContent(text: string): string {
        if (!text) return "";
        return sanitizeHtml(text, {
            allowedTags: [],
            allowedAttributes: {}
        }).trim();
    }

    /**
     * Basic validation to ensure we don't save broken image links.
     */
    private validateImageUrl(url?: string): string | undefined {
        if (!url) return undefined;
        if (url.length > 500) return undefined; // Too long
        if (!url.startsWith('http')) return undefined;
        // Filter out common "tracker" pixels or tiny icons
        if (url.includes('1x1') || url.includes('pixel')) return undefined;
        return url;
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
     * Now includes detailed metrics and timing.
     */
    async processSingleArticle(rawArticle: any): Promise<string> {
        const startTime = Date.now();
        const shortTitle = rawArticle.title?.substring(0, 40) || 'Unknown';

        // DEBUG LOG: Start
        logger.info(`🚀 [Pipeline] Start: "${shortTitle}..."`);

        try {
            // --- STEP 1: Validation ---
            if (!rawArticle?.url || !rawArticle?.title) {
                logger.warn(`[Pipeline] ❌ Invalid Data: Missing URL/Title`);
                return 'ERROR_INVALID';
            }

            // ⚡ OPTIMIZATION: Early Duplicate Detection
            if (await this.isDuplicate(rawArticle.url)) {
                await statsService.increment('pipeline_duplicate_url');
                return 'DUPLICATE_REDIS';
            }

            if (await this.isTitleDuplicate(rawArticle.title)) {
                await statsService.increment('pipeline_duplicate_title');
                logger.info(`[Pipeline] ⏭️ Syndicated Title Detected: "${shortTitle}"`);
                return 'DUPLICATE_TITLE';
            }
            
            // ⚡ Traffic Staggering (Prevent API Spikes)
            await new Promise(resolve => setTimeout(resolve, Math.random() * 300 + 100));

            // --- STEP 2: Sanitization ---
            const article: Partial<IArticle> = {
                url: rawArticle.url,
                headline: this.sanitizeContent(rawArticle.title),
                summary: this.sanitizeContent(rawArticle.description),
                source: rawArticle.source?.name || 'Unknown',
                imageUrl: this.validateImageUrl(rawArticle.image || rawArticle.urlToImage),
                publishedAt: rawArticle.publishedAt ? new Date(rawArticle.publishedAt) : new Date(),
                content: rawArticle.content
            } as any;

            // --- STEP 3: Gatekeeper ---
            const gatekeeperResult = await gatekeeper.evaluateArticle(article);
            
            if (gatekeeperResult.isJunk) {
                logger.info(`[Pipeline] 🛑 Gatekeeper Rejected [${gatekeeperResult.reason}]: "${shortTitle}"`);
                await statsService.increment('pipeline_junk_rejected');
                return 'JUNK_CONTENT';
            }

            // --- STEP 4: Similarity & Embeddings ---
            let existingMatch = await clusteringService.findSimilarHeadline(article.headline!);
            let usedFuzzyMatch = !!existingMatch;
            
            // Retrieve from Redis Sidecar
            let embedding: number[] | null = null;
            if (rawArticle.embedding && Array.isArray(rawArticle.embedding)) {
                 embedding = rawArticle.embedding;
            }

            if ((!embedding || embedding.length === 0) && redisClient.isReady()) {
                try {
                    const client = redisClient.getClient();
                    if (client) {
                        const urlHash = crypto.createHash('md5').update(rawArticle.url).digest('hex');
                        const key = `temp:embedding:${urlHash}`;
                        const cachedRaw = await client.get(key);
                        if (cachedRaw) {
                            embedding = JSON.parse(cachedRaw);
                            await client.del(key); // Cleanup
                        }
                    }
                } catch (err) { /* Silent Fail */ }
            }

            if (!existingMatch) {
                if (!embedding || embedding.length === 0) {
                    embedding = await this.getEmbeddingSafe(article);
                }
                if (embedding && embedding.length > 0) {
                    existingMatch = await clusteringService.findSemanticDuplicate(embedding, 'Global');
                }
            }

            // --- STEP 5: Analysis (AI vs Inheritance) ---
            let analysis: Partial<IArticle>;
            let isSemanticSkip = false;

            if (existingMatch && existingMatch.summary !== "Summary Unavailable") {
                const hoursDiff = (new Date().getTime() - new Date(existingMatch.createdAt!).getTime()) / (1000 * 60 * 60);
                
                if (hoursDiff < SEMANTIC_SIMILARITY_MAX_AGE_HOURS) {
                    isSemanticSkip = true;
                    logger.info(`[Pipeline] 🧬 Inheriting Analysis from Match (ID: ${existingMatch._id})`);
                    
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
                    await statsService.increment('pipeline_analysis_inherited');
                } else {
                    analysis = await aiService.analyzeArticle(article, gatekeeperResult.recommendedModel);
                    await statsService.increment('pipeline_analysis_fresh');
                }
            } else {
                analysis = await aiService.analyzeArticle(article, gatekeeperResult.recommendedModel);
                await statsService.increment('pipeline_analysis_fresh');
            }

            // Check for AI Failures
            let finalAnalysisVersion = isSemanticSkip ? '3.8-Inherited' : '3.8-Full';
            if (analysis.summary && analysis.summary.includes("Analysis unavailable (System Error)")) {
                logger.warn(`⚠️ [Pipeline] AI Failure. Marking as PENDING.`);
                finalAnalysisVersion = 'pending';
                await statsService.increment('pipeline_ai_failure');
            }

            // --- STEP 6: Database Save ---
            const newArticleData: Partial<IArticle> = {
                ...article,
                ...analysis,
                analysisVersion: finalAnalysisVersion,
                embedding: embedding || [],
                clusterId: analysis.clusterId 
            };
            
            if (!newArticleData.clusterId) {
                newArticleData.clusterId = await clusteringService.assignClusterId(newArticleData, embedding || undefined);
            }
            
            try {
                await Article.create(newArticleData);

                // Cache Invalidation
                if (redisClient.isReady()) {
                    await redisClient.del('feed:default:page0');
                }

                const duration = Date.now() - startTime;
                logger.info(`✅ [Pipeline] Saved: "${shortTitle}" (${duration}ms)`);

            } catch (dbError: any) {
                if (dbError.code === 11000) {
                    await redisClient.sAdd('processed_urls', article.url!);
                    return 'DUPLICATE_URL';
                }
                throw dbError; 
            }

            // --- STEP 7: Post-Processing & Cleanup ---
            if (redisClient.isReady()) {
                await redisClient.set(`processed:${article.url}`, '1', 48 * 60 * 60);
                await redisClient.sAdd('processed_urls', article.url!);
                
                const titleSlug = article.headline!.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');
                await redisClient.sAdd('processed_titles', titleSlug);
            }

            return isSemanticSkip ? 'SAVED_INHERITED' : 'SAVED_FRESH';

        } catch (error: any) {
            const duration = Date.now() - startTime;
            logger.error(`❌ [Pipeline] Failed after ${duration}ms: ${error.message}`);
            await statsService.increment('pipeline_errors');
            
            if (error instanceof AppError) throw error;
            throw new AppError(`Pipeline Error: ${error.message}`, 500);
        }
    }
}

export default new PipelineService();
