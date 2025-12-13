// jobs/newsFetcher.ts
import newsService from '../services/newsService';
import gatekeeper from '../services/gatekeeperService'; 
import aiService from '../services/aiService'; 
import clusteringService from '../services/clusteringService';
import Article from '../models/articleModel';
import logger from '../utils/logger'; 
import { IArticle } from '../types';

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchAndAnalyzeNews() {
  logger.info('🔄 Job Started: Fetching news...');
  
  const stats = {
      totalFetched: 0, saved: 0, duplicates: 0,
      junk: 0, errors: 0, semanticSkips: 0 
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
            else if (res === 'SEMANTIC_SKIP') stats.semanticSkips++;
            else if (res === 'JUNK') stats.junk++;
            else if (res === 'ERROR') stats.errors++;
        });
        
        await sleep(2000); 
    }

    logger.info('Job Complete: News Processing Summary', { stats });
    return stats;

  } catch (error: any) {
    logger.error(`❌ Job Critical Failure: ${error.message}`);
    throw error; 
  }
}

async function processSingleArticle(article: any): Promise<string> {
    try {
        if (!article?.url || !article?.title) return 'ERROR';
        
        const exists = await Article.exists({ url: article.url });
        if (exists) return 'DUPLICATE';

        const gatekeeperResult = await gatekeeper.evaluateArticle(article);
        if (gatekeeperResult.isJunk) return 'JUNK';

        logger.info(`🔍 Analyzing [${gatekeeperResult.type}]: "${article.title.substring(0, 30)}..."`);

        const textToEmbed = `${article.title}. ${article.description}`;
        const embedding = await aiService.createEmbedding(textToEmbed);

        const existingMatch = await clusteringService.findSemanticDuplicate(embedding || undefined, 'Global');

        let analysis: Partial<IArticle>;
        let isSemanticSkip = false;

        if (existingMatch) {
            console.log(`💰 Saving Money! Inheriting analysis from: "${existingMatch.headline.substring(0,20)}..."`);
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
                clusterId: existingMatch.clusterId 
            };
        } else {
            analysis = await aiService.analyzeArticle(article, gatekeeperResult.recommendedModel);
        }

        const newArticleData: Partial<IArticle> = {
            headline: article.title,
            summary: analysis.summary!,
            source: article.source?.name,
            category: analysis.category!, 
            politicalLean: analysis.politicalLean!,
            url: article.url,
            imageUrl: article.urlToImage,
            publishedAt: article.publishedAt,
            analysisType: analysis.analysisType!,
            sentiment: analysis.sentiment!,
            
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
        logger.info(`✅ Saved ${isSemanticSkip ? '(Inherited)' : ''}: ${newArticleData.headline?.substring(0, 30)}...`);
        return isSemanticSkip ? 'SEMANTIC_SKIP' : 'SAVED';

    } catch (error: any) {
        logger.error(`❌ Article Error (${article?.title?.substring(0,15)}...): ${error.message}`);
        return 'ERROR';
    }
}

export = { run: fetchAndAnalyzeNews };
