// server.js (FINAL v2.9 - SyntaxError Fixed + Delay)
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
  reliabilityGrade: String, // URS level (e.g., High)
  trustScore: { type: Number, default: 0, min: 0, max: 100 }, // OTS
  trustLevel: String, // Level from matrix/grade
  // Store AI's estimated components
  aiEstimates: {
      credibilityComponents: mongoose.Schema.Types.Mixed,
      reliabilityComponents: mongoose.Schema.Types.Mixed,
      biasComponents: mongoose.Schema.Types.Mixed,
  },
  coverageLeft: { type: Number, default: 0 },
  coverageCenter: { type: Number, default: 0 },
  coverageRight: { type: Number, default: 0 },
  clusterId: { type: Number, index: true },
  keyFindings: [String],
  recommendations: [String],
  analysisVersion: { type: String, default: '2.9-final-fix' } // Version bump
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
articleSchema.index({ createdAt: 1 });

const Article = mongoose.model('Article', articleSchema);


// --- FORMULA CALCULATION HELPERS ---

const getEstScore = (obj, key, isSentimentOnly) => {
    if (isSentimentOnly) return 0;
    const score = obj?.[key];
    return (typeof score === 'number' && score >= 0 && score <= 100) ? Math.round(score) : 0;
};

// --- CORRECTED calculateUCS function (Removed [cite] tags) ---
function calculateUCS(components, isSentimentOnly) {
    if (isSentimentOnly || !components?.credibility) return 0;
    const cred = components.credibility;

    // Calculate sub-scores based on PDF structure
    const SC = (0.30 * getEstScore(cred, 'SC_Historical_Accuracy', false) +
                0.25 * getEstScore(cred, 'SC_Org_Reputation', false) +
                0.20 * getEstScore(cred, 'SC_Industry_Recognition', false) +
                0.15 * getEstScore(cred, 'SC_Corrections_Policy_Quality', false) +
                0.10 * getEstScore(cred, 'SC_Editorial_Standards', false));

    const VC = (0.35 * getEstScore(cred, 'VC_Source_Citation_Quality', false) +
                0.25 * getEstScore(cred, 'VC_Fact_Verification_Process', false) +
                0.20 * getEstScore(cred, 'VC_Claims_Substantiation', false) +
                0.20 * getEstScore(cred, 'VC_External_Validation', false));

    const PC = (0.30 * getEstScore(cred, 'PC_Objectivity_Score', false) +
                0.25 * getEstScore(cred, 'PC_Source_Transparency', false) +
                0.25 * getEstScore(cred, 'PC_Editorial_Independence', false) +
                0.20 * getEstScore(cred, 'PC_Professional_Standards_Adherence', false));

    const EC = (0.35 * getEstScore(cred, 'EC_Data_Quality', false) +
                0.30 * getEstScore(cred, 'EC_Evidence_Strength', false) +
                0.20 * getEstScore(cred, 'EC_Expert_Validation', false) +
                0.15 * getEstScore(cred, 'EC_Methodological_Rigor', false));

    const TC = (0.35 * getEstScore(cred, 'TC_Source_Disclosure', false) +
                0.25 * getEstScore(cred, 'TC_Ownership_Transparency', false) +
                0.20 * getEstScore(cred, 'TC_Corrections_Transparency', false) +
                0.20 * getEstScore(cred, 'TC_Financial_Transparency', false));

    const AC = (0.40 * getEstScore(cred, 'AC_Reader_Trust_Rating', false) +
                0.30 * getEstScore(cred, 'AC_Community_Fact_Check_Score', false) +
                0.30 * getEstScore(cred, 'AC_Cross_Platform_Reputation', false));

    // Final UCS weighted sum (Corrected PDF weight typos based on sum=1.0)
    const ucsScore = (0.25 * SC + 0.20 * VC + 0.20 * PC + 0.15 * EC + 0.12 * TC + 0.08 * AC);
    return Math.round(Math.max(0, Math.min(100, ucsScore)));
}
// --- END CORRECTED FUNCTION ---


function calculateURS(components, isSentimentOnly) {
    if (isSentimentOnly || !components?.reliability) return 0;
    const rel = components.reliability;
    // Calculate sub-scores
    const CM = (0.35 * getEstScore(rel, 'CM_Accuracy_Consistency', false) +
                0.30 * getEstScore(rel, 'CM_Quality_Variance', false) +
                0.20 * getEstScore(rel, 'CM_Bias_Stability', false) +
                0.15 * getEstScore(rel, 'CM_Source_Pattern_Consistency', false));
    const TM = (0.40 * getEstScore(rel, 'TS_Historical_Track_Record', false) +
                0.30 * getEstScore(rel, 'TS_Publication_Longevity', false) +
                0.30 * getEstScore(rel, 'TS_Performance_Trend', false));
    const QC = (0.30 * getEstScore(rel, 'QC_Editorial_Review_Process', false) +
                0.25 * getEstScore(rel, 'QC_Fact_Checking_Infrastructure', false) +
                0.25 * getEstScore(rel, 'QC_Error_Detection_Rate', false) +
                0.20 * getEstScore(rel, 'QC_Correction_Response_Time', false));
    const PS = (0.30 * getEstScore(rel, 'PS_Journalistic_Code_Adherence', false) +
                0.25 * getEstScore(rel, 'PS_Industry_Certification', false) +
                0.25 * getEstScore(rel, 'PS_Professional_Membership', false) +
                0.20 * getEstScore(rel, 'PS_Ethics_Compliance', false));
    const RS = (0.40 * getEstScore(rel, 'RCS_Correction_Rate_Quality', false) +
                0.30 * getEstScore(rel, 'RCS_Retraction_Appropriateness', false) +
                0.30 * getEstScore(rel, 'RCS_Accountability_Transparency', false));
    const UM = (0.40 * getEstScore(rel, 'UMS_Story_Update_Frequency', false) +
                0.30 * getEstScore(rel, 'UMS_Update_Substantiveness', false) +
                0.30 * getEstScore(rel, 'UMS_Archive_Accuracy', false));
    // Final URS weighted sum (Corrected PDF weight typos)
    const ursScore = (0.25 * CM + 0.20 * TM + 0.20 * QC + 0.15 * PS + 0.12 * RS + 0.08 * UM);
    return Math.round(Math.max(0, Math.min(100, ursScore)));
}

function calculateBiasScore(components, isSentimentOnly) {
    if (isSentimentOnly || !components?.bias) return 0;
    const bias = components.bias;
    // Apply E-UBDF weights
    const biasScoreVal = (
        0.15 * getEstScore(bias, 'L_Linguistic_Bias', false) + 0.12 * getEstScore(bias, 'S_Source_Bias', false) +
        0.10 * getEstScore(bias, 'P_Psychological_Bias', false) + 0.15 * getEstScore(bias, 'C_Content_Bias', false) +
        0.08 * getEstScore(bias, 'T_Temporal_Bias', false) + 0.08 * getEstScore(bias, 'M_Meta_Info_Bias', false) +
        0.12 * getEstScore(bias, 'D_Demographic_Bias', false) + 0.10 * getEstScore(bias, 'ST_Structural_Bias', false) +
        0.05 * getEstScore(bias, 'CU_Cultural_Bias', false) + 0.03 * getEstScore(bias, 'EC_Economic_Bias', false) +
        0.02 * getEstScore(bias, 'EN_Environmental_Bias', false)
    );
    return Math.round(Math.max(0, Math.min(100, biasScoreVal)));
}

function calculateTrustScore(ucs, urs, isSentimentOnly) {
    if (isSentimentOnly) return 0;
    const score = (ucs > 0 && urs > 0) ? Math.sqrt(ucs * urs) : 0;
    return Math.round(Math.max(0, Math.min(100, score)));
}

function getGradeAndLevel(ucs, urs) {
    let ursLevel, ucsLevel;
    if (urs >= 86) ursLevel = 'Exceptional'; else if (urs >= 71) ursLevel = 'High'; else if (urs >= 51) ursLevel = 'Medium'; else ursLevel = 'Low';
    if (ucs >= 86) ucsLevel = 'Exceptional'; else if (ucs >= 71) ucsLevel = 'High'; else if (ucs >= 51) ucsLevel = 'Medium'; else ucsLevel = 'Low';
    let grade = 'F';
    if (ursLevel === 'Exceptional') { if (ucsLevel === 'Exceptional') grade = 'A+'; else if (ucsLevel === 'High') grade = 'A-'; else if (ucsLevel === 'Medium') grade = 'B+'; else grade = 'C'; }
    else if (ursLevel === 'High') { if (ucsLevel === 'Exceptional') grade = 'A'; else if (ucsLevel === 'High') grade = 'B'; else if (ucsLevel === 'Medium') grade = 'C+'; else grade = 'D+'; }
    else if (ursLevel === 'Medium') { if (ucsLevel === 'Exceptional') grade = 'B+'; else if (ucsLevel === 'High') grade = 'B-'; else if (ucsLevel === 'Medium') grade = 'C'; else grade = 'D'; }
    else { if (ucsLevel === 'Exceptional') grade = 'C+'; else if (ucsLevel === 'High') grade = 'C'; else if (ucsLevel === 'Medium') grade = 'D'; else grade = 'F'; }
    let trustLevel = 'Untrustworthy';
    switch(grade) {
        case 'A+': trustLevel = 'Highly Trustworthy'; break; case 'A': case 'A-': trustLevel = 'Very Trustworthy'; break;
        case 'B+': case 'B': trustLevel = 'Trustworthy'; break; case 'B-': trustLevel = 'Generally Trustworthy'; break;
        case 'C+': trustLevel = 'Moderately Trustworthy'; break; case 'C': trustLevel = 'Questionable'; break;
        case 'D+': case 'D': trustLevel = 'Low Trust'; break;
    }
    return { grade, trustLevel, ucsLevel, ursLevel };
}

function determineBiasLabel(score) {
    if (score === null || score === undefined || isNaN(score)) return 'N/A';
    if (score >= 80) return 'Extreme'; if (score >= 60) return 'High'; if (score >= 40) return 'Moderate'; return 'Low Bias';
}


// --- API Routes ---
app.get('/', (req, res) => { /* ... Unchanged ... */ });
app.get('/api/articles', async (req, res, next) => { /* ... Unchanged ... */ });
app.get('/api/articles/:id', async (req, res, next) => { /* ... Unchanged ... */ });
app.get('/api/cluster/:clusterId', async (req, res, next) => { /* ... Unchanged ... */ });
app.get('/api/stats', async (req, res, next) => { /* ... Unchanged ... */ });
app.get('/api/stats/keys', (req, res, next) => { /* ... Unchanged ... */ });
app.post('/api/fetch-news', (req, res) => { /* ... Unchanged ... */ });


// --- Core Fetch/Analyze Function ---
async function fetchAndAnalyzeNews() {
  console.log('🔄 Starting fetchAndAnalyzeNews cycle...');
  const stats = { fetched: 0, processed: 0, skipped_duplicate: 0, skipped_invalid: 0, errors: 0, start_time: Date.now() };

  try {
    const rawArticles = await newsService.fetchNews();
    stats.fetched = rawArticles.length;
    console.log(`📰 Fetched ${stats.fetched} raw articles.`);
    if (stats.fetched === 0) {
      console.log("🏁 No articles fetched.");
      stats.end_time = Date.now(); return stats;
    }

    // Process articles sequentially
    for (const article of rawArticles) {
        let savedArticleId = null;
        try {
            // 1. Validate & Skip Check
            if (!article?.url || !article?.title || !article?.description || article.description.length < 30) {
                stats.skipped_invalid++; continue;
            }
            const exists = await Article.findOne({ url: article.url }, { _id: 1 }).lean();
            if (exists) {
                stats.skipped_duplicate++; continue;
            }

            // 2. Analyze with Gemini
            console.log(`🤖 Analyzing components: ${article.title.substring(0, 50)}...`);
            const analysisResult = await geminiService.analyzeArticle(article); // Gets estimates
            const estimatedComponents = analysisResult.estimated_components;
            const isSentimentOnly = analysisResult.analysisType === 'SentimentOnly';

            // 3. CALCULATE FINAL SCORES
            const calculatedUCS = calculateUCS(estimatedComponents, isSentimentOnly);
            const calculatedURS = calculateURS(estimatedComponents, isSentimentOnly);
            const calculatedBiasScore = calculateBiasScore(estimatedComponents, isSentimentOnly);
            const calculatedTrustScore = calculateTrustScore(calculatedUCS, calculatedURS, isSentimentOnly);
            const { grade, trustLevel, ucsLevel, ursLevel } = getGradeAndLevel(calculatedUCS, calculatedURS);

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
              biasScore: calculatedBiasScore,
              credibilityScore: calculatedUCS, // Use calculated UCS
              reliabilityScore: calculatedURS, // Use calculated URS
              trustScore: calculatedTrustScore, // Use calculated OTS
              credibilityGrade: grade, // Use grade from matrix
              reliabilityGrade: ursLevel, // Store URS Level (e.g., High)
              trustLevel: trustLevel, // Use level from matrix
              biasLabel: determineBiasLabel(calculatedBiasScore),
              aiEstimates: { // Store the raw estimates
                  credibilityComponents: estimatedComponents?.credibility || {},
                  reliabilityComponents: estimatedComponents?.reliability || {},
                  biasComponents: estimatedComponents?.bias || {},
              },
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
            savedArticleId = savedArticle._id;
            stats.processed++;
            console.log(`✅ Saved [${savedArticleId}] (UCS:${calculatedUCS}, URS:${calculatedURS}, Bias:${calculatedBiasScore}, OTS:${calculatedTrustScore}, Grade:${grade}) ${savedArticle.headline.substring(0, 40)}...`);

            // --- DELAY FOR FREE TIER RATE LIMIT ---
            await sleep(31000); // Wait 31 seconds
            // ----------------------------------------

        } catch (error) {
            console.error(`❌ Error processing article "${article?.title?.substring(0,60)}...": ${error.message}`);
            stats.errors++;
            // Optional pauses after errors
            if (error.message.includes('429')) await sleep(60000);
            else if (error.message.includes('503')) await sleep(10000);
            else await sleep(1000);
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
  }
}

// --- Sleep Function ---
function sleep(ms) {
  if (ms > 0) console.log(`😴 Sleeping for ${ms / 1000} seconds...`);
  return new Promise(resolve => setTimeout(resolve, ms));
}


// --- Scheduled Tasks ---
cron.schedule('*/30 * * * *', () => { /* ... Unchanged ... */ });
cron.schedule('0 2 * * *', async () => { /* ... Unchanged ... */ });

// --- Error Handling & Server Startup ---
app.use((req, res, next) => { /* ... Unchanged ... */ }); // 404
app.use((err, req, res, next) => { /* ... Unchanged ... */ }); // Global Error Handler

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => { /* ... Unchanged ... */ });

// --- Graceful Shutdown ---
const gracefulShutdown = async (signal) => { /* ... Unchanged ... */ };
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
