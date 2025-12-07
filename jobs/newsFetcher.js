// jobs/newsFetcher.js
const newsService = require('../services/newsService');
const gatekeeper = require('../services/gatekeeperService'); // <--- NEW
const aiService = require('../services/aiService'); // <--- RENAMED
const clusteringService = require('../services/clusteringService');
const Article = require('../models/articleModel');

let isFetchRunning = false;

async function fetchAndAnalyzeNews() {
  console.log('🔄 Job Started: Fetching news...');
  try {
    const rawArticles = await newsService.fetchNews(); 
    if (rawArticles.length === 0) return;

    const BATCH_SIZE = 3; 
    for (let i = 0; i < rawArticles.length; i += BATCH_SIZE) {
        const batch = rawArticles.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(processSingleArticle));
        await new Promise(r => setTimeout(r, 2000)); // Rate limit buffer
    }
    console.log('✅ Job Complete.');
  } catch (error) {
    console.error('❌ Job Error:', error.message);
  }
}

async function processSingleArticle(article) {
    try {
        if (!article?.url || !article?.title) return;
        if (await Article.exists({ url: article.url })) return;

        // 1. GATEKEEPER: Check if we should process this
        const gatekeeperResult = await gatekeeper.evaluateArticle(article);
        
        if (gatekeeperResult.isJunk) {
            console.log(`🗑️ Junk Skipped: ${article.title}`);
            return;
        }

        console.log(`🔍 Analyzing [${gatekeeperResult.type}]: ${article.title}`);

        // 2. ANALYST: Use the model recommended by Gatekeeper (Flash vs Pro)
        const analysis = await aiService.analyzeArticle(article, gatekeeperResult.recommendedModel);

        // 3. LIBRARIAN: Vectorize
        const textToEmbed = `${article.title}. ${article.description}`;
        const embedding = await aiService.createEmbedding(textToEmbed);

        // 4. SAVE
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
            analysisType: gatekeeperResult.type === 'Hard News' ? 'Full' : 'SentimentOnly',
            sentiment: analysis.sentiment,
            // ... map other fields as before ...
            biasScore: analysis.biasScore,
            credibilityScore: analysis.credibilityScore,
            reliabilityScore: analysis.reliabilityScore,
            trustScore: analysis.trustScore,
            keyFindings: analysis.keyFindings,
            recommendations: analysis.recommendations,
            clusterTopic: analysis.clusterTopic,
            country: analysis.country,
            embedding: embedding || []
        };
        
        newArticleData.clusterId = await clusteringService.assignClusterId(newArticleData, embedding);
        await Article.create(newArticleData);

    } catch (error) {
        console.error(`❌ Article Error: ${error.message}`);
    }
}

module.exports = {
    isRunning: () => isFetchRunning,
    run: async () => {
        if (isFetchRunning) return false;
        isFetchRunning = true;
        fetchAndAnalyzeNews().finally(() => { isFetchRunning = false; });
        return true;
    }
};
