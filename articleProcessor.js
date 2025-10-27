// articleProcessor.js (CORRECTED v2.12 - Ensures Mongoose Model is Loaded)
const mongoose = require('mongoose');

// --- CRITICAL FIX: Ensure the Article model is defined ---
// We require server.js to run its model definition, but only if it hasn't run already.
// Since server.js exports nothing, we just require it to execute its Mongoose model logic.
try {
    // Check if the Article model is already defined by Mongoose
    Article = mongoose.model('Article');
} catch (error) {
    // If not, explicitly load/execute the file that defines it (server.js)
    require('./server'); 
    Article = mongoose.model('Article'); // Now it should be available
    console.log("✅ Article model successfully registered via worker fix.");
}

// --- Sleep Function ---
function sleep(ms) {
  // console.log(`😴 Sleeping for ${ms / 1000} seconds...`); // Uncomment for debugging delay
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
    if (!Article) {
        // This check should ideally never be reached now, but is a safe fallback
        console.error("Worker aborted: Article model is undefined.");
        return false;
    }

    // 1. Find the oldest, unanalyzed article (no clusterTopic yet means it's raw)
    const rawArticle = await Article.findOne({
        // Filter: Article has been fetched (has a URL) but analysis data is missing (or incomplete/old version)
        url: { $exists: true }, // Must have a URL
        $or: [
            { clusterTopic: { $exists: false } }, // Doesn't have clusterTopic field (meaning it hasn't been processed by the AI)
            { clusterTopic: null }, // Explicitly check for null
            { analysisVersion: { $ne: Article.schema.path('analysisVersion').defaultValue } } // Or needs reprocessing
        ]
    })
    .sort({ publishedAt: 1 }) // Process oldest first
    .lean(); // Use lean for speed

    if (!rawArticle) {
        // console.log("🏁 No raw articles awaiting analysis.");
        return false;
    }
    
    // Convert Mongoose document back to a plain object for passing to analysis
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
        return true; 
    }
}


module.exports = {
    processNextArticle,
    getMaxClusterId,
};
