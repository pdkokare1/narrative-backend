// articleProcessor.js (FINAL CORRECTED v2.13)
const mongoose = require('mongoose');
const geminiService = require('./services/geminiService');

// --- Import the Article Model ---
// This relies on articleModel.js being defined first.
let Article;
try {
    Article = require('./articleModel'); // Should succeed now
} catch (error) {
    // This is a last resort error, but keeps the application from crashing immediately.
    console.error('❌ Article model dependency failed to load:', error.message);
}


// --- Sleep Function ---
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Finds the highest existing clusterId in the database.
 * @returns {number} The maximum cluster ID found, or 0 if none exist.
 */
async function getMaxClusterId() {
    try {
        const maxIdDoc = await Article.findOne({}).sort({ clusterId: -1 }).select({ clusterId: 1 }).lean();
        return maxIdDoc?.clusterId || 0;
    } catch (error) {
        console.error('❌ Error fetching max cluster ID:', error.message);
        return 0;
    }
}


/**
 * Core function to fetch an unanalyzed article, process it with Gemini, and save the result.
 * This function enforces the AI rate limit delay.
 * @returns {Promise<boolean>} True if an article was processed, false otherwise.
 */
async function processNextArticle() {
    // Check if Mongoose connection is still establishing before running a query
    if (mongoose.connection.readyState !== 1) { 
        console.warn('🧠 Worker: Skipping cycle. MongoDB not connected (State: ' + mongoose.connection.readyState + ')');
        return false;
    }

    if (!Article) {
        console.error("Worker aborted: Article model is undefined.");
        return false;
    }

    // 1. Find the oldest, unanalyzed article
    const rawArticle = await Article.findOne({
        // Article has been ingested (has a URL) but is marked 'Pending' or missing topic
        url: { $exists: true },
        $or: [
            { analysisType: 'Pending' }, // Explicitly check for Pending
            { clusterTopic: { $exists: false } }, 
            { clusterTopic: null },
            { analysisVersion: { $ne: Article.schema.path('analysisVersion').defaultValue } }
        ]
    })
    .sort({ publishedAt: 1 })
    .lean();

    if (!rawArticle) {
        return false;
    }
    
    // Convert to plain object for analysis input
    const articleForAnalysis = {
        title: rawArticle.headline,
        description: rawArticle.summary,
        url: rawArticle.url,
        urlToImage: rawArticle.imageUrl,
        publishedAt: rawArticle.publishedAt,
        source: { name: rawArticle.source }
    };

    try {
        // 2. Analyze with Gemini
        console.log(`🤖 Analyzing: ${rawArticle.headline.substring(0, 60)}...`);
        const analysis = await geminiService.analyzeArticle(articleForAnalysis);

        // 2.5. Check for Junk Articles
        if (analysis.isJunk) {
            console.log(`🚮 Deleting junk/ad: ${rawArticle.headline.substring(0, 50)}...`);
            await Article.deleteOne({ _id: rawArticle._id });
            return true;
        }

        // 3. Prepare Update Data & Clustering
        const updateData = {
          $set: {
              summary: analysis.summary || rawArticle.summary || 'Summary unavailable',
              category: analysis.category || rawArticle.category || 'General',
              politicalLean: analysis.politicalLean || (analysis.analysisType === 'SentimentOnly' ? 'Not Applicable' : 'Center'),
              analysisType: analysis.analysisType || 'Full',
              sentiment: analysis.sentiment || 'Neutral',
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
              clusterTopic: analysis.clusterTopic, // CRITICAL: This marks it as processed
              keyFindings: analysis.keyFindings || [],
              recommendations: analysis.recommendations || [],
              analysisVersion: Article.schema.path('analysisVersion').defaultValue
          }
        };

        // Clustering Logic
        let clusterIdToUse = null;
        if (updateData.$set.clusterTopic && updateData.$set.analysisType === 'Full') {
            const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
            
            const existingCluster = await Article.findOne({
                clusterTopic: updateData.$set.clusterTopic,
                publishedAt: { $gte: threeDaysAgo },
                _id: { $ne: rawArticle._id }
            }, { clusterId: 1 }).sort({ publishedAt: -1 }).lean();

            if (existingCluster && existingCluster.clusterId) {
                clusterIdToUse = existingCluster.clusterId;
            } else {
                const maxClusterId = await getMaxClusterId();
                clusterIdToUse = maxClusterId + 1;
            }
            updateData.$set.clusterId = clusterIdToUse;
        }

        // 4. Save Update to DB
        const result = await Article.updateOne({ _id: rawArticle._id }, updateData);
        if (result.modifiedCount > 0) {
            console.log(`✅ Updated [${rawArticle._id}]: ${rawArticle.headline.substring(0, 50)}... (TS: ${updateData.$set.trustScore})`);
        } else {
             console.warn(`⚠️ Failed to update article [${rawArticle._id}] after analysis.`);
        }

        // 5. Rate Limit Delay
        await sleep(31000); // Wait 31 seconds for AI rate limit

        return true;

    } catch (error) {
        console.error(`❌ Worker Error processing article "${rawArticle?.headline?.substring(0,60)}...": ${error.message}`);
        // Log the error but proceed to the next cycle (still count as true to trigger sleep)
        // If the error was due to rate-limiting, the geminiService handles backoff/retries.
        return true; 
    }
}


module.exports = {
    processNextArticle,
    getMaxClusterId,
};
