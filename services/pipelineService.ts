// services/pipelineService.ts
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
        if (await redisClient.sIsMember('processed_urls', url)) return true;
        if (await Article.exists({ url })) {
            await redisClient.sAdd('processed_urls', url); 
            return true;
        }
        return false;
    }

    async processSingleArticle(article: any): Promise<string> {
        try {
            if (!article?.url || !article?.title) return 'ERROR_INVALID';
            
            // 1. Instant Duplicate Check
            if (await this.isDuplicate(article.url)) return 'DUPLICATE_URL';

            // 2. Content Length Check
            const contentLen = (article.description || "").length + (article.content || "").length;
            if (contentLen < 50) return 'JUNK_CONTENT';

            // 3. Gatekeeper LOCAL Check (Free)
            // We do NOT run the AI check yet. We just check keywords/banned domains.
            const localCheck = await gatekeeper.evaluateArticle(article, true); // true = localOnly
            if (localCheck.isJunk) return 'JUNK_CONTENT';

            // --- STAGE 1: Fuzzy Match (Free) ---
            // If we find a match here, we SKIP the expensive Gatekeeper AI check
            let existingMatch = await clusteringService.findSimilarHeadline(article.title);
            let usedFuzzyMatch = !!existingMatch;

            // --- STAGE 2: Gatekeeper AI Check (Paid) ---
            // Only run this if we didn't find a fuzzy match (because if we matched, it's valid news)
            let recommendedModel = 'gemini-1.5-pro';
            
            if (!existingMatch) {
                const gatekeeperResult = await gatekeeper.evaluateArticle(article, false); // false = full check
                if (gatekeeperResult.isJunk) return 'JUNK_CONTENT';
                recommendedModel = gatekeeperResult.recommendedModel;
            }

            // --- STAGE 3: Semantic Search (Paid) ---
            let embedding: number[] | null = null;
            if (!existingMatch) {
                const textToEmbed = `${article.title}. ${article.description}`;
                embedding = await aiService.createEmbedding(textToEmbed);

                if (embedding) {
                    existingMatch = await clusteringService.findSemanticDuplicate(embedding, 'Global');
                } else {
                    throw new Error('Embedding generation failed. Retrying article later.');
                }
            }

            // --- Analysis Logic ---
            let analysis: Partial<IArticle>;
            let isSemanticSkip = false;
            let isMatchFresh = false;

            if (existingMatch) {
                const hoursDiff = (new Date().getTime() - new Date(existingMatch.createdAt!).getTime()) / (1000 * 60 * 60);
                isMatchFresh = hoursDiff < SEMANTIC_SIMILARITY_MAX_AGE_HOURS;
            }

            // INHERITANCE (Free)
            if (existingMatch && isMatchFresh) {
                logger.info(`💰 Cost Saver! Inheriting analysis from match (ID: ${existingMatch._id})`);
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
                analysis = await aiService.analyzeArticle(article, recommendedModel);
            }

            // 4. Construct & Save
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
            logger.error(`❌ Pipeline Error for "${article.title}": ${error.message}`);
            if (error.message.includes('Embedding') || error.message.includes('Connection')) throw error;
            return 'ERROR_PIPELINE';
        }
    }
}

export default new PipelineService();
