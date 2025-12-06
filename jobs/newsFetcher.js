// jobs/newsFetcher.js
// This file handles the background task of fetching, analyzing, and saving news.
const newsService = require('../services/newsService');
const geminiService = require('../services/geminiService');
const clusteringService = require('../services/clusteringService');
const Article = require('../models/articleModel');

let isFetchRunning = false;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Main Worker Function ---
async function fetchAndAnalyzeNews() {
  console.log('🔄 Job Started: Fetching news...');
  try {
    const rawArticles = await newsService.fetchNews(); 
    if (rawArticles.length === 0) {
        console.log('Oscars: No new articles found.');
        return;
    }

    // --- PARALLEL PROCESSING (Batch Size 3) ---
    const BATCH_SIZE = 3; 
    for (let i = 0; i < rawArticles.length; i += BATCH_SIZE) {
        const batch = rawArticles.slice(i, i + BATCH_SIZE);
        console.log(`⚡ Processing batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(rawArticles.length/BATCH_SIZE)}`);
        
        await Promise.all(batch.map(article => processSingleArticle(article)));
        
        // Safety buffer for rate limits
        if (geminiService.isRateLimited) await sleep(5000); 
        else await sleep(1000); 
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
        
        // Quick existence check to save AI tokens
        const exists = await Article.findOne({ url: article.url }, { _id: 1 });
        if (exists) return;

        const textToEmbed = `${article.title}. ${article.description}`;
        
        // 1. Analyze with Gemini
        const analysis = await geminiService.analyzeArticle(article);
        if (analysis.isJunk) return;

        // 2. Generate Embedding (for Clustering)
        const embedding = await geminiService.createEmbedding(textToEmbed);

        // 3. Prepare Data Object
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
            analysisVersion: '3.0',
            embedding: embedding || []
        };
        
        // 4. Assign Cluster & Save
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
        geminiService.isRateLimited = false;

        // Run async (don't wait for it to finish)
        fetchAndAnalyzeNews().finally(() => { 
            isFetchRunning = false; 
        });
        return true; // Successfully started
    }
};
