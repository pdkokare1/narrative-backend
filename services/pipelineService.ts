// services/pipelineService.ts
import sanitizeHtml from 'sanitize-html'; // NEW: Security Import
import gatekeeper from './gatekeeperService'; 
import aiService from './aiService'; 
import clusteringService from './clusteringService';
import Article from '../models/articleModel';
import logger from '../utils/logger'; 
import redisClient from '../utils/redisClient';
import { IArticle } from '../types';

const SEMANTIC_SIMILARITY_MAX_AGE_HOURS = 24;

class PipelineService {

    // Helper: Check for duplicates
    private async isDuplicate(url: string): Promise<boolean> {
        if (!url) return true;
        // 1. Redis Cache Check (Fast)
        if (await redisClient.sIsMember('processed_urls', url)) return true;
        // 2. DB Check (Reliable)
        if (await Article.exists({ url })) {
            await redisClient.sAdd('processed_urls', url); 
            return true;
        }
        return false;
    }

    // Helper: Sanitize Text to prevent XSS or HTML injection
    private sanitizeContent(text: string): string {
        if (!text) return "";
        return sanitizeHtml(text, {
            allowedTags: [], // Remove ALL HTML tags (<a>, <script>, etc.)
            allowedAttributes: {} // No attributes allowed
        }).trim();
    }

    // Main Logic: Process one article completely
    async processSingleArticle(article: any): Promise<string> {
        try {
            if (!article?.url || !article?.title) return 'ERROR_INVALID';
            
            // 1. Exact Duplicate Check (URL)
            if (await this.isDuplicate(article.url)) return 'DUPLICATE_URL';

            // --- SECURITY & CLEANING ---
            // Sanitize input BEFORE any processing.
            article.title = this.sanitizeContent(article.title);
            article.description = this.sanitizeContent(article.description);
            // ---------------------------

            // --- COST SAVER: Pre-Flight Checks ---
            // Don't waste AI tokens on empty/short content
            const contentLen = (article.description || "").length + (article.content || "").length;
            if (contentLen < 50) {
                logger.warn(`Skipping short content: ${article.title}`);
                return 'JUNK_CONTENT';
            }

            // 2. Gatekeeper (Junk Filter)
            const gatekeeperResult = await gatekeeper.evaluateArticle(article);
            if (gatekeeperResult.isJunk) return 'JUNK_CONTENT';

            // --- STAGE 1: Fuzzy Match (Free & Fast) ---
            let existingMatch = await clusteringService.findSimilarHeadline(article.title);
            let usedFuzzyMatch = false;

            if (existingMatch) {
                usedFuzzyMatch = true;
            }

            let embedding: number[] | null = null;

            // --- STAGE 2: Semantic Search (Paid) ---
            // OPTIMIZATION: Only create embedding if fuzzy match failed.
            if (!existingMatch) {
                const textToEmbed = `${article.title}. ${article.description}`;
                embedding = await aiService.createEmbedding(textToEmbed);

                if (embedding) {
                    existingMatch = await clusteringService.findSemanticDuplicate(embedding, 'Global');
                } else {
                    // CRITICAL: If embedding fails, retry later.
                    throw new Error('Embedding generation failed (Network/API). Retrying article later.');
                }
            }

            // --- Analysis Logic ---
            let analysis: Partial<IArticle>;
            let isSemanticSkip = false;

            // Check Freshness & Validity of the match
            let isMatchFresh = false;
            let isMatchValid = false;

            if (existingMatch) {
                const hoursDiff = (new Date().getTime() - new Date(existingMatch.createdAt!).getTime()) / (1000 * 60 * 60);
                isMatchFresh = hoursDiff < SEMANTIC_SIMILARITY_MAX_AGE_HOURS;
                isMatchValid = !!existingMatch.summary && existingMatch.summary !== "Summary Unavailable";
            }

            if (existingMatch && isMatchFresh && isMatchValid) {
                // INHERITANCE (Free)
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
                // FRESH GENERATION (Paid)
                if (existingMatch) {
                    logger.info(`🔄 Match found but stale/invalid (${existingMatch.createdAt}). Regenerating AI Analysis.`);
                }
                analysis = await aiService.analyzeArticle(article, gatekeeperResult.recommendedModel);
            }

            // 5. Construct & Save
            const newArticleData: Partial<IArticle> = {
                headline: article.title,
                summary: analysis.summary || "Summary Unavailable",
                source: article.source?.name,
                category: analysis.category || "General", 
                politicalLean: analysis.politicalLean || "Not Applicable",
                url: article.url,
                imageUrl: article.image, 
                // SAFETY FIX: Ensure date is valid, default to now if missing
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
                
                analysisVersion: isSemanticSkip ? '3.7-Inherited' : '3.7-Full',
                embedding: embedding || [] 
            };
            
            if (!newArticleData.clusterId) {
                newArticleData.clusterId = await clusteringService.assignClusterId(newArticleData, embedding || undefined);
            }
            
            await Article.create(newArticleData);
            
            // Mark processed for 48h
            await redisClient.set(`processed:${article.url}`, '1', 48 * 60 * 60);
            await redisClient.sAdd('processed_urls', article.url);

            return isSemanticSkip ? 'SAVED_INHERITED' : 'SAVED_FRESH';

        } catch (error: any) {
            // Log full error for debugging
            logger.error(`❌ Pipeline Error for "${article.title}": ${error.message}`);
            
            // Re-throw if it's a critical infrastructure error so the Job Queue knows to retry
            if (error.message.includes('Embedding') || error.message.includes('Connection')) {
                throw error;
            }
            
            return 'ERROR_PIPELINE';
        }
    }
}

export default new PipelineService();
