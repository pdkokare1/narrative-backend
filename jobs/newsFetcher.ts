// jobs/newsFetcher.ts
import newsService from '../services/newsService';
import pipelineService from '../services/pipelineService';
import aiService from '../services/aiService'; // <--- NEW IMPORT
import logger from '../utils/logger'; 
import { cleanText } from '../utils/helpers';

// --- 1. Fetch Logic (Producer) ---
// Fetches news AND pre-calculates AI embeddings in a batch (Massive Speedup)
async function fetchFeed() {
  logger.info('🔄 Job Started: Fetching news feed...');
  
  try {
    const rawArticles: any[] = await newsService.fetchNews(); 
    
    if (!rawArticles || rawArticles.length === 0) {
        logger.warn('Job: No new articles found.');
        return []; 
    }

    logger.info(`📡 Fetched ${rawArticles.length} articles. Running Batch AI Embeddings...`);

    // --- BATCH PROCESSING START ---
    // Prepare text for embeddings (Title + Description)
    const textsToEmbed = rawArticles.map(a => 
        `${a.title}: ${cleanText(a.description || "")}`
    );

    // Get all embeddings in ONE API call (vs 50 separate calls)
    const embeddings = await aiService.createBatchEmbeddings(textsToEmbed);

    if (embeddings && embeddings.length === rawArticles.length) {
        // Attach embeddings to the articles before dispatching
        for (let i = 0; i < rawArticles.length; i++) {
            rawArticles[i].embedding = embeddings[i];
        }
        logger.info(`⚡ Successfully attached ${embeddings.length} batch embeddings.`);
    } else {
        logger.warn('⚠️ Batch embedding failed or mismatched. Pipeline will fallback to individual fetching.');
    }
    // --- BATCH PROCESSING END ---

    return rawArticles;

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
