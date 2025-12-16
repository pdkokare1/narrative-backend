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
        // 1. Redis Cache Check (Fast)
        if (await redisClient.sIsMember('processed_urls', url)) return true;
        // 2. DB Check (Reliable)
        if (await Article.exists({ url })) {
            await redisClient.sAdd('processed_urls', url); // Sync back to cache
            return true;
        }
        return false;
    }

    // Main Logic: Process one article completely
    async processSingleArticle(article: any): Promise<string> {
        try {
            if (!article?.url || !article?.title) return 'ERROR_INVALID';
            
            // 1. Exact Duplicate Check (URL)
            if (await this.isDuplicate(article.url)) return 'DUPLICATE_URL';

            // 2. Gatekeeper (Junk Filter)
            const gatekeeperResult = await gatekeeper.evaluateArticle(article);
            if (gatekeeperResult.isJunk) return 'JUNK_CONTENT';

            // --- OPTIMIZATION: Fuzzy Match (Stage 1) ---
            // Try to find a match using math (Levenshtein) BEFORE calling expensive AI
            let existingMatch = await clusteringService.findSimilarHeadline(article.title);
            let usedFuzzyMatch = false;

            if (existingMatch) {
                logger.debug(`✨ Fuzzy Match found: "${article.title}" ~= "${existingMatch.headline}"`);
                usedFuzzyMatch = true;
            }

            let embedding: number[] | null = null;

            // 3. Create Embedding (ONLY if no fuzzy match found)
            if (!existingMatch) {
                const textToEmbed = `${article.title}. ${article.description}`;
                embedding = await aiService.createEmbedding(textToEmbed);

                // 4. Semantic Search (Stage 2)
                if (embedding) {
                    existingMatch = await clusteringService.findSemanticDuplicate(embedding, 'Global');
                }
            }

            // --- Analysis Logic ---
            let analysis: Partial<IArticle>;
            let isSemanticSkip = false;

            // Check Freshness
            let isMatchFresh = false;
            if (existingMatch) {
                const hoursDiff = (new Date().getTime() - new Date(existingMatch.createdAt!).getTime()) / (1000 * 60 * 60);
                isMatchFresh = hoursDiff < SEMANTIC_SIMILARITY_MAX_AGE_HOURS;
            }

            if (existingMatch && isMatchFresh) {
                // INHERITANCE (Free)
                const matchType = usedFuzzyMatch ? "Fuzzy" : "Semantic";
                logger.info(`💰 Cost Saver! Inheriting analysis from recent ${matchType} match.`);
                isSemanticSkip = true;
                
                analysis = {
                    summary: existingMatch.summary, 
                    category: existingMatch.category,
                    politicalLean: existingMatch.politicalLean, 
                    biasScore: existingMatch.biasScore,
                    trustScore: existingMatch.trustScore,
                    sentiment: existingMatch.sentiment,
                    analysisType: existingMatch.analysisType || 'Full', 
                    clusterTopic: existingMatch.clusterTopic,
                    country: 'Global',
                    clusterId: existingMatch.clusterId,
                };
            } else {
                // FRESH GENERATION (Paid)
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
                publishedAt: new Date(article.publishedAt),
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
                
                analysisVersion: isSemanticSkip ? '3.5-Inherited' : '3.5-Full',
                embedding: embedding || [] 
            };
            
            if (!newArticleData.clusterId) {
                newArticleData.clusterId = await clusteringService.assignClusterId(newArticleData, embedding || undefined);
            }
            
            await Article.create(newArticleData);
            await redisClient.sAdd('processed_urls', article.url);

            return isSemanticSkip ? 'SAVED_INHERITED' : 'SAVED_FRESH';

        } catch (error: any) {
            logger.error(`❌ Pipeline Error for "${article.title}": ${error.message}`);
            return 'ERROR_PIPELINE';
        }
    }
}

export default new PipelineService();
