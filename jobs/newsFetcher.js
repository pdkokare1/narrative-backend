// jobs/newsFetcher.js
// Orchestrates the Fetch -> Filter -> Analyze -> Save pipeline.
const newsService = require('../services/newsService');
const gatekeeper = require('../services/gatekeeperService'); 
const aiService = require('../services/aiService'); 
const clusteringService = require('../services/clusteringService');
const Article = require('../models/articleModel');
const logger = require('../utils/logger'); // <--- NEW: Import Logger

let isFetchRunning = false;

// Helper for delays
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Main Worker Function ---
async function fetchAndAnalyzeNews() {
  logger.info('🔄 Job Started: Fetching news...');
  
  // Job Stats
  const stats = {
      totalFetched: 0,
      saved: 0,
      duplicates: 0,
      junk: 0,
      errors: 0
  };

  try {
    const rawArticles = await newsService.fetchNews(); 
    if (!rawArticles || rawArticles.length === 0) {
        logger.warn('Job: No new articles found.');
        return;
    }

    stats.totalFetched = rawArticles.length;
    logger.info(`📡 Fetched ${stats.totalFetched} articles. Starting processing...`);

    // --- PARALLEL PROCESSING (Batch Size 3) ---
    const BATCH_SIZE = 3; 
    for (let i = 0; i < rawArticles.length; i += BATCH_SIZE) {
        const batch = rawArticles.slice(i, i + BATCH_SIZE);
        logger.debug(`⚡ Processing batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(rawArticles.length/BATCH_SIZE)}`);
        
        // Process batch and update stats
        const results = await Promise.all(batch.map(article => processSingleArticle(article)));
        
        // Tally results
        results.forEach(res => {
            if (res === 'SAVED') stats.saved++;
            else if (res === 'DUPLICATE') stats.duplicates++;
            else if (res === 'JUNK') stats.junk++;
            else if (res === 'ERROR') stats.errors++;
        });
        
        // Safety buffer: 2 seconds between batches
        await sleep(2000); 
    }

    // --- FINAL REPORT (Structured Log) ---
    logger.info('Job Complete: News Processing Summary', { stats });

  } catch (error) {
    logger.error(`❌ Job Critical Failure: ${error.message}`);
  }
}

// --- Single Article Processor ---
async function processSingleArticle(article) {
    try {
        if (!article?.url || !article?.title) return 'ERROR';
        
        // 1. DUPLICATE CHECK
        const exists = await Article.exists({ url: article.url });
        if (exists) return 'DUPLICATE';

        // 2. GATEKEEPER (The Filter)
        const gatekeeperResult = await gatekeeper.evaluateArticle(article);
        
        if (gatekeeperResult.isJunk) {
            return 'JUNK';
        }

        logger.info(`🔍 Analyzing [${gatekeeperResult.type}]: "${article.title.substring(0, 30)}..."`);

        // 3. THE ANALYST (The Brain)
        const analysis = await aiService.analyzeArticle(article, gatekeeperResult.recommendedModel);

        // 4. THE LIBRARIAN (Vectorizing)
        const textToEmbed = `${article.title}. ${article.description}`;
        const embedding = await aiService.createEmbedding(textToEmbed);

        // 5. DATA CONSTRUCTION
        const newArticleData = {
            headline: article.title,
            summary: analysis.summary,
            source: article.source?.name,
            category: gatekeeperResult.category || analysis.category, 
            politicalLean: analysis.politicalLean,
            url: article.url,
            imageUrl: article.urlToImage,
            publishedAt: article.publishedAt,
            analysisType: gatekeeperResult.type === 'Hard News' ? 'Full' : 'SentimentOnly',
            sentiment: analysis.sentiment,
            biasScore: analysis.biasScore, 
            biasLabel: analysis.biasLabel,
            biasComponents: analysis.biasComponents || {},
            credibilityScore: analysis.credibilityScore, 
            credibilityGrade: analysis.credibilityGrade,
            credibilityComponents: analysis.credibilityComponents || {},
            reliabilityScore: analysis.reliabilityScore, 
            reliabilityGrade: analysis.reliabilityGrade,
            reliabilityComponents: analysis.reliabilityComponents || {},
            trustScore: analysis.trustScore, 
            trustLevel: analysis.trustLevel,
            coverageLeft: analysis.coverageLeft || 0,
            coverageCenter: analysis.coverageCenter || 0,
            coverageRight: analysis.coverageRight || 0,
            clusterTopic: analysis.clusterTopic,
            country: analysis.country,
            primaryNoun: analysis.primaryNoun,
            secondaryNoun: analysis.secondaryNoun,
            keyFindings: analysis.keyFindings || [],
            recommendations: analysis.recommendations || [],
            analysisVersion: '3.2-Robust', 
            embedding: embedding || []
        };
        
        // 6. CLUSTERING & SAVE
        newArticleData.clusterId = await clusteringService.assignClusterId(newArticleData, embedding);
        
        await Article.create(newArticleData);
        logger.info(`✅ Saved: ${newArticleData.headline.substring(0, 30)}...`);
        return 'SAVED';

    } catch (error) {
        logger.error(`❌ Article Error (${article?.title?.substring(0,15)}...): ${error.message}`);
        return 'ERROR';
    }
}

// --- Public Interface ---
module.exports = {
    // Check if job is currently running
    isRunning: () => isFetchRunning,

    // Trigger the job safely
    run: async () => {
        if (isFetchRunning) {
            logger.warn("⚠️ Job skipped: Previous job still running.");
            return false; 
        }
        isFetchRunning = true;

        // Run async (don't wait for it to finish)
        fetchAndAnalyzeNews().finally(() => { 
            isFetchRunning = false; 
        });
        return true; // Successfully started
    }
};
