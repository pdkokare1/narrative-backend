// jobs/newsFetcher.ts
import newsService from '../services/newsService';
import gatekeeper from '../services/gatekeeperService'; 
import aiService from '../services/aiService'; 
import clusteringService from '../services/clusteringService';
import Article from '../models/articleModel';
import logger from '../utils/logger'; 
import redisClient from '../utils/redisClient';
import { IArticle } from '../types';

// --- PIPELINE CONSTANTS ---
const SEMANTIC_SIMILARITY_MAX_AGE_HOURS = 24; // If match is older than this, re-analyze
const BATCH_SIZE = 5;

// --- HELPERS ---
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function isDuplicate(url: string): Promise<boolean> {
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

// --- MAIN PROCESSOR ---

async function processSingleArticle(article: any): Promise<string> {
    try {
        if (!article?.url || !article?.title) return 'ERROR_INVALID';
        
        // 1. Exact Duplicate Check
        if (await isDuplicate(article.url)) return 'DUPLICATE_URL';

        // 2. Gatekeeper (Junk Filter)
        const gatekeeperResult = await gatekeeper.evaluateArticle(article);
        if (gatekeeperResult.isJunk) return 'JUNK_CONTENT';

        // 3. Create Embedding
        const textToEmbed = `${article.title}. ${article.description}`;
        const embedding = await aiService.createEmbedding(textToEmbed);

        // 4. Semantic Search (The "Cost Saver")
        // We look for a similar article in the DB to potentially reuse its analysis
        const existingMatch = await clusteringService.findSemanticDuplicate(embedding || undefined, 'Global');
        
        let analysis: Partial<IArticle>;
        let isSemanticSkip = false;

        // --- NEW LOGIC: Freshness Check ---
        // Only inherit if the match is recent. If it's old news, we re-analyze.
        let isMatchFresh = false;
        if (existingMatch) {
            const hoursDiff = (new Date().getTime() - new Date(existingMatch.createdAt!).getTime()) / (1000 * 60 * 60);
            isMatchFresh = hoursDiff < SEMANTIC_SIMILARITY_MAX_AGE_HOURS;
        }

        if (existingMatch && isMatchFresh) {
            logger.info(`💰 Cost Saver! Inheriting analysis from recent match: "${existingMatch.headline.substring(0,20)}..."`);
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
            if (existingMatch && !isMatchFresh) {
                logger.info(`🔄 Semantic match found but too old (>24h). Re-analyzing as fresh story.`);
            }
            // Generate Fresh Analysis
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
            imageUrl: article.image, // Note: Normalized in newsService
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

        return isSemanticSkip ? 'SAVED_SEMANTIC' : 'SAVED_FRESH';

    } catch (error: any) {
        logger.error(`❌ Article Pipeline Error: ${error.message}`);
        return 'ERROR_PIPELINE';
    }
}

async function fetchAndAnalyzeNews() {
  logger.info('🔄 Job Started: Fetching news...');
  
  const stats = {
      totalFetched: 0, savedFresh: 0, savedSemantic: 0,
      duplicates: 0, junk: 0, errors: 0
  };

  try {
    // A. Fetch (Now Uses Rotation internally)
    const rawArticles = await newsService.fetchNews(); 
    if (!rawArticles || rawArticles.length === 0) {
        logger.warn('Job: No new articles found.');
        return stats; 
    }

    stats.totalFetched = rawArticles.length;
    logger.info(`📡 Fetched ${stats.totalFetched} articles. Starting Pipeline...`);

    // B. Process Items in Batches
    for (let i = 0; i < rawArticles.length; i += BATCH_SIZE) {
        const batch = rawArticles.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(article => processSingleArticle(article)));
        
        // Accumulate Stats
        batchResults.forEach(res => {
            if (res === 'SAVED_FRESH') stats.savedFresh++;
            else if (res === 'SAVED_SEMANTIC') stats.savedSemantic++;
            else if (res === 'DUPLICATE_URL') stats.duplicates++;
            else if (res === 'JUNK_CONTENT') stats.junk++;
            else stats.errors++;
        });

        // Rate Limit Breather
        if (i + BATCH_SIZE < rawArticles.length) await sleep(1000); 
    }

    logger.info('Job Complete: Summary', { stats });
    return stats;

  } catch (error: any) {
    logger.error(`❌ Job Critical Failure: ${error.message}`);
    throw error; 
  }
}

export default { run: fetchAndAnalyzeNews };
