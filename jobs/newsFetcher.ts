// jobs/newsFetcher.ts
import newsService from '../services/newsService';
import gatekeeper from '../services/gatekeeperService'; 
import aiService from '../services/aiService'; 
import clusteringService from '../services/clusteringService';
import Article from '../models/articleModel';
import logger from '../utils/logger'; 
import { IArticle } from '../types';

// --- PIPELINE STEPS ---

// Step 1: Filter Duplicates (URL Check Only)
async function isDuplicate(url: string): Promise<boolean> {
    if (!url) return true;
    return await Article.exists({ url }) !== null;
}

// Step 2: Semantic Check (Save $$$ by finding similar articles)
async function findExistingAnalysis(embedding: number[] | undefined, country: string = 'Global') {
    if (!embedding) return null;
    return await clusteringService.findSemanticDuplicate(embedding, country);
}

// Step 3: Full AI Analysis
async function performDeepAnalysis(article: any, model: string) {
    return await aiService.analyzeArticle(article, model);
}

// --- MAIN PROCESSOR ---

async function processSingleArticle(article: any): Promise<string> {
    try {
        if (!article?.url || !article?.title) return 'ERROR_INVALID';
        
        // 1. Quick Dedupe (Exact URL match only)
        if (await isDuplicate(article.url)) return 'DUPLICATE_URL';

        // 2. Gatekeeper (Junk Filter - now with Keywords from DB)
        const gatekeeperResult = await gatekeeper.evaluateArticle(article);
        if (gatekeeperResult.isJunk) return 'JUNK_CONTENT';

        logger.info(`🔍 Processing [${gatekeeperResult.type}]: "${article.title.substring(0, 30)}..."`);

        // 3. Create Embedding (Vector)
        const textToEmbed = `${article.title}. ${article.description}`;
        const embedding = await aiService.createEmbedding(textToEmbed);

        // 4. Semantic Search (Cost Saver)
        const existingMatch = await findExistingAnalysis(embedding || undefined, 'Global');
        
        let analysis: Partial<IArticle>;
        let isSemanticSkip = false;

        if (existingMatch) {
            logger.info(`💰 Cost Saver! Inheriting analysis from: "${existingMatch.headline.substring(0,20)}..."`);
            isSemanticSkip = true;
            
            // Clone the expensive data
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
            // New Analysis required
            analysis = await performDeepAnalysis(article, gatekeeperResult.recommendedModel);
        }

        // 5. Construct & Save
        const newArticleData: Partial<IArticle> = {
            headline: article.title,
            summary: analysis.summary || "Summary Unavailable",
            source: article.source?.name,
            category: analysis.category || "General", 
            politicalLean: analysis.politicalLean || "Not Applicable",
            url: article.url,
            imageUrl: article.urlToImage,
            publishedAt: article.publishedAt,
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
        
        // Final Cluster Check (if not inherited)
        if (!newArticleData.clusterId) {
            newArticleData.clusterId = await clusteringService.assignClusterId(newArticleData, embedding || undefined);
        }
        
        await Article.create(newArticleData);
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
    // A. Fetch
    const rawArticles = await newsService.fetchNews(); 
    if (!rawArticles || rawArticles.length === 0) {
        logger.warn('Job: No new articles found.');
        return stats; 
    }

    stats.totalFetched = rawArticles.length;
    logger.info(`📡 Fetched ${stats.totalFetched} articles. Starting Pipeline...`);

    // B. Process ALL items
    // Queue Rate Limiter will handle the speed, so we can just loop
    const results = await Promise.all(rawArticles.map(article => processSingleArticle(article)));
        
    results.forEach(res => {
        if (res === 'SAVED_FRESH') stats.savedFresh++;
        else if (res === 'SAVED_SEMANTIC') stats.savedSemantic++;
        else if (res === 'DUPLICATE_URL') stats.duplicates++;
        else if (res === 'JUNK_CONTENT') stats.junk++;
        else stats.errors++;
    });

    logger.info('Job Complete: Summary', { stats });
    return stats;

  } catch (error: any) {
    logger.error(`❌ Job Critical Failure: ${error.message}`);
    throw error; 
  }
}

export default { run: fetchAndAnalyzeNews };
