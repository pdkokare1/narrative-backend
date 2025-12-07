// jobs/newsFetcher.js
// Orchestrates the Fetch -> Filter -> Analyze -> Save pipeline.
const newsService = require('../services/newsService');
const gatekeeper = require('../services/gatekeeperService'); // <--- NEW
const aiService = require('../services/aiService'); // <--- REPLACES geminiService
const clusteringService = require('../services/clusteringService');
const Article = require('../models/articleModel');

let isFetchRunning = false;

// Helper for delays
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Main Worker Function ---
async function fetchAndAnalyzeNews() {
  console.log('🔄 Job Started: Fetching news...');
  try {
    const rawArticles = await newsService.fetchNews(); 
    if (!rawArticles || rawArticles.length === 0) {
        console.log('Oscars: No new articles found.');
        return;
    }

    console.log(`📡 Fetched ${rawArticles.length} articles. Starting processing...`);

    // --- PARALLEL PROCESSING (Batch Size 3) ---
    // We process 3 articles at a time to respect rate limits while remaining fast
    const BATCH_SIZE = 3; 
    for (let i = 0; i < rawArticles.length; i += BATCH_SIZE) {
        const batch = rawArticles.slice(i, i + BATCH_SIZE);
        console.log(`⚡ Processing batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(rawArticles.length/BATCH_SIZE)}`);
        
        await Promise.all(batch.map(article => processSingleArticle(article)));
        
        // Safety buffer: 2 seconds between batches
        await sleep(2000); 
    }
    console.log('✅ Job Complete: Batch processing finished.');

  } catch (error) {
    console.error('❌ Job Error:', error.message);
  }
}

// --- Single Article Processor ---
async function processSingleArticle(article) {
    try {
        if (!article?.url || !article?.title) return;
        
        // 1. DUPLICATE CHECK
        // Check if we already have this specific URL
        const exists = await Article.exists({ url: article.url });
        if (exists) return;

        // 2. GATEKEEPER (The Filter)
        // Uses Gemini 2.5 Flash (Cheap) to decide if this is worth analyzing
        const gatekeeperResult = await gatekeeper.evaluateArticle(article);
        
        if (gatekeeperResult.isJunk) {
            console.log(`🗑️ Junk Skipped: "${article.title.substring(0, 30)}..."`);
            return;
        }

        console.log(`🔍 Analyzing [${gatekeeperResult.type} -> ${gatekeeperResult.recommendedModel}]: "${article.title.substring(0, 30)}..."`);

        // 3. THE ANALYST (The Brain)
        // Uses either Flash (Soft News) or Pro (Hard News) based on Gatekeeper's advice
        const analysis = await aiService.analyzeArticle(article, gatekeeperResult.recommendedModel);

        // 4. THE LIBRARIAN (Vectorizing)
        // Generate embedding for clustering
        const textToEmbed = `${article.title}. ${article.description}`;
        const embedding = await aiService.createEmbedding(textToEmbed);

        // 5. DATA CONSTRUCTION
        const newArticleData = {
            headline: article.title,
            summary: analysis.summary,
            source: article.source?.name,
            
            // Use the cleaner category from Gatekeeper/AI
            category: gatekeeperResult.category || analysis.category, 
            politicalLean: analysis.politicalLean,
            
            url: article.url,
            imageUrl: article.urlToImage,
            publishedAt: article.publishedAt,
            
            // Set type based on Gatekeeper: Hard News = Full, Soft News = SentimentOnly
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
            
            analysisVersion: '3.1-Hybrid', // Mark version for debugging
            embedding: embedding || []
        };
        
        // 6. CLUSTERING & SAVE
        newArticleData.clusterId = await clusteringService.assignClusterId(newArticleData, embedding);
        
        await Article.create(newArticleData);
        console.log(`✅ Saved: ${newArticleData.headline.substring(0, 30)}...`);

    } catch (error) {
        console.error(`❌ Article Error: ${error.message}`);
    }
}

// --- Public Interface ---
module.exports = {
    // Check if job is currently running
    isRunning: () => isFetchRunning,

    // Trigger the job safely
    run: async () => {
        if (isFetchRunning) {
            return false; // Already running
        }
        isFetchRunning = true;

        // Run async (don't wait for it to finish)
        fetchAndAnalyzeNews().finally(() => { 
            isFetchRunning = false; 
        });
        return true; // Successfully started
    }
};
