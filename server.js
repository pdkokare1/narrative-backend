// server.js (FINAL v2.6 - Calculates Scores from Components)
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cron = require('node-cron');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// --- Services ---
const geminiService = require('./services/geminiService');
const newsService = require('./services/newsService');

const app = express();

// --- Middleware ---
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// --- Rate Limiter ---
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 100,
  message: { error: 'Too many requests, try again later.' },
  standardHeaders: true, legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// --- Database Connection ---
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err.message));

mongoose.connection.on('error', err => console.error('❌ MongoDB runtime error:', err.message));
mongoose.connection.on('disconnected', () => console.warn('⚠️ MongoDB disconnected.'));

// --- Mongoose Schema ---
const articleSchema = new mongoose.Schema({
  headline: { type: String, required: true, trim: true },
  summary: { type: String, required: true, trim: true },
  source: { type: String, required: true, trim: true },
  category: { type: String, required: true, trim: true },
  politicalLean: { type: String, required: true, trim: true },
  url: { type: String, required: true, unique: true, trim: true, index: true },
  imageUrl: { type: String, trim: true },
  publishedAt: { type: Date, default: Date.now, index: true },
  analysisType: { type: String, default: 'Full', enum: ['Full', 'SentimentOnly'] },
  sentiment: { type: String, default: 'Neutral', enum: ['Positive', 'Negative', 'Neutral'] },
  // FINAL Calculated Scores
  biasScore: { type: Number, default: 0, min: 0, max: 100 },
  biasLabel: String, // You might need a function to determine this from score
  credibilityScore: { type: Number, default: 0, min: 0, max: 100 }, // This will be UCS
  credibilityGrade: String, // Determined by matrix
  reliabilityScore: { type: Number, default: 0, min: 0, max: 100 }, // This will be URS
  reliabilityGrade: String, // Determined by matrix (though matrix uses URS directly?)
  trustScore: { type: Number, default: 0, min: 0, max: 100 }, // This will be OTS
  trustLevel: String, // Determined by matrix grade
  // Store the AI's estimated components
  biasComponents: mongoose.Schema.Types.Mixed, // Stores estimated E-UBDF components
  credibilityComponents: mongoose.Schema.Types.Mixed, // Stores estimated UCS components
  reliabilityComponents: mongoose.Schema.Types.Mixed, // Stores estimated URS components
  // Other fields
  coverageLeft: { type: Number, default: 0 },
  coverageCenter: { type: Number, default: 0 },
  coverageRight: { type: Number, default: 0 },
  clusterId: { type: Number, index: true },
  keyFindings: [String],
  recommendations: [String],
  analysisVersion: { type: String, default: '2.6-formula' } // Version bump
}, {
  timestamps: true,
  autoIndex: process.env.NODE_ENV !== 'production',
});

// Indexes (ensure only necessary ones)
articleSchema.index({ category: 1, publishedAt: -1 });
articleSchema.index({ politicalLean: 1, publishedAt: -1 });
articleSchema.index({ clusterId: 1, trustScore: -1 }); // Keep if cluster view sorts by trust
articleSchema.index({ trustScore: -1, publishedAt: -1 });
articleSchema.index({ biasScore: 1, publishedAt: -1 });
articleSchema.index({ createdAt: 1 }); // For cleanup

const Article = mongoose.model('Article', articleSchema);


// --- FORMULA CALCULATION HELPERS ---

// Helper to safely get score and default to 0 if invalid
const getScore = (obj, key, isSentimentOnly) => {
    if (isSentimentOnly) return 0;
    const score = obj?.[key];
    // Ensure it's a number between 0-100, default to 50 if missing/invalid? Or 0? Let's use 0.
    return (typeof score === 'number' && score >= 0 && score <= 100) ? score : 0;
};

// Calculate Universal Credibility Score (UCS) [cite: 7, 9, 10, 11, 12, 13, 14]
function calculateUCS(components, isSentimentOnly) {
    if (isSentimentOnly || !components) return 0;
    const cred = components.credibility || {}; // Ensure sub-object exists

    // Calculate weighted average for each main UCS component first
    const SC = (0.30 * getScore(cred, 'SC_Historical_Accuracy', false) +
                0.25 * getScore(cred, 'SC_Org_Reputation', false) +
                0.20 * getScore(cred, 'SC_Industry_Recognition', false) +
                0.15 * getScore(cred, 'SC_Corrections_Policy_Quality', false) +
                0.10 * getScore(cred, 'SC_Editorial_Standards', false));

    const VC = (0.35 * getScore(cred, 'VC_Source_Citation_Quality', false) +
                0.25 * getScore(cred, 'VC_Fact_Verification_Process', false) +
                0.20 * getScore(cred, 'VC_Claims_Substantiation', false) +
                0.20 * getScore(cred, 'VC_External_Validation', false));

    const PC = (0.30 * getScore(cred, 'PC_Objectivity_Score', false) +
                0.25 * getScore(cred, 'PC_Source_Transparency', false) +
                0.25 * getScore(cred, 'PC_Editorial_Independence', false) +
                0.20 * getScore(cred, 'PC_Professional_Standards_Adherence', false));

    const EC = (0.35 * getScore(cred, 'EC_Data_Quality', false) +
                0.30 * getScore(cred, 'EC_Evidence_Strength', false) +
                0.20 * getScore(cred, 'EC_Expert_Validation', false) +
                0.15 * getScore(cred, 'EC_Methodological_Rigor', false)); // Weight from [cite: 89] assumed

    const TC = (0.35 * getScore(cred, 'TC_Source_Disclosure', false) +
                0.25 * getScore(cred, 'TC_Ownership_Transparency', false) +
                0.20 * getScore(cred, 'TC_Corrections_Transparency', false) +
                0.20 * getScore(cred, 'TC_Financial_Transparency', false)); // Typo in PDF (TS vs TC)

    const AC = (0.40 * getScore(cred, 'AC_Reader_Trust_Rating', false) +
                0.30 * getScore(cred, 'AC_Community_Fact_Check_Score', false) +
                0.30 * getScore(cred, 'AC_Cross_Platform_Reputation', false)); // Typo in PDF (ATS vs AC)

    // Final UCS calculation using weights from [cite: 7]
    const ucsScore = (0.25 * SC + 0.20 * VC + 0.20 * PC + 0.15 * EC + 0.12 * TC + 0.08 * AC); // Note PDF typos in beta/zeta weights
    return Math.round(Math.max(0, Math.min(100, ucsScore))); // Clamp between 0-100
}

// Calculate Universal Reliability Score (URS) [cite: 129, 131]
function calculateURS(components, isSentimentOnly) {
    if (isSentimentOnly || !components) return 0;
    const rel = components.reliability || {}; // Ensure sub-object exists

    // Calculate weighted average for each main URS component
    const CM = (0.35 * getScore(rel, 'CM_Accuracy_Consistency', false) +
                0.30 * getScore(rel, 'CM_Quality_Variance', false) + // Note: Formula in PDF seems inverted (1-StdDev...) lower score = higher variance. Assuming score estimates variance directly.
                0.20 * getScore(rel, 'CM_Bias_Stability', false) + // Note: Formula 1 - |diff| means lower score = less stable. Assuming score estimates stability.
                0.15 * getScore(rel, 'CM_Source_Pattern_Consistency', false));

    const TM = (0.40 * getScore(rel, 'TS_Historical_Track_Record', false) + // Renamed from TS in PDF section to TM for main formula
                0.30 * getScore(rel, 'TS_Publication_Longevity', false) +
                0.30 * getScore(rel, 'TS_Performance_Trend', false));

    const QC = (0.30 * getScore(rel, 'QC_Editorial_Review_Process', false) +
                0.25 * getScore(rel, 'QC_Fact_Checking_Infrastructure', false) +
                0.25 * getScore(rel, 'QC_Error_Detection_Rate', false) + // Higher rate should be better score
                0.20 * getScore(rel, 'QC_Correction_Response_Time', false)); // Faster time = higher score (assuming Gemini estimates this way)

    const PS = (0.30 * getScore(rel, 'PS_Journalistic_Code_Adherence', false) +
                0.25 * getScore(rel, 'PS_Industry_Certification', false) +
                0.25 * getScore(rel, 'PS_Professional_Membership', false) +
                0.20 * getScore(rel, 'PS_Ethics_Compliance', false));

    const RS = (0.40 * getScore(rel, 'RCS_Correction_Rate_Quality', false) + // Renamed RCS to RS for formula
                0.30 * getScore(rel, 'RCS_Retraction_Appropriateness', false) +
                0.30 * getScore(rel, 'RCS_Accountability_Transparency', false)); // Typo in PDF (RS vs RCS)

    const UM = (0.40 * getScore(rel, 'UMS_Story_Update_Frequency', false) +
                0.30 * getScore(rel, 'UMS_Update_Substantiveness', false) +
                0.30 * getScore(rel, 'UMS_Archive_Accuracy', false)); // Typo in PDF (UM vs UMS)

    // Final URS calculation using weights from [cite: 129]
    const ursScore = (0.25 * CM + 0.20 * TM + 0.20 * QC + 0.15 * PS + 0.12 * RS + 0.08 * UM); // Note PDF typos in beta/gamma/zeta weights
    return Math.round(Math.max(0, Math.min(100, ursScore))); // Clamp 0-100
}

// Calculate Simplified Bias Score using E-UBDF components [cite: 481, 483-493]
function calculateBiasScore(components, isSentimentOnly) {
    if (isSentimentOnly || !components) return 0;
    const bias = components.bias || {}; // Ensure sub-object exists

    // Using available E-UBDF components Gemini estimated
    const L = getScore(bias, 'L_Linguistic_Bias', false);
    const S = getScore(bias, 'S_Source_Bias', false);
    const P = getScore(bias, 'P_Psychological_Bias', false); // Framing etc.
    const C = getScore(bias, 'C_Content_Bias', false); // Omission, Selection
    const T = getScore(bias, 'T_Temporal_Bias', false);
    const M = getScore(bias, 'M_Meta_Info_Bias', false); // Headline, image
    const D = getScore(bias, 'D_Demographic_Bias', false);
    const ST = getScore(bias, 'ST_Structural_Bias', false); // Ownership, ads
    const CU = getScore(bias, 'CU_Cultural_Bias', false); // Geography etc.
    const EC = getScore(bias, 'EC_Economic_Bias', false);
    const EN = getScore(bias, 'EN_Environmental_Bias', false);

    // Apply E-UBDF weights  - Sum of weights = 1.00
    const biasScore = (
        0.15 * L + 0.12 * S + 0.10 * P + 0.15 * C + 0.08 * T +
        0.08 * M + 0.12 * D + 0.10 * ST + 0.05 * CU + 0.03 * EC +
        0.02 * EN
    );

    return Math.round(Math.max(0, Math.min(100, biasScore))); // Clamp 0-100
}

// Calculate Overall Trust Score (OTS) [cite: 232]
function calculateTrustScore(ucs, urs, isSentimentOnly) {
    if (isSentimentOnly) return 0;
    // Handle potential 0 scores to avoid sqrt(0) -> NaN if desired, though sqrt(0)=0 is fine
    const score = (ucs > 0 && urs > 0) ? Math.sqrt(ucs * urs) : 0;
    return Math.round(Math.max(0, Math.min(100, score)));
}

// Determine Grade and Trust Level from Matrix [cite: 233-272]
function getGradeAndLevel(ucs, urs, ots) {
    // Determine Reliability Level based on URS score
    let ursLevel;
    if (urs >= 86) ursLevel = 'Exceptional';
    else if (urs >= 71) ursLevel = 'High';
    else if (urs >= 51) ursLevel = 'Medium';
    else ursLevel = 'Low'; // 0-50

    // Determine Credibility Level based on UCS score
    let ucsLevel;
    if (ucs >= 86) ucsLevel = 'Exceptional';
    else if (ucs >= 71) ucsLevel = 'High';
    else if (ucs >= 51) ucsLevel = 'Medium';
    else ucsLevel = 'Low'; // 0-50

    // Look up grade based on the matrix intersection [cite: 239-263]
    let grade = 'F'; // Default
    if (ursLevel === 'Exceptional') {
        if (ucsLevel === 'Exceptional') grade = 'A+';
        else if (ucsLevel === 'High') grade = 'A-';
        else if (ucsLevel === 'Medium') grade = 'B+';
        else grade = 'C'; // Low Cred, Exceptional Rel
    } else if (ursLevel === 'High') {
        if (ucsLevel === 'Exceptional') grade = 'A';
        else if (ucsLevel === 'High') grade = 'B';
        else if (ucsLevel === 'Medium') grade = 'C+';
        else grade = 'D+'; // Low Cred, High Rel
    } else if (ursLevel === 'Medium') {
        if (ucsLevel === 'Exceptional') grade = 'B+'; // Note: PDF has B+ twice for Medium Rel
        else if (ucsLevel === 'High') grade = 'B-';
        else if (ucsLevel === 'Medium') grade = 'C'; // Note: PDF has C twice
        else grade = 'D'; // Low Cred, Medium Rel
    } else { // ursLevel === 'Low'
        if (ucsLevel === 'Exceptional') grade = 'C+'; // Note: PDF has C+ twice
        else if (ucsLevel === 'High') grade = 'C';
        else if (ucsLevel === 'Medium') grade = 'D'; // Note: PDF has D twice
        else grade = 'F'; // Low Cred, Low Rel
    }

    // Determine Trust Level based on Grade [cite: 265-272]
    let trustLevel = 'Untrustworthy';
    if (grade === 'A+') trustLevel = 'Highly Trustworthy';
    else if (grade === 'A' || grade === 'A-') trustLevel = 'Very Trustworthy'; // Combined A grades
    else if (grade === 'B+' || grade === 'B') trustLevel = 'Trustworthy'; // Combined B+ / B
    else if (grade === 'B-') trustLevel = 'Generally Trustworthy'; // Added B- here based on B range
    else if (grade === 'C+') trustLevel = 'Moderately Trustworthy';
    else if (grade === 'C') trustLevel = 'Questionable';
    else if (grade === 'D+' || grade === 'D') trustLevel = 'Low Trust'; // Combined D grades
    // F remains Untrustworthy

    // PDF Grade mapping seems slightly inconsistent with score ranges vs matrix. Using Matrix lookup.
    // The credibilityGrade in the DB will be the combined grade (A+, A etc.)
    // The reliabilityGrade field might be redundant or could store the URS level (Exceptional, High...). Storing combined grade for now.

    return { grade: grade, trustLevel: trustLevel };
}


// --- API Routes (GET routes remain largely the same) ---
// Health Check Route
app.get('/', (req, res) => { /* ... unchanged ... */ });
// GET /api/articles
app.get('/api/articles', async (req, res, next) => { /* ... unchanged ... */ });
// GET /api/articles/:id
app.get('/api/articles/:id', async (req, res, next) => { /* ... unchanged ... */ });
// GET /api/cluster/:clusterId
app.get('/api/cluster/:clusterId', async (req, res, next) => { /* ... unchanged ... */ });
// GET /api/stats
app.get('/api/stats', async (req, res, next) => { /* ... unchanged ... */ });
// GET /api/stats/keys
app.get('/api/stats/keys', (req, res, next) => { /* ... unchanged ... */ });


// POST /api/fetch-news - Trigger background fetch
let isFetchRunning = false;
app.post('/api/fetch-news', (req, res) => {
  if (isFetchRunning) {
    console.warn('⚠️ Manual fetch ignored: Already running.');
    return res.status(429).json({ message: 'Fetch process already running.' });
  }
  console.log('📰 Manual fetch triggered...');
  isFetchRunning = true;
  res.status(202).json({ message: 'Fetch acknowledged. Analysis starting.', timestamp: new Date().toISOString() });

  fetchAndAnalyzeNews()
    .catch(err => { console.error('❌ FATAL Error during manually triggered fetch:', err.message); })
    .finally(() => { isFetchRunning = false; console.log('🟢 Manual fetch background process finished.'); });
});


// --- MODIFIED Core Fetch/Analyze Function ---
async function fetchAndAnalyzeNews() {
  console.log('🔄 Starting fetchAndAnalyzeNews cycle...');
  const stats = { fetched: 0, processed: 0, skipped_duplicate: 0, skipped_invalid: 0, errors: 0, start_time: Date.now() };

  try {
    const rawArticles = await newsService.fetchNews();
    stats.fetched = rawArticles.length;
    console.log(`📰 Fetched ${stats.fetched} raw articles.`);
    if (stats.fetched === 0) {
      console.log("🏁 No articles fetched.");
      return stats;
    }

    // Process articles sequentially for rate limiting (free tier)
    for (const article of rawArticles) {
        try {
            // 1. Validate & Skip Check
            if (!article?.url || !article?.title || !article?.description || article.description.length < 30) {
                stats.skipped_invalid++; continue;
            }
            const exists = await Article.findOne({ url: article.url }, { _id: 1 }).lean();
            if (exists) {
                stats.skipped_duplicate++; continue;
            }

            // 2. Analyze with Gemini to get COMPONENT SCORES
            console.log(`🤖 Analyzing components for: ${article.title.substring(0, 50)}...`);
            // analysisResult now contains { summary, category, ..., estimated_components: { credibility: {...}, ... } }
            const analysisResult = await geminiService.analyzeArticle(article);
            const estimatedComponents = analysisResult.estimated_components;
            const isSentimentOnly = analysisResult.analysisType === 'SentimentOnly';

            // 3. CALCULATE FINAL SCORES using formulas
            const calculatedUCS = calculateUCS(estimatedComponents, isSentimentOnly);
            const calculatedURS = calculateURS(estimatedComponents, isSentimentOnly);
            const calculatedBiasScore = calculateBiasScore(estimatedComponents, isSentimentOnly);
            const calculatedTrustScore = calculateTrustScore(calculatedUCS, calculatedURS, isSentimentOnly);
            const { grade, trustLevel } = getGradeAndLevel(calculatedUCS, calculatedURS, calculatedTrustScore);

            // 4. Prepare data for DB using CALCULATED scores and AI qualitative data
            const newArticleData = {
              headline: article.title,
              summary: analysisResult.summary || 'Summary unavailable',
              source: article.source?.name || 'Unknown Source',
              category: analysisResult.category || 'General',
              politicalLean: analysisResult.politicalLean || defaultLean,
              url: article.url,
              imageUrl: article.urlToImage,
              publishedAt: article.publishedAt ? new Date(article.publishedAt) : new Date(),
              analysisType: analysisResult.analysisType || 'Full',
              sentiment: analysisResult.sentiment || 'Neutral',

              // Assign calculated final scores
              biasScore: calculatedBiasScore,
              credibilityScore: calculatedUCS, // UCS assigned to credibilityScore
              reliabilityScore: calculatedURS, // URS assigned to reliabilityScore
              trustScore: calculatedTrustScore, // OTS assigned to trustScore

              // Assign derived grades/labels
              credibilityGrade: grade, // Grade from matrix
              reliabilityGrade: grade, // Assign same grade for now, or derive URS level? Using combined grade.
              trustLevel: trustLevel, // Level from matrix/grade
              biasLabel: determineBiasLabel(calculatedBiasScore), // Need a helper for this

              // Store the raw estimated components from AI
              biasComponents: estimatedComponents?.bias || {},
              credibilityComponents: estimatedComponents?.credibility || {},
              reliabilityComponents: estimatedComponents?.reliability || {},

              // Other fields from AI/article
              coverageLeft: analysisResult.coverageLeft || 0,
              coverageCenter: analysisResult.coverageCenter || 0,
              coverageRight: analysisResult.coverageRight || 0,
              clusterId: analysisResult.clusterId,
              keyFindings: analysisResult.keyFindings || [],
              recommendations: analysisResult.recommendations || [],
              analysisVersion: Article.schema.path('analysisVersion').defaultValue
            };

            // 5. Save to DB
            const savedArticle = await Article.create(newArticleData);
            stats.processed++;
            console.log(`✅ Saved [${savedArticle._id}] (UCS:${calculatedUCS}, URS:${calculatedURS}, Bias:${calculatedBiasScore}, Trust:${calculatedTrustScore}, Grade:${grade}): ${savedArticle.headline.substring(0, 40)}...`);

            // --- DELAY FOR FREE TIER RATE LIMIT ---
            // IMPORTANT: Uncomment if NOT using billing. Keep commented if billing enabled.
            await sleep(31000); // Wait 31 seconds
            // ----------------------------------------

        } catch (error) {
            console.error(`❌ Error processing article "${article?.title?.substring(0,60)}...": ${error.message}`);
            stats.errors++;
            // If rate limited, maybe add a longer sleep before next article?
            if (error.message.includes('429')) {
                console.warn('Rate limit hit, pausing for 60 seconds...');
                await sleep(60000); // Wait longer after a 429
            } else if (error.message.includes('503')) {
                 console.warn('Service unavailable (503), pausing for 10 seconds...');
                 await sleep(10000); // Short pause after 503
            }
            // Continue to the next article even if one fails
        }
    } // End loop

    stats.end_time = Date.now();
    const duration = ((stats.end_time - stats.start_time) / 1000).toFixed(2);
    console.log(`\n🏁 Fetch cycle finished in ${duration}s: ${stats.processed} processed, ${stats.skipped_duplicate} duplicate(s), ${stats.skipped_invalid} invalid, ${stats.errors} error(s).\n`);
    return stats;

  } catch (error) {
    console.error('❌ CRITICAL Error during news fetch stage:', error.message);
    stats.errors++;
    stats.end_time = Date.now();
    const duration = ((stats.end_time - stats.start_time) / 1000).toFixed(2);
    console.log(`\n⚠️ Fetch cycle aborted after ${duration}s due to fetch error. Stats: ${JSON.stringify(stats)}`);
  }
}

// --- Helper to determine Bias Label from Score ---
function determineBiasLabel(score) {
    if (score >= 80) return 'Extreme'; // Example thresholds - adjust as needed
    if (score >= 60) return 'High';
    if (score >= 30) return 'Moderate';
    return 'Low Bias';
}


// --- Sleep Function ---
function sleep(ms) {
  console.log(`😴 Sleeping for ${ms / 1000} seconds...`);
  return new Promise(resolve => setTimeout(resolve, ms));
}


// --- Scheduled Tasks ---
cron.schedule('*/30 * * * *', () => { // Every 30 minutes
  if (isFetchRunning) {
    console.log('⏰ Cron: Skipping scheduled fetch - already running.');
    return;
  }
  console.log('⏰ Cron: Triggering scheduled news fetch...');
  isFetchRunning = true;
  fetchAndAnalyzeNews()
    .catch(err => { console.error('❌ CRITICAL Error during scheduled fetch:', err.message); })
    .finally(() => { isFetchRunning = false; console.log('🟢 Scheduled fetch process complete.'); });
});

cron.schedule('0 2 * * *', async () => { // Daily at 2 AM
  console.log('🧹 Cron: Triggering daily article cleanup...');
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await Article.deleteMany({ createdAt: { $lt: sevenDaysAgo } }).limit(5000);
    console.log(`🗑️ Cleanup successful: Deleted ${result.deletedCount} articles older than 7 days.`);
  } catch (error) {
    console.error('❌ CRITICAL Error during scheduled cleanup:', error.message);
  }
});

// --- Error Handling & Server Startup ---
app.use((req, res, next) => { // 404 Handler
  res.status(404).json({ error: `Not Found - Cannot ${req.method} ${req.originalUrl}` });
});

app.use((err, req, res, next) => { // Global Error Handler
  console.error('💥 Global Error Handler:', err);
  const statusCode = err.status || err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' ? 'An unexpected error occurred.' : err.message;
  res.status(statusCode).json({ error: { message: message } });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 Server listening on port ${PORT}`);
  console.log(`🔗 Health Check: http://localhost:${PORT}/`);
});

// --- Graceful Shutdown ---
const gracefulShutdown = async (signal) => { /* ... unchanged ... */ };
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
