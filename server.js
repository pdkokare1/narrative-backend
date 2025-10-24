// server.js (FINAL v2.7 - Formula Calculation + Delay)
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
const newsService = require('./services/newsService'); // Assumes newsService.js has focused fetching

const app = express();

// --- Middleware ---
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false })); // Basic security headers
app.use(compression()); // Gzip
app.use(cors()); // Allow frontend
app.use(express.json({ limit: '1mb' })); // Parse JSON

// --- Rate Limiter ---
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 100, // 100 requests per 15 mins per IP
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
  biasLabel: String,
  credibilityScore: { type: Number, default: 0, min: 0, max: 100 }, // UCS
  credibilityGrade: String, // Grade from matrix
  reliabilityScore: { type: Number, default: 0, min: 0, max: 100 }, // URS
  reliabilityGrade: String, // Can store URS level (e.g., High) or duplicate combined grade
  trustScore: { type: Number, default: 0, min: 0, max: 100 }, // OTS
  trustLevel: String, // Level from matrix/grade
  // Store AI's estimated components
  aiEstimates: { // Store estimates in a sub-document
      credibilityComponents: mongoose.Schema.Types.Mixed, // Estimated UCS components
      reliabilityComponents: mongoose.Schema.Types.Mixed, // Estimated URS components
      biasComponents: mongoose.Schema.Types.Mixed, // Estimated Bias components
  },
  // Other fields
  coverageLeft: { type: Number, default: 0 },
  coverageCenter: { type: Number, default: 0 },
  coverageRight: { type: Number, default: 0 },
  clusterId: { type: Number, index: true },
  keyFindings: [String],
  recommendations: [String],
  analysisVersion: { type: String, default: '2.7-formula' } // Version bump
}, {
  timestamps: true,
  autoIndex: process.env.NODE_ENV !== 'production',
});

// Indexes
articleSchema.index({ category: 1, publishedAt: -1 });
articleSchema.index({ politicalLean: 1, publishedAt: -1 });
articleSchema.index({ clusterId: 1, trustScore: -1 });
articleSchema.index({ trustScore: -1, publishedAt: -1 });
articleSchema.index({ biasScore: 1, publishedAt: -1 });
articleSchema.index({ createdAt: 1 }); // For cleanup

const Article = mongoose.model('Article', articleSchema);


// --- FORMULA CALCULATION HELPERS ---

// Safely get estimated score (0-100), default to 0 if invalid or SentimentOnly
const getEstScore = (obj, key, isSentimentOnly) => {
    if (isSentimentOnly) return 0;
    const score = obj?.[key];
    return (typeof score === 'number' && score >= 0 && score <= 100) ? Math.round(score) : 0; // Round estimates
};

[cite_start]// Calculate Universal Credibility Score (UCS) [cite: 7]
function calculateUCS(components, isSentimentOnly) {
    if (isSentimentOnly || !components?.credibility) return 0;
    const cred = components.credibility;

    [cite_start]// Calculate sub-scores based on PDF structure [cite: 17, 41, 62, 84, 109, 118]
    [cite_start]const SC = (0.30 * getEstScore(cred, 'SC_Historical_Accuracy', false) + // [cite: 19]
                [cite_start]0.25 * getEstScore(cred, 'SC_Org_Reputation', false) + // [cite: 21]
                [cite_start]0.20 * getEstScore(cred, 'SC_Industry_Recognition', false) + // [cite: 22]
                [cite_start]0.15 * getEstScore(cred, 'SC_Corrections_Policy_Quality', false) + // [cite: 23]
                0.10 * getEstScore(cred, 'SC_Editorial_Standards', false)); [cite_start]// [cite: 24]

    [cite_start]const VC = (0.35 * getEstScore(cred, 'VC_Source_Citation_Quality', false) + // [cite: 43]
                [cite_start]0.25 * getEstScore(cred, 'VC_Fact_Verification_Process', false) + // [cite: 44]
                [cite_start]0.20 * getEstScore(cred, 'VC_Claims_Substantiation', false) + // [cite: 46]
                0.20 * getEstScore(cred, 'VC_External_Validation', false)); [cite_start]// [cite: 47]

    [cite_start]const PC = (0.30 * getEstScore(cred, 'PC_Objectivity_Score', false) + // [cite: 64]
                [cite_start]0.25 * getEstScore(cred, 'PC_Source_Transparency', false) + // [cite: 65]
                [cite_start]0.25 * getEstScore(cred, 'PC_Editorial_Independence', false) + // [cite: 66]
                0.20 * getEstScore(cred, 'PC_Professional_Standards_Adherence', false)); [cite_start]// [cite: 67]

    [cite_start]const EC = (0.35 * getEstScore(cred, 'EC_Data_Quality', false) + // [cite: 86]
                [cite_start]0.30 * getEstScore(cred, 'EC_Evidence_Strength', false) + // [cite: 87]
                [cite_start]0.20 * getEstScore(cred, 'EC_Expert_Validation', false) + // [cite: 87]
                0.15 * getEstScore(cred, 'EC_Methodological_Rigor', false)); [cite_start]// [cite: 89] (Weight assumed)

    [cite_start]const TC = (0.35 * getEstScore(cred, 'TC_Source_Disclosure', false) + // [cite: 111]
                [cite_start]0.25 * getEstScore(cred, 'TC_Ownership_Transparency', false) + // [cite: 112]
                [cite_start]0.20 * getEstScore(cred, 'TC_Corrections_Transparency', false) + // [cite: 113]
                0.20 * getEstScore(cred, 'TC_Financial_Transparency', false)); [cite_start]// [cite: 115]

    [cite_start]const AC = (0.40 * getEstScore(cred, 'AC_Reader_Trust_Rating', false) + // [cite: 120]
                [cite_start]0.30 * getEstScore(cred, 'AC_Community_Fact_Check_Score', false) + // [cite: 121]
                0.30 * getEstScore(cred, 'AC_Cross_Platform_Reputation', false)); [cite_start]// [cite: 122]

    [cite_start]// Final UCS weighted sum [cite: 7, 9-14] (Correcting PDF weight typos based on sum=1.0)
    const ucsScore = (0.25 * SC + 0.20 * VC + 0.20 * PC + 0.15 * EC + 0.12 * TC + 0.08 * AC);
    return Math.round(Math.max(0, Math.min(100, ucsScore)));
}

[cite_start]// Calculate Universal Reliability Score (URS) [cite: 129]
function calculateURS(components, isSentimentOnly) {
    if (isSentimentOnly || !components?.reliability) return 0;
    const rel = components.reliability;

    [cite_start]// Calculate sub-scores [cite: 134, 147, 159, 186, 196, 220]
    [cite_start]const CM = (0.35 * getEstScore(rel, 'CM_Accuracy_Consistency', false) + // [cite: 136]
                [cite_start]0.30 * getEstScore(rel, 'CM_Quality_Variance', false) + // [cite: 137]
                [cite_start]0.20 * getEstScore(rel, 'CM_Bias_Stability', false) + // [cite: 138]
                0.15 * getEstScore(rel, 'CM_Source_Pattern_Consistency', false)); [cite_start]// [cite: 139]

    [cite_start]const TM = (0.40 * getEstScore(rel, 'TS_Historical_Track_Record', false) + // [cite: 149]
                [cite_start]0.30 * getEstScore(rel, 'TS_Publication_Longevity', false) + // [cite: 149]
                0.30 * getEstScore(rel, 'TS_Performance_Trend', false)); [cite_start]// [cite: 149]

    [cite_start]const QC = (0.30 * getEstScore(rel, 'QC_Editorial_Review_Process', false) + // [cite: 161]
                [cite_start]0.25 * getEstScore(rel, 'QC_Fact_Checking_Infrastructure', false) + // [cite: 162]
                [cite_start]0.25 * getEstScore(rel, 'QC_Error_Detection_Rate', false) + // [cite: 163]
                0.20 * getEstScore(rel, 'QC_Correction_Response_Time', false)); [cite_start]// [cite: 164]

    [cite_start]const PS = (0.30 * getEstScore(rel, 'PS_Journalistic_Code_Adherence', false) + // [cite: 188]
                [cite_start]0.25 * getEstScore(rel, 'PS_Industry_Certification', false) + // [cite: 189]
                [cite_start]0.25 * getEstScore(rel, 'PS_Professional_Membership', false) + // [cite: 190]
                0.20 * getEstScore(rel, 'PS_Ethics_Compliance', false)); [cite_start]// [cite: 190]

    [cite_start]const RS = (0.40 * getEstScore(rel, 'RCS_Correction_Rate_Quality', false) + // [cite: 198]
                [cite_start]0.30 * getEstScore(rel, 'RCS_Retraction_Appropriateness', false) + // [cite: 200]
                0.30 * getEstScore(rel, 'RCS_Accountability_Transparency', false)); [cite_start]// [cite: 200]

    [cite_start]const UM = (0.40 * getEstScore(rel, 'UMS_Story_Update_Frequency', false) + // [cite: 222]
                [cite_start]0.30 * getEstScore(rel, 'UMS_Update_Substantiveness', false) + // [cite: 224]
                0.30 * getEstScore(rel, 'UMS_Archive_Accuracy', false)); [cite_start]// [cite: 225]

    [cite_start]// Final URS weighted sum [cite: 129, 131] (Correcting PDF weight typos)
    const ursScore = (0.25 * CM + 0.20 * TM + 0.20 * QC + 0.15 * PS + 0.12 * RS + 0.08 * UM);
    return Math.round(Math.max(0, Math.min(100, ursScore)));
}

[cite_start]// Calculate Simplified Bias Score using E-UBDF components [cite: 482]
function calculateBiasScore(components, isSentimentOnly) {
    if (isSentimentOnly || !components?.bias) return 0;
    const bias = components.bias;

    [cite_start]// Apply E-UBDF weights [cite: 484-494]
    const biasScoreVal = (
        0.15 * getEstScore(bias, 'L_Linguistic_Bias', false) +
        0.12 * getEstScore(bias, 'S_Source_Bias', false) +
        0.10 * getEstScore(bias, 'P_Psychological_Bias', false) +
        0.15 * getEstScore(bias, 'C_Content_Bias', false) +
        0.08 * getEstScore(bias, 'T_Temporal_Bias', false) +
        0.08 * getEstScore(bias, 'M_Meta_Info_Bias', false) +
        0.12 * getEstScore(bias, 'D_Demographic_Bias', false) +
        0.10 * getEstScore(bias, 'ST_Structural_Bias', false) +
        0.05 * getEstScore(bias, 'CU_Cultural_Bias', false) +
        0.03 * getEstScore(bias, 'EC_Economic_Bias', false) +
        0.02 * getEstScore(bias, 'EN_Environmental_Bias', false)
    );
    return Math.round(Math.max(0, Math.min(100, biasScoreVal)));
}

[cite_start]// Calculate Overall Trust Score (OTS) [cite: 232]
function calculateTrustScore(ucs, urs, isSentimentOnly) {
    if (isSentimentOnly) return 0;
    const score = (ucs > 0 && urs > 0) ? Math.sqrt(ucs * urs) : 0;
    return Math.round(Math.max(0, Math.min(100, score)));
}

[cite_start]// Determine Grade and Trust Level from Matrix [cite: 233-272]
function getGradeAndLevel(ucs, urs) {
    let ursLevel, ucsLevel;
    // Reliability Levels
    if (urs >= 86) ursLevel = 'Exceptional'; else if (urs >= 71) ursLevel = 'High'; else if (urs >= 51) ursLevel = 'Medium'; else ursLevel = 'Low';
    [cite_start]// Credibility Levels [cite: 235-238]
    if (ucs >= 86) ucsLevel = 'Exceptional'; else if (ucs >= 71) ucsLevel = 'High'; else if (ucs >= 51) ucsLevel = 'Medium'; else ucsLevel = 'Low';

    let grade = 'F'; [cite_start]// Default [cite: 272]
    [cite_start]// Matrix Lookup [cite: 239-263]
    if (ursLevel === 'Exceptional') {
        if (ucsLevel === 'Exceptional') grade = 'A+'; else if (ucsLevel === 'High') grade = 'A-'; else if (ucsLevel === 'Medium') grade = 'B+'; else grade = 'C';
    } else if (ursLevel === 'High') {
        if (ucsLevel === 'Exceptional') grade = 'A'; else if (ucsLevel === 'High') grade = 'B'; else if (ucsLevel === 'Medium') grade = 'C+'; else grade = 'D+';
    } else if (ursLevel === 'Medium') {
        if (ucsLevel === 'Exceptional') grade = 'B+'; else if (ucsLevel === 'High') grade = 'B-'; else if (ucsLevel === 'Medium') grade = 'C'; else grade = 'D';
    } else { // ursLevel === 'Low'
        if (ucsLevel === 'Exceptional') grade = 'C+'; else if (ucsLevel === 'High') grade = 'C'; else if (ucsLevel === 'Medium') grade = 'D'; else grade = 'F';
    }

    [cite_start]// Determine Trust Level based on Grade [cite: 265-272]
    let trustLevel = 'Untrustworthy'; [cite_start]// [cite: 272]
    if (grade === 'A+') trustLevel = 'Highly Trustworthy'; [cite_start]// [cite: 265]
    else if (grade === 'A' || grade === 'A-') trustLevel = 'Very Trustworthy'; [cite_start]// [cite: 266] (A)
    else if (grade === 'B+') trustLevel = 'Trustworthy'; [cite_start]// [cite: 267]
    else if (grade === 'B') trustLevel = 'Generally Trustworthy'; [cite_start]// [cite: 268]
    else if (grade === 'B-') trustLevel = 'Generally Trustworthy'; // Assign B- same level as B
    else if (grade === 'C+') trustLevel = 'Moderately Trustworthy'; [cite_start]// [cite: 269]
    else if (grade === 'C') trustLevel = 'Questionable'; [cite_start]// [cite: 270]
    else if (grade === 'D+' || grade === 'D') trustLevel = 'Low Trust'; [cite_start]// [cite: 271] (D)

    return { grade, trustLevel, ucsLevel, ursLevel };
}

// Helper to determine Bias Label from Score (Example thresholds)
function determineBiasLabel(score) {
    if (score === null || score === undefined || isNaN(score)) return 'N/A';
    if (score >= 80) return 'Extreme';
    if (score >= 60) return 'High';
    if (score >= 40) return 'Moderate'; // Adjusted threshold
    return 'Low Bias';
}


// --- API Routes (GET routes remain largely the same, minor logging/error handling improvements) ---
app.get('/', (req, res) => { /* ... unchanged ... */ });
app.get('/api/articles', async (req, res, next) => { /* ... unchanged ... */ });
app.get('/api/articles/:id', async (req, res, next) => { /* ... unchanged ... */ });
app.get('/api/cluster/:clusterId', async (req, res, next) => { /* ... unchanged ... */ });
app.get('/api/stats', async (req, res, next) => { /* ... unchanged ... */ });
app.get('/api/stats/keys', (req, res, next) => { /* ... unchanged ... */ });


// POST /api/fetch-news - Trigger background news fetch
let isFetchRunning = false;
app.post('/api/fetch-news', (req, res) => {
  if (isFetchRunning) {
    console.warn('⚠️ Manual fetch ignored: Already running.');
    return res.status(429).json({ message: 'Fetch process already running.' });
  }
  console.log('📰 Manual fetch triggered via API...');
  isFetchRunning = true;
  res.status(202).json({ message: 'Fetch acknowledged. Analysis starting background.', timestamp: new Date().toISOString() });

  fetchAndAnalyzeNews()
    .catch(err => { console.error('❌ FATAL Error during manually triggered fetch:', err.message); })
    .finally(() => { isFetchRunning = false; console.log('🟢 Manual fetch background process finished.'); });
});


// --- MODIFIED Core Fetch/Analyze Function ---
async function fetchAndAnalyzeNews() {
  console.log('🔄 Starting fetchAndAnalyzeNews cycle...');
  const stats = { fetched: 0, processed: 0, skipped_duplicate: 0, skipped_invalid: 0, errors: 0, start_time: Date.now() };

  try {
    const rawArticles = await newsService.fetchNews(); // Fetches US/IN/World news
    stats.fetched = rawArticles.length;
    console.log(`📰 Fetched ${stats.fetched} raw articles.`);
    if (stats.fetched === 0) {
      console.log("🏁 No articles fetched.");
      stats.end_time = Date.now(); // Record end time even if no articles
      return stats;
    }

    // Process articles sequentially
    for (const article of rawArticles) {
        let savedArticleId = null; // Track if article gets saved
        try {
            // 1. Validate & Skip Check
            if (!article?.url || !article?.title || !article?.description || article.description.length < 30) {
                stats.skipped_invalid++; continue;
            }
            const exists = await Article.findOne({ url: article.url }, { _id: 1 }).lean();
            if (exists) {
                stats.skipped_duplicate++; continue;
            }

            // 2. Analyze with Gemini to get COMPONENT ESTIMATES
            console.log(`🤖 Analyzing components: ${article.title.substring(0, 50)}...`);
            // analysisResult contains: { summary, category, politicalLean, analysisType, sentiment, estimated_components: { credibility: {...}, reliability: {...}, bias: {...} }, keyFindings, recommendations }
            const analysisResult = await geminiService.analyzeArticle(article);
            const estimatedComponents = analysisResult.estimated_components;
            const isSentimentOnly = analysisResult.analysisType === 'SentimentOnly';

            // 3. CALCULATE FINAL SCORES using formulas
            const calculatedUCS = calculateUCS(estimatedComponents, isSentimentOnly);
            const calculatedURS = calculateURS(estimatedComponents, isSentimentOnly);
            const calculatedBiasScore = calculateBiasScore(estimatedComponents, isSentimentOnly);
            const calculatedTrustScore = calculateTrustScore(calculatedUCS, calculatedURS, isSentimentOnly);
            const { grade, trustLevel, ucsLevel, ursLevel } = getGradeAndLevel(calculatedUCS, calculatedURS); // Removed trust score from input

            // 4. Prepare data for DB
            const newArticleData = {
              headline: article.title,
              summary: analysisResult.summary || 'Summary unavailable',
              source: article.source?.name || 'Unknown Source',
              category: analysisResult.category || 'General',
              politicalLean: analysisResult.politicalLean || (isSentimentOnly ? 'Not Applicable' : 'Center'),
              url: article.url,
              imageUrl: article.urlToImage,
              publishedAt: article.publishedAt ? new Date(article.publishedAt) : new Date(),
              analysisType: analysisResult.analysisType || 'Full',
              sentiment: analysisResult.sentiment || 'Neutral',

              // Assign CALCULATED final scores
              biasScore: calculatedBiasScore,
              credibilityScore: calculatedUCS,
              reliabilityScore: calculatedURS,
              trustScore: calculatedTrustScore,

              // Assign derived grades/labels
              credibilityGrade: grade, // Combined grade from matrix
              reliabilityGrade: ursLevel, // Store URS level (e.g., High, Medium) here instead of duplicating grade
              trustLevel: trustLevel,
              biasLabel: determineBiasLabel(calculatedBiasScore),

              // Store the raw ESTIMATED components from AI in a sub-document
              aiEstimates: {
                  credibilityComponents: estimatedComponents?.credibility || {},
                  reliabilityComponents: estimatedComponents?.reliability || {},
                  biasComponents: estimatedComponents?.bias || {},
              },
              // Store top-level components for simpler querying if needed (optional redundancy)
              // biasComponents: estimatedComponents?.bias || {},
              // credibilityComponents: estimatedComponents?.credibility || {},
              // reliabilityComponents: estimatedComponents?.reliability || {},

              // Other fields
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
            savedArticleId = savedArticle._id; // Store ID for logging
            stats.processed++;
            console.log(`✅ Saved [${savedArticleId}] (UCS:${calculatedUCS}, URS:${calculatedURS}, Bias:${calculatedBiasScore}, OTS:${calculatedTrustScore}, Grade:${grade}) ${savedArticle.headline.substring(0, 40)}...`);

            // --- DELAY FOR FREE TIER RATE LIMIT ---
            // IMPORTANT: Uncomment if NOT using billing. Keep commented if billing enabled.
            await sleep(31000); // Wait 31 seconds
            // ----------------------------------------

        } catch (error) {
            // Log errors during individual article processing but continue the loop
            console.error(`❌ Error processing article "${article?.title?.substring(0,60)}...": ${error.message}`);
            stats.errors++;
            // Optional: Implement logic to handle specific errors differently (e.g., longer pause on 429)
            if (error.message.includes('429') || error.message.includes('returned status 429')) {
                console.warn('Rate limit likely hit, pausing for 60 seconds...');
                await sleep(60000); // Wait longer after a 429
            } else if (error.message.includes('503') || error.message.includes('returned status 503')) {
                 console.warn('Service unavailable (503), pausing for 10 seconds...');
                 await sleep(10000); // Short pause after 503
            } else {
                 // For other errors (parsing, saving), maybe a shorter pause or none
                 await sleep(1000); // Short pause after generic error
            }
        }
    } // End loop

    stats.end_time = Date.now();
    const duration = ((stats.end_time - stats.start_time) / 1000).toFixed(2);
    console.log(`\n🏁 Fetch cycle finished in ${duration}s: ${stats.processed} processed, ${stats.skipped_duplicate} duplicate(s), ${stats.skipped_invalid} invalid, ${stats.errors} error(s).\n`);
    return stats;

  } catch (error) {
    console.error('❌ CRITICAL Error during news fetching stage:', error.message);
    stats.errors++;
    stats.end_time = Date.now();
    const duration = ((stats.end_time - stats.start_time) / 1000).toFixed(2);
    console.log(`\n⚠️ Fetch cycle aborted after ${duration}s due to fetch error. Stats: ${JSON.stringify(stats)}`);
    // Allow cron job to finish without throwing
  }
}

// --- Sleep Function ---
function sleep(ms) {
  if (ms > 0) console.log(`😴 Sleeping for ${ms / 1000} seconds...`);
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

cron.schedule('0 2 * * *', async () => { /* ... unchanged ... */ });

// --- Error Handling & Server Startup ---
app.use((req, res, next) => { /* ... unchanged ... */ }); // 404
app.use((err, req, res, next) => { /* ... unchanged ... */ }); // Global Error Handler

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => { /* ... unchanged ... */ });

// --- Graceful Shutdown ---
const gracefulShutdown = async (signal) => { /* ... unchanged ... */ };
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
