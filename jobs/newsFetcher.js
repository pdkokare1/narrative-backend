// jobs/newsFetcher.js
// Orchestrates the Fetch -> Filter -> Analyze -> Save pipeline.
// UPDATED: Semantic De-Duplication with Score Inheritance.

const newsService = require('../services/newsService');
const gatekeeper = require('../services/gatekeeperService'); 
const aiService = require('../services/aiService'); 
const clusteringService = require('../services/clusteringService');
const Article = require('../models/articleModel');
const logger = require('../utils/logger'); 

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Main Worker Function ---
async function fetchAndAnalyzeNews() {
  logger.info('🔄 Job Started: Fetching news...');
  
  const stats = {
      totalFetched: 0,
      saved: 0,
      duplicates: 0,
      junk: 0,
      errors: 0,
      semanticSkips: 0 
  };

  try {
    const rawArticles = await newsService.fetchNews(); 
    if (!rawArticles || rawArticles.length === 0) {
        logger.warn('Job: No new articles found.');
        return stats; 
    }

    stats.totalFetched = rawArticles.length;
    logger.info(`📡 Fetched ${stats.totalFetched} articles. Starting processing...`);

    const BATCH_SIZE = 3; 
    for (let i = 0; i < rawArticles.length; i += BATCH_SIZE) {
        const batch = rawArticles.slice(i, i + BATCH_SIZE);
        logger.debug(`⚡ Processing batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(rawArticles.length/BATCH_SIZE)}`);
        
        const results = await Promise.all(batch.map(article => processSingleArticle(article)));
        
        results.forEach(res => {
            if (res === 'SAVED') stats.saved++;
            else if (res === 'DUPLICATE') stats.duplicates++;
            else if (res === 'SEMANTIC_SKIP') stats.semanticSkips++; // Track savings
            else if (res === 'JUNK') stats.junk++;
            else if (res === 'ERROR') stats.errors++;
        });
        
        await sleep(2000); 
    }

    logger.info('Job Complete: News Processing Summary', { stats });
    return stats;

  } catch (error) {
    logger.error(`❌ Job Critical Failure: ${error.message}`);
    throw error; 
  }
}

// --- Single Article Processor ---
async function processSingleArticle(article) {
    try {
        if (!article?.url || !article?.title) return 'ERROR';
        
        // 1. URL DUPLICATE CHECK
        const exists = await Article.exists({ url: article.url });
        if (exists) return 'DUPLICATE';

        // 2. GATEKEEPER
        const gatekeeperResult = await gatekeeper.evaluateArticle(article);
        if (gatekeeperResult.isJunk) return 'JUNK';

        logger.info(`🔍 Analyzing [${gatekeeperResult.type}]: "${article.title.substring(0, 30)}..."`);

        // --- 3. SEMANTIC DE-DUPLICATION (Smart Save) ---
        // Generate embedding first (Cheap)
        const textToEmbed = `${article.title}. ${article.description}`;
        const embedding = await aiService.createEmbedding(textToEmbed);

        // Check for Syndicated Content (92%+ Similarity)
        const existingMatch = await clusteringService.findSemanticDuplicate(embedding, 'Global');

        let analysis;
        let isSemanticSkip = false;

        if (existingMatch) {
            console.log(`💰 Saving Money! Inheriting analysis from: "${existingMatch.headline.substring(0,20)}..."`);
            isSemanticSkip = true;
            
            // --- INHERITANCE LOGIC ---
            // We blindly trust that if the text is 92% identical, the bias/sentiment is identical.
            analysis = {
                summary: existingMatch.summary, 
                category: existingMatch.category,
                
                // Copy Scores to preserve "Compare Coverage" data
                politicalLean: existingMatch.politicalLean, 
                biasScore: existingMatch.biasScore,
                trustScore: existingMatch.trustScore,
                sentiment: existingMatch.sentiment,
                
                // Keep as 'Full' so it renders fully in UI
                analysisType: existingMatch.analysisType || 'Full', 
                
                // Force into same cluster
                clusterTopic: existingMatch.clusterTopic,
                country: 'Global',
                clusterId: existingMatch.clusterId 
            };
        } else {
            // Unique story? Pay for full analysis.
            analysis = await aiService.analyzeArticle(article, gatekeeperResult.recommendedModel);
        }

        // 4. DATA CONSTRUCTION
        const newArticleData = {
            headline: article.title,
            summary: analysis.summary,
            source: article.source?.name,
            category: analysis.category, 
            politicalLean: analysis.politicalLean,
            url: article.url,
            imageUrl: article.urlToImage,
            publishedAt: article.publishedAt,
            analysisType: analysis.analysisType,
            sentiment: analysis.sentiment,
            
            // Scores (Inherited or New)
            biasScore: analysis.biasScore || 0,
            credibilityScore: analysis.credibilityScore || 0,
            reliabilityScore: analysis.reliabilityScore || 0,
            trustScore: analysis.trustScore || 0,
            
            // Cluster Data
            clusterTopic: analysis.clusterTopic,
            country: analysis.country,
            primaryNoun: analysis.primaryNoun,
            secondaryNoun: analysis.secondaryNoun,
            clusterId: analysis.clusterId, // Pre-filled if inherited
            
            analysisVersion: isSemanticSkip ? '3.5-Inherited' : '3.5-Full',
            embedding: embedding || []
        };
        
        // 5. CLUSTERING (Only needed if we didn't inherit an ID)
        if (!newArticleData.clusterId) {
            newArticleData.clusterId = await clusteringService.assignClusterId(newArticleData, embedding);
        }
        
        await Article.create(newArticleData);
        logger.info(`✅ Saved ${isSemanticSkip ? '(Inherited)' : ''}: ${newArticleData.headline.substring(0, 30)}...`);
        return isSemanticSkip ? 'SEMANTIC_SKIP' : 'SAVED';

    } catch (error) {
        logger.error(`❌ Article Error (${article?.title?.substring(0,15)}...): ${error.message}`);
        return 'ERROR';
    }
}

module.exports = {
    run: fetchAndAnalyzeNews
};
