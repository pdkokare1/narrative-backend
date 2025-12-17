// jobs/newsFetcher.ts
import newsService from '../services/newsService';
import pipelineService from '../services/pipelineService';
import logger from '../utils/logger'; 

const BATCH_SIZE = 5;

// --- HELPERS ---
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Safe wrapper to prevent one failure from crashing the whole batch
const processSafe = async (article: any) => {
    try {
        return await pipelineService.processSingleArticle(article);
    } catch (error: any) {
        logger.error(`⚠️ Pipeline Error for "${article.title}": ${error.message}`);
        return 'ERROR';
    }
};

// --- MAIN JOB ---
async function fetchAndAnalyzeNews() {
  logger.info('🔄 Job Started: Fetching news...');
  
  const stats = {
      totalFetched: 0, savedFresh: 0, savedInherited: 0,
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

    // B. Process Items in Batches
    for (let i = 0; i < rawArticles.length; i += BATCH_SIZE) {
        const batch = rawArticles.slice(i, i + BATCH_SIZE);
        
        // STABILITY FIX: Use processSafe so one crash doesn't kill the batch
        const batchResults = await Promise.all(
            batch.map(article => processSafe(article))
        );
        
        // Accumulate Stats
        batchResults.forEach(res => {
            if (res === 'SAVED_FRESH') stats.savedFresh++;
            else if (res === 'SAVED_INHERITED') stats.savedInherited++;
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
