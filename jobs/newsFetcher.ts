// jobs/newsFetcher.ts
import newsService from '../services/newsService';
import pipelineService from '../services/pipelineService';
import aiService from '../services/aiService'; 
import logger from '../utils/logger'; 
import { cleanText } from '../utils/helpers';
import Article from '../models/articleModel'; // Added for deduplication check

// --- 1. Fetch Logic (Producer) ---
// Fetches news AND pre-calculates AI embeddings in a batch (Massive Speedup)
async function fetchFeed() {
  logger.info('🔄 Job Started: Fetching news feed...');
  
  try {
    const rawArticles: any[] = await newsService.fetchNews(); 
    
    if (!rawArticles || rawArticles.length === 0) {
        logger.warn('Job: No new articles found from Service (All filtered or API empty).');
        return []; 
    }

    // --- COST OPTIMIZATION: Deduplication Check ---
    // Don't pay for embedding if the article already exists in DB
    const urls = rawArticles.map(a => a.url).filter(Boolean);
    const existingArticles = await Article.find({ url: { $in: urls } }).select('url').lean();
    const existingUrls = new Set(existingArticles.map((a: any) => a.url));

    const newArticles = rawArticles.filter(a => !existingUrls.has(a.url));

    if (newArticles.length === 0) {
        logger.info(`✨ Skipped ${rawArticles.length} articles (Already exist in DB).`);
        return [];
    }

    logger.info(`📡 Fetched ${rawArticles.length} articles. ${newArticles.length} are new. Running Batch AI Embeddings...`);

    // --- BATCH PROCESSING START ---
    // Prepare text for embeddings (Title + Description)
    const textsToEmbed = newArticles.map(a => 
        `${a.title}: ${cleanText(a.description || "")}`
    );

    // Get all embeddings in ONE API call (vs 50 separate calls)
    const embeddings = await aiService.createBatchEmbeddings(textsToEmbed);

    if (embeddings && embeddings.length === newArticles.length) {
        // Attach embeddings to the articles before dispatching
        for (let i = 0; i < newArticles.length; i++) {
            newArticles[i].embedding = embeddings[i];
        }
        logger.info(`⚡ Successfully attached ${embeddings.length} batch embeddings.`);
    } else {
        logger.warn('⚠️ Batch embedding failed or mismatched. Pipeline will fallback to individual fetching.');
    }
    // --- BATCH PROCESSING END ---

    // Return only new articles to be processed by the pipeline
    return newArticles;

  } catch (error: any) {
    logger.error(`❌ Fetch Job Critical Failure: ${error.message}`);
    throw error; 
  }
}

// --- 2. Process Logic (Consumer) ---
// This function handles ONE article at a time.
// If this fails, only this specific article is retried by the queue.
async function processArticleJob(article: any) {
    try {
        const result = await pipelineService.processSingleArticle(article);
        return result;
    } catch (error: any) {
        logger.error(`⚠️ Pipeline Error for "${article.title}": ${error.message}`);
        throw error; // Throwing error tells BullMQ to retry this specific job
    }
}

export default { fetchFeed, processArticleJob };
