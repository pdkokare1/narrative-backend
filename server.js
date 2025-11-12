// In file: server.js checking deployement
// --- FIX: Corrected syntax error in GET /api/profile/me catch block ---
// --- BUG FIX: Removed 31-second sleep() delay from fetchAndAnalyzeNews loop ---
// --- BUG FIX (2025-11-11): Corrected '5KA00' typo to '500' in log-share catch block ---
// --- FIX (2025-11-12): Added Adaptive Throttle for Gemini 429 errors ---
// --- *** FIX (2025-11-12 V5): Changed cron job to every 2 hours and kept 60s snail mode *** ---
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cron = require('node-cron');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// --- Import Firebase Admin ---
const admin = require('firebase-admin');

// --- Services ---
const geminiService = require('./services/geminiService');
const newsService = require('./services/newsService'); 

// --- Models ---
const Profile = require('./models/profileModel');
const ActivityLog = require('./models/activityLogModel');

// --- *** THIS IS THE FIX *** ---
// Helper function for adaptive throttling
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// --- *** END OF FIX *** ---

// --- Initialize Firebase Admin ---
try {
  // --- MODIFICATION: Read from Environment Variable ---
  // We check for the environment variable 'FIREBASE_SERVICE_ACCOUNT'
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable is not set.');
  }
  // We parse the variable, which will contain the JSON text
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  // --- END MODIFICATION ---

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase Admin SDK Initialized');
} catch (error) {
  console.error('❌ Firebase Admin Init Error:', error.message);
}
// --- END ---

const app = express();

// --- Middleware ---
app.set('trust proxy', 1); // Trust first proxy for rate limiting, etc.
app.use(helmet({ contentSecurityPolicy: false })); // Basic security headers
app.use(compression()); // Gzip compression
app.use(cors()); // Allow frontend requests
app.use(express.json({ limit: '1mb' })); // Parse JSON bodies

// --- Rate Limiter ---
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  message: { error: 'Too many requests from this IP, please try again after 15 minutes' },
  standardHeaders: true, 
  legacyHeaders: false, 
});
// --- Apply limiter to all API routes ---
app.use('/api/', apiLimiter); 

// --- Token Verification Middleware ---
const checkAuth = async (req, res, next) => {
  const token = req.headers.authorization?.split('Bearer ')[1]; // Get token

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  try {
    // Firebase Admin checks if the token is valid
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken; // Add user info to the request
    next(); // Token is valid, proceed
  } catch (error) {
    console.warn('⚠️ Auth Error:', error.code, error.message);
    return res.status(403).json({ error: 'Forbidden: Invalid or expired token' });
  }
};

// --- Apply token check to ALL OTHER API routes ---
app.use('/api/', checkAuth);
// --- *** ALL ROUTES BELOW THIS LINE ARE NOW PROTECTED *** ---


// --- *** MOVED THIS ENDPOINT *** ---
// POST /api/fetch-news - Trigger background news fetch (NOW PROTECTED)
// This endpoint is now *after* the checkAuth middleware
let isFetchRunning = false; // Simple lock
app.post('/api/fetch-news', (req, res) => {
  // We are now protected, but we still use the lock as a best practice
  if (isFetchRunning) {
    console.warn('⚠️ Manual fetch trigger ignored: Fetch already running.');
    return res.status(429).json({ message: 'Fetch process already running. Please wait.' });
  }
  console.log(`📰 Manual fetch triggered via API by user: ${req.user.uid}`);
  isFetchRunning = true;
  
  // --- *** THIS IS THE FIX *** ---
  // Reset the throttle state at the beginning of every new batch
  geminiService.isRateLimited = false;
  // --- *** END OF FIX *** ---

  // Respond to the user immediately
  res.status(202).json({ message: 'Fetch acknowledged. Analysis starting in background.', timestamp: new Date().toISOString() });

  // Run the fetch in the background
  fetchAndAnalyzeNews()
    .catch(err => { console.error('❌ FATAL Error during manually triggered fetch:', err.message); })
    .finally(() => {
        isFetchRunning = false;
        console.log('🟢 Manual fetch background process finished.');
     });
});


// --- USER PROFILE ROUTES (PROTECTED) ---

// GET /api/profile/me - Checks if a profile exists
app.get('/api/profile/me', async (req, res) => {
  try {
    // --- UPDATED: Also return the list of saved article IDs ---
    const profile = await Profile.findOne({ userId: req.user.uid })
      .select('username email articlesViewedCount comparisonsViewedCount articlesSharedCount savedArticles') // Specify fields
      .lean();

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.status(200).json(profile);
  } catch (error) { // <-- *** THIS IS THE FIX ***
    console.error('Error in GET /api/profile/me:', error.message);
    res.status(500).json({ error: 'Error fetching profile' });
  }
});

// POST /api/profile - Creates a new profile
app.post('/api/profile', async (req, res) => {
  try {
    const { username } = req.body;
    const { uid, email } = req.user; 

    if (!username || username.trim().length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }

    const cleanUsername = username.trim();

    // Check if username is already taken
    const existingUsername = await Profile.findOne({ username: cleanUsername }).lean();
    if (existingUsername) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    // Check if they already have a profile
    const existingProfile = await Profile.findOne({ userId: uid }).lean();
    if (existingProfile) {
      return res.status(409).json({ error: 'Profile already exists' });
    }

    // Create and save the new profile
    const newProfile = new Profile({
      userId: uid,
      email: email,
      username: cleanUsername,
    });

    await newProfile.save();
    res.status(201).json(newProfile); // Send back the new profile

  } catch (error) {
    console.error('Error in POST /api/profile:', error.message);
    if (error.code === 11000) {
      return res.status(409).json({ error: 'A profile for this user or email already exists.' });
    }
    res.status(500).json({ error: 'Error creating profile' });
  }
});

// --- USER ACTIVITY LOGGING (PROTECTED) ---

// POST /api/activity/log-view
app.post('/api/activity/log-view', async (req, res) => {
  try {
    const { articleId } = req.body;
    if (!articleId || !mongoose.Types.ObjectId.isValid(articleId)) {
      return res.status(400).json({ error: 'Valid articleId is required' });
    }

    await ActivityLog.create({
      userId: req.user.uid,
      articleId: articleId,
      action: 'view_analysis'
    });

    const updatedProfile = await Profile.findOneAndUpdate(
      { userId: req.user.uid }, 
      { $inc: { articlesViewedCount: 1 } }, 
      { new: true, upsert: true } 
    );

    res.status(200).json({
      message: 'Activity logged',
      articlesViewedCount: updatedProfile.articlesViewedCount
    });
  } catch (error) {
    console.error('Error in POST /api/activity/log-view:', error.message);
    res.status(500).json({ error: 'Error logging activity' });
  }
});

// POST /api/activity/log-compare
app.post('/api/activity/log-compare', async (req, res) => {
  try {
    const { articleId } = req.body; 
    if (!articleId || !mongoose.Types.ObjectId.isValid(articleId)) {
      return res.status(400).json({ error: 'Valid articleId is required' });
    }

    await ActivityLog.create({
      userId: req.user.uid,
      articleId: articleId,
      action: 'view_comparison'
    });

    const updatedProfile = await Profile.findOneAndUpdate(
      { userId: req.user.uid },
      { $inc: { comparisonsViewedCount: 1 } }, 
      { new: true, upsert: true }
    );

    res.status(200).json({
      message: 'Compare activity logged',
      comparisonsViewedCount: updatedProfile.comparisonsViewedCount
    });
  } catch (error) {
    console.error('Error in POST /api/activity/log-compare:', error.message);
    res.status(500).json({ error: 'Error logging activity' });
  }
});

// POST /api/activity/log-share
app.post('/api/activity/log-share', async (req, res) => {
  try {
    const { articleId } = req.body;
    if (!articleId || !mongoose.Types.ObjectId.isValid(articleId)) {
      return res.status(400).json({ error: 'Valid articleId is required' });
    }

    await ActivityLog.create({
      userId: req.user.uid,
      articleId: articleId,
      action: 'share_article'
    });

    const updatedProfile = await Profile.findOneAndUpdate(
      { userId: req.user.uid },
      { $inc: { articlesSharedCount: 1 } }, 
      { new: true, upsert: true }
    );

    res.status(200).json({
      message: 'Share activity logged',
      articlesSharedCount: updatedProfile.articlesSharedCount
    });
  } catch (error) {
    console.error('Error in POST /api/activity/log-share:', error.message);
    // --- THIS IS THE FIX ---
    res.status(500).json({ error: 'Error logging activity' });
    // --- END OF FIX ---
  }
});

// POST /api/activity/log-read
app.post('/api/activity/log-read', async (req, res) => {
  try {
    const { articleId } = req.body;
    if (!articleId || !mongoose.Types.ObjectId.isValid(articleId)) {
      return res.status(400).json({ error: 'Valid articleId is required' });
    }

    await ActivityLog.create({
      userId: req.user.uid,
      articleId: articleId,
      action: 'read_external'
    });

    res.status(200).json({
      message: 'Read activity logged'
    });
  } catch (error) {
    console.error('Error in POST /api/activity/log-read:', error.message);
    res.status(500).json({ error: 'Error logging activity' });
  }
});


// --- USER STATS ENDPOINT (PROTECTED) ---
// GET /api/profile/stats - Fetch ALL aggregated stats for a user
app.get('/api/profile/stats', async (req, res) => {
  try {
    const userId = req.user.uid;
    
    // We are fetching ALL-TIME stats.
    const stats = await ActivityLog.aggregate([
      // 1. Filter logs for the current user
      {
        $match: {
          userId: userId
        }
      },
      // 2. Lookup the article details for each log
      {
        $lookup: {
          from: 'articles', // The name of the articles collection
          localField: 'articleId',
          foreignField: '_id',
          as: 'articleDetails'
        }
      },
      // 3. Deconstruct the articleDetails array
      {
        $unwind: {
          path: '$articleDetails',
          preserveNullAndEmptyArrays: true // Keep logs even if article was deleted
        }
      },
      // 4. Group by multiple criteria
      {
        $facet: {
          // --- Calculate daily counts (for 'view_analysis') ---
          dailyCounts: [
            { $match: { action: 'view_analysis' } },
            {
              $group: {
                _id: {
                  $dateToString: { format: '%Y-%m-%d', date: '$timestamp', timezone: 'UTC' }
                },
                count: { $sum: 1 }
              }
            },
            { $sort: { '_id': 1 } },
            { $project: { _id: 0, date: '$_id', count: 1 } }
          ],

          // --- Calculate political lean distribution (for 'view_analysis') ---
          leanDistribution_read: [
             {
               $match: { 
                 'action': 'view_analysis',
                 'articleDetails.politicalLean': { $exists: true } 
                }
             },
            {
              $group: {
                _id: '$articleDetails.politicalLean',
                count: { $sum: 1 }
              }
            },
            { $project: { _id: 0, lean: '$_id', count: 1 } }
          ],
                    
          // --- Calculate political lean distribution (for 'share_article') ---
          leanDistribution_shared: [
             {
               $match: { 
                 'action': 'share_article',
                 'articleDetails.politicalLean': { $exists: true } 
                }
             },
            {
              $group: {
                _id: '$articleDetails.politicalLean',
                count: { $sum: 1 }
              }
            },
            { $project: { _id: 0, lean: '$_id', count: 1 } }
          ],

          // --- Calculate Category distribution (for 'view_analysis') ---
          categoryDistribution_read: [
             {
               $match: { 
                 'action': 'view_analysis',
                 'articleDetails.category': { $exists: true } 
                }
             },
            {
              $group: {
                _id: '$articleDetails.category',
                count: { $sum: 1 }
              }
            },
             { $sort: { count: -1 } }, 
             { $limit: 10 }, // --- ADDED: Get Top 10
            { $project: { _id: 0, category: '$_id', count: 1 } }
          ],
          
          // --- Calculate Quality distribution (for 'view_analysis') ---
          qualityDistribution_read: [
             {
               $match: { 
                 'action': 'view_analysis',
                 'articleDetails.credibilityGrade': { $exists: true } // Keep nulls (Reviews)
                }
             },
            {
              $group: {
                // Group by grade. Nulls will be grouped as 'null'
                _id: '$articleDetails.credibilityGrade',
                count: { $sum: 1 }
              }
            },
            { $project: { _id: 0, grade: '$_id', count: 1 } }
          ],

          // --- Calculate Total Counts for all actions ---
          totalCounts: [
            {
              $group: {
                _id: '$action', // Group by action type
                count: { $sum: 1 }
              }
            },
            { $project: { _id: 0, action: '$_id', count: 1 } }
          ],

          // --- Top Sources (Analyzed) ---
          topSources_read: [
            {
              $match: {
                'action': 'view_analysis',
                'articleDetails.source': { $exists: true, $ne: null }
              }
            },
            {
              $group: {
                _id: '$articleDetails.source',
                count: { $sum: 1 }
              }
            },
            { $sort: { count: -1 } },
            { $limit: 10 }, // Get Top 10 sources
            { $project: { _id: 0, source: '$_id', count: 1 } }
          ],
          
          // --- Sentiment Breakdown (Analyzed) ---
          sentimentDistribution_read: [
            {
              $match: {
                'action': 'view_analysis',
                'articleDetails.sentiment': { $exists: true, $ne: null }
              }
            },
            {
              $group: {
                _id: '$articleDetails.sentiment',
                count: { $sum: 1 }
              }
            },
            { $project: { _id: 0, sentiment: '$_id', count: 1 } }
          ]
        }
      }
    ]);

    // Format the results
    const results = {
      timeframeDays: 'All Time',
      dailyCounts: stats[0]?.dailyCounts || [],
      leanDistribution_read: stats[0]?.leanDistribution_read || [],
      leanDistribution_shared: stats[0]?.leanDistribution_shared || [],
      categoryDistribution_read: stats[0]?.categoryDistribution_read || [],
      qualityDistribution_read: stats[0]?.qualityDistribution_read || [],
      totalCounts: stats[0]?.totalCounts || [],
      topSources_read: stats[0]?.topSources_read || [],
      sentimentDistribution_read: stats[0]?.sentimentDistribution_read || []
    };

    res.status(200).json(results);

  } catch (error) {
    console.error('Error in GET /api/profile/stats:', error.message);
    res.status(500).json({ error: 'Error fetching profile statistics' });
  }
});

// --- END OF USER ROUTES ---


// --- Database Connection ---
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err.message));

mongoose.connection.on('error', err => {
  console.error('❌ MongoDB runtime error:', err.message);
});
mongoose.connection.on('disconnected', () => {
  console.warn('⚠️ MongoDB disconnected.');
});

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
  biasScore: { type: Number, default: 0, min: 0, max: 100 },
  biasLabel: String,
  biasComponents: mongoose.Schema.Types.Mixed,
  credibilityScore: { type: Number, default: 0, min: 0, max: 100 },
  credibilityGrade: String,
  credibilityComponents: mongoose.Schema.Types.Mixed,
  reliabilityScore: { type: Number, default: 0, min: 0, max: 100 },
  reliabilityGrade: String,
  reliabilityComponents: mongoose.Schema.Types.Mixed,
  trustScore: { type: Number, default: 0, min: 0, max: 100 },
  trustLevel: String,
  coverageLeft: { type: Number, default: 0 },
  coverageCenter: { type: Number, default: 0 },
  coverageRight: { type: Number, default: 0 },
  clusterId: { type: Number, index: true },
  clusterTopic: { type: String, index: true, trim: true }, 
  country: { type: String, index: true, trim: true, default: 'Global' }, 
  // --- NEW FIELDS FOR 5-FIELD CLUSTERING ---
  primaryNoun: { type: String, index: true, trim: true, default: null },
  secondaryNoun: { type: String, index: true, trim: true, default: null },
  // --- END NEW FIELDS ---
  keyFindings: [String],
  recommendations: [String],
  analysisVersion: { type: String, default: '2.14' } // Version bump
}, {
  timestamps: true, // Adds createdAt and updatedAt
  autoIndex: process.env.NODE_ENV !== 'production',
});

// Compound Indexes
articleSchema.index({ category: 1, publishedAt: -1 });
articleSchema.index({ politicalLean: 1, publishedAt: -1 });
articleSchema.index({ clusterId: 1, trustScore: -1 });
articleSchema.index({ trustScore: -1, publishedAt: -1 });
articleSchema.index({ biasScore: 1, publishedAt: -1 });
articleSchema.index({ createdAt: 1 }); // For cleanup
articleSchema.index({ analysisType: 1, publishedAt: -1 });
articleSchema.index({ headline: 1, source: 1, publishedAt: -1 });
// --- UPDATED 5-PART CLUSTER INDEX ---
articleSchema.index({ clusterTopic: 1, category: 1, country: 1, primaryNoun: 1, secondaryNoun: 1, publishedAt: -1 }, {
  name: "5_Field_Cluster_Index"
});
// --- NEW: REGION/TYPE FILTER INDEX ---
articleSchema.index({ country: 1, analysisType: 1, publishedAt: -1 });


const Article = mongoose.model('Article', articleSchema);

// --- API Routes ---

// GET / - Health Check (NOT protected)
app.get('/', (req, res) => {
  res.status(200).json({
    message: `The Gamut API v${Article.schema.path('analysisVersion').defaultValue} - Running`,
    status: 'healthy',
    features: [
      '5-Field Smart Clustering (Topic, Category, Country, Nouns)',
      '7-Day Cluster Window',
      'Smart Feed De-duplication w/ Cluster Count',
      'Region & Article Type Filters'
    ],
    timestamp: new Date().toISOString(),
    uptime: process.uptime ? Math.floor(process.uptime()) : 'N/A'
  });
});

// --- SMART FEED ENDPOINT (PROTECTED) ---
// GET /api/articles - Fetch articles
app.get('/api/articles', async (req, res, next) => {
  try {
    // --- Parse and Validate Filters ---
    const filters = {
      category: req.query.category && req.query.category !== 'All Categories' ? String(req.query.category) : null,
      lean: req.query.lean && req.query.lean !== 'All Leans' ? String(req.query.lean) : null,
      quality: req.query.quality && req.query.quality !== 'All Quality Levels' ? String(req.query.quality) : null,
      sort: String(req.query.sort || 'Latest First'),
      limit: Math.min(Math.max(parseInt(req.query.limit) || 12, 1), 50), // Clamp limit 1-50
      offset: Math.max(parseInt(req.query.offset) || 0, 0),
      region: req.query.region && req.query.region !== 'All' ? String(req.query.region) : null,
      articleType: req.query.articleType && req.query.articleType !== 'All Types' ? String(req.query.articleType) : null,
    };

    // --- 1. Build the $match (Filter) stage ---
    const matchStage = {};
    if (filters.category) matchStage.category = filters.category;
    if (filters.lean) matchStage.politicalLean = filters.lean;
    // --- UPDATED: Region filter now uses 'country' field ---
    if (filters.region) matchStage.country = filters.region; 
    
    // Article Type Filter
    if (filters.articleType === 'Hard News') {
      matchStage.analysisType = 'Full';
    } else if (filters.articleType === 'Opinion & Reviews') {
      matchStage.analysisType = 'SentimentOnly';
    }
    
    // Quality Filter (now only applies if Hard News is selected or implied)
    if (filters.quality && matchStage.analysisType !== 'SentimentOnly') {
        matchStage.analysisType = 'Full'; // Ensure we are only looking at 'Full'
        matchStage.trustScore = matchStage.trustScore || {};
        const rangeMatch = filters.quality.match(/(\d+)-(\d+)/);
        if (rangeMatch) {
            matchStage.trustScore.$gte = parseInt(rangeMatch[1]);
            matchStage.trustScore.$lt = parseInt(rangeMatch[2]) + 1;
        } else if (filters.quality.includes('0-59')) {
             matchStage.trustScore = { $lt: 60 };
        }
    }

    // --- 2. Build the $sort (Sorting) stage ---
    let sortStage = { publishedAt: -1, createdAt: -1 }; 
    let postGroupSortStage = { "latestArticle.publishedAt": -1, "latestArticle.createdAt": -1 }; 
    
    switch(filters.sort) {
        case 'Highest Quality': 
            sortStage = { trustScore: -1, publishedAt: -1 }; 
            postGroupSortStage = { "latestArticle.trustScore": -1, "latestArticle.publishedAt": -1 };
            break;
        case 'Most Covered': 
            postGroupSortStage = { clusterCount: -1, "latestArticle.publishedAt": -1 };
            break;
        case 'Lowest Bias': 
            sortStage = { biasScore: 1, publishedAt: -1 }; 
            postGroupSortStage = { "latestArticle.biasScore": 1, "latestArticle.publishedAt": -1 };
            break;
    }

    // --- 3. Build the Aggregation Pipeline ---
    const aggregation = [
      // Stage 1: Filter articles based on sidebar filters
      { $match: matchStage },
      
      // Stage 2: Sort by the chosen criteria to find the "best" or "newest"
      { $sort: sortStage },

      // Stage 3: Group by clusterId to de-duplicate
      {
        $group: {
          // --- THIS IS THE FIX ---
          // Group by clusterId, OR by the article's unique _id if clusterId is null
          _id: { $ifNull: [ "$clusterId", "$_id" ] }, 
          // --- END OF FIX ---
          latestArticle: { $first: '$$ROOT' }, // Get the *first* article
          clusterCount: { $sum: 1 } // Count how many articles are in this group
        }
      },

      // Stage 4: Add the clusterCount to the article object
      {
        $addFields: {
          "latestArticle.clusterCount": "$clusterCount"
        }
      },

      // Stage 5: Replace the root with our de-duplicated article
      { $replaceRoot: { newRoot: '$latestArticle' } },
      
      // Stage 6: Sort the *final list* of de-duplicated articles
      { $sort: postGroupSortStage },

      // Stage 7: Handle Pagination (must be last)
      {
        $facet: {
          articles: [
            { $skip: filters.offset },
            { $limit: filters.limit }
          ],
          pagination: [
            { $count: 'total' }
          ]
        }
      }
    ];

    // --- 4. Execute the Query ---
    const results = await Article.aggregate(aggregation).allowDiskUse(true);

    const articles = results[0]?.articles || [];
    const total = results[0]?.pagination[0]?.total || 0;

    res.status(200).json({
      articles,
      pagination: { total, limit: filters.limit, offset: filters.offset, hasMore: (filters.offset + articles.length) < total }
    });

  } catch (error) {
    console.error('❌ Error in GET /api/articles:', error.message);
    next(error);
  }
});
// --- *** END OF SMART FEED ENDPOINT *** ---


// --- *** NEW: SAVE/UNSAVE ARTICLE ROUTE *** ---
app.post('/api/articles/:id/save', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { uid } = req.user;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid article ID' });
    }

    const article = await Article.findById(id, '_id').lean();
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }

    const profile = await Profile.findOne({ userId: uid });
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    const articleObjectId = new mongoose.Types.ObjectId(id);
    const isSaved = profile.savedArticles.includes(articleObjectId);

    let updatedProfile;
    if (isSaved) {
      // --- Unsave it ---
      updatedProfile = await Profile.findOneAndUpdate(
        { userId: uid },
        { $pull: { savedArticles: articleObjectId } },
        { new: true }
      ).lean();
    } else {
      // --- Save it ---
      updatedProfile = await Profile.findOneAndUpdate(
        { userId: uid },
        { $addToSet: { savedArticles: articleObjectId } }, // $addToSet prevents duplicates
        { new: true }
      ).lean();
    }

    res.status(200).json({ 
      message: isSaved ? 'Article unsaved' : 'Article saved',
      savedArticles: updatedProfile.savedArticles // Send back the updated list of IDs
    });

  } catch (error) {
    console.error(`❌ Error in POST /api/articles/${req.params.id}/save:`, error.message);
    next(error);
  }
});

// --- *** NEW: GET SAVED ARTICLES ROUTE ---
app.get('/api/articles/saved', async (req, res, next) => {
  try {
    const { uid } = req.user;
    
    // 1. Find the user's profile and get their savedArticles array
    const profile = await Profile.findOne({ userId: uid })
      .select('savedArticles')
      .populate({
        path: 'savedArticles', // 2. Populate the array with full article data
        options: { sort: { publishedAt: -1 } } // 3. Sort by newest
      })
      .lean();

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    
    // The 'savedArticles' field now contains the full article objects
    res.status(200).json({ articles: profile.savedArticles || [] });

  } catch (error) {
    console.error('❌ Error in GET /api/articles/saved:', error.message);
    next(error);
  }
});


// GET /api/articles/:id - Fetch single article (PROTECTED)
app.get('/api/articles/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid article ID format' });
    }
    const article = await Article.findById(id).lean();
    if (!article) return res.status(404).json({ error: 'Article not found' });
    res.status(200).json(article);
  } catch (error) {
    console.error(`❌ Error in GET /api/articles/${req.params.id}:`, error.message);
    next(error);
  }
});

// GET /api/cluster/:clusterId - Fetch cluster data (PROTECTED)
app.get('/api/cluster/:clusterId', async (req, res, next) => {
  try {
    const clusterIdNum = parseInt(req.params.clusterId);
    if (isNaN(clusterIdNum)) return res.status(400).json({ error: 'Invalid cluster ID' });

    // --- UPDATED: Now fetches ALL articles in cluster ---
    const articles = await Article.find({ clusterId: clusterIdNum })
      .sort({ trustScore: -1, publishedAt: -1 })
      .lean();

    const grouped = articles.reduce((acc, article) => {
      const lean = article.politicalLean;
      if (['Left', 'Left-Leaning'].includes(lean)) acc.left.push(article);
      else if (lean === 'Center') acc.center.push(article);
      else if (['Right-Leaning', 'Right'].includes(lean)) acc.right.push(article);
      else if (lean === 'Not Applicable') acc.reviews.push(article);
      return acc;
    }, { left: [], center: [], right: [], reviews: [] }); 

    const totalArticles = articles.length;
    const fullAnalysisArticles = articles.filter(a => a.analysisType === 'Full');
    const fullCount = fullAnalysisArticles.length;
    
    const calculateAverage = (field) => fullCount > 0
      ? Math.round(fullAnalysisArticles.reduce((sum, a) => sum + (a[field] || 0), 0) / fullCount)
      : 0;
      
    const stats = {
      totalArticles, 
      leftCount: grouped.left.length, 
      centerCount: grouped.center.length, 
      rightCount: grouped.right.length,
      reviewCount: grouped.reviews.length, 
      averageBias: calculateAverage('biasScore'), 
      averageTrust: calculateAverage('trustScore')
    };

    res.status(200).json({ ...grouped, stats });
  } catch (error) {
    console.error(`❌ Error in GET /api/cluster/${req.params.clusterId}:`, error.message);
    next(error);
  }
});

// GET /api/stats - Fetch overall stats (PROTECTED)
app.get('/api/stats', async (req, res, next) => {
  try {
    const [statsData, leanDistribution, categoryDistribution] = await Promise.all([
        Article.aggregate([
            { $facet: {
                totalArticles: [{ $count: "count" }],
                sources: [{ $match: { source: { $ne: null }}}, { $group: { _id: "$source" } }, { $count: "count" }], 
                categories: [{ $match: { category: { $ne: null }}}, { $group: { _id: "$category" } }, { $count: "count" }],
                avgBiasResult: [ { $match: { analysisType: 'Full', biasScore: { $exists: true } } }, { $group: { _id: null, avg: { $avg: '$biasScore' } } } ],
                avgTrustResult: [ { $match: { analysisType: 'Full', trustScore: { $exists: true } } }, { $group: { _id: null, avg: { $avg: '$trustScore' } } } ]
            }}
        ]).allowDiskUse(true),
        Article.aggregate([ { $match: { analysisType: 'Full' } }, { $group: { _id: '$politicalLean', count: { $sum: 1 } } }, { $sort: { count: -1 } } ]).allowDiskUse(true),
        Article.aggregate([ { $group: { _id: '$category', count: { $sum: 1 } } }, { $sort: { count: -1 } } ]).allowDiskUse(true),
    ]);

    const results = statsData[0] || {}; 
    const formatDistribution = (dist) => dist.reduce((acc, item) => { acc[item._id || 'Unknown'] = item.count; return acc; }, {});

    res.status(200).json({
      totalArticles: results.totalArticles?.[0]?.count || 0,
      totalSources: results.sources?.[0]?.count || 0,
      totalCategories: results.categories?.[0]?.count || 0,
      averageBias: Math.round(results.avgBiasResult?.[0]?.avg || 0),
      averageTrust: Math.round(results.avgTrustResult?.[0]?.avg || 0),
      leanDistribution: formatDistribution(leanDistribution),
      categoryDistribution: formatDistribution(categoryDistribution),
      lastUpdated: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error in GET /api/stats:', error.message);
    next(error);
  }
});

// GET /api/stats/keys - Fetch API key usage stats (PROTECTED)
app.get('/api/stats/keys', (req, res, next) => {
  try {
    const geminiStats = geminiService.getStatistics ? geminiService.getStatistics() : { error: "Stats unavailable" };
    const newsStats = newsService.getStatistics ? newsService.getStatistics() : { error: "Stats unavailable" };
    res.status(200).json({ gemini: geminiStats, news: newsStats, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('❌ Error in GET /api/stats/keys:', error.message);
    next(error);
  }
});


// --- Core Fetch/Analyze Function ---
async function fetchAndAnalyzeNews() {
  console.log('🔄 Starting fetchAndAnalyzeNews cycle...');
  const stats = { fetched: 0, processed: 0, skipped_duplicate: 0, skipped_invalid: 0, skipped_junk: 0, errors: 0, start_time: Date.now() };

  try {
    const rawArticles = await newsService.fetchNews(); 
    stats.fetched = rawArticles.length;
    console.log(`📰 Fetched ${stats.fetched} raw articles.`);
    if (stats.fetched === 0) {
      console.log("🏁 No articles fetched, ending cycle.");
      return stats;
    }

    // Process articles sequentially
    for (const article of rawArticles) {
        try {
            // 1. Validate Structure
            if (!article?.url || !article?.title || !article?.description || article.description.length < 30) {
                stats.skipped_invalid++;
                continue;
            }

            // 2. Check Duplicates (ADVANCED)
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const exists = await Article.findOne({
              $or: [
                { url: article.url },
                {
                  headline: article.title,
                  source: article.source?.name,
                  publishedAt: { $gte: oneDayAgo }
                }
              ]
            }, { _id: 1 }).lean();

            if (exists) {
                stats.skipped_duplicate++;
                continue;
            }

            // 3. Analyze with Gemini
            console.log(`🤖 Analyzing: ${article.title.substring(0, 60)}...`);
            const analysis = await geminiService.analyzeArticle(article);

            // 3.5. Check for Junk Articles
            if (analysis.isJunk) {
                stats.skipped_junk++;
                console.log(`🚮 Skipping junk/ad: ${article.title.substring(0, 50)}...`);
                continue;
            }
            
            // --- 4. Prepare Data (with defaults and validation) ---
            const newArticleData = {
              headline: article.title,
              summary: analysis.summary || 'Summary unavailable',
              source: article.source?.name || 'Unknown Source',
              category: analysis.category || 'General',
              politicalLean: analysis.politicalLean, // Already defaulted by parser
              url: article.url,
              imageUrl: article.urlToImage,
              publishedAt: article.publishedAt ? new Date(article.publishedAt) : new Date(),
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
              clusterId: null, // Will be set below
              clusterTopic: analysis.clusterTopic,
              country: analysis.country, // --- Save 'USA', 'India', or 'Global'
              // --- SAVE NEW FIELDS ---
              primaryNoun: analysis.primaryNoun,
              secondaryNoun: analysis.secondaryNoun,
              // --- END ---
              keyFindings: analysis.keyFindings || [],
              recommendations: analysis.recommendations || [],
              analysisVersion: Article.schema.path('analysisVersion').defaultValue
            };
            
            // --- 4.5. Handle Smart Clustering (5-FIELD LOGIC) ---
            if (newArticleData.clusterTopic) {
                // --- Use 7-day window ---
                const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
                
                // --- Find cluster matching ALL 5 keys ---
                const existingCluster = await Article.findOne({
                    clusterTopic: newArticleData.clusterTopic,
                    category: newArticleData.category,
                    country: newArticleData.country,
                    primaryNoun: newArticleData.primaryNoun,
                    secondaryNoun: newArticleData.secondaryNoun,
                    publishedAt: { $gte: sevenDaysAgo } // Look in last 7 days
                }, { clusterId: 1 }).sort({ publishedAt: -1 }).lean();

                if (existingCluster && existingCluster.clusterId) {
                    newArticleData.clusterId = existingCluster.clusterId;
                } else {
                    // This is a new topic, find the max clusterId and add 1
                    const maxIdDoc = await Article.findOne({}).sort({ clusterId: -1 }).select({ clusterId: 1 }).lean();
                    newArticleData.clusterId = (maxIdDoc?.clusterId || 0) + 1;
                    console.log(`Assigning NEW clusterId [${newArticleData.clusterId}] for topic: "${newArticleData.clusterTopic}"`);
                }
            } else {
                // --- THIS IS THE FIX ---
                // This article has no cluster topic (e.g., Opinion), assign a new unique ID
                const maxIdDoc = await Article.findOne({}).sort({ clusterId: -1 }).select({ clusterId: 1 }).lean();
                newArticleData.clusterId = (maxIdDoc?.clusterId || 0) + 1;
                // --- END OF FIX ---
            }
            // (End Clustering Logic)

            // 5. Save to DB
            const savedArticle = await Article.create(newArticleData);
            stats.processed++;
            console.log(`✅ Saved [${savedArticle._id}]: ${savedArticle.headline.substring(0, 50)}... (${savedArticle.analysisType})`);

            // --- THIS IS THE FIX: The 31-second delay block was REMOVED ---

        } catch (error) {
            // Log errors during individual article processing but continue the loop
            console.error(`❌ Error processing article "${article?.title?.substring(0,60)}...": ${error.message}`);
            stats.errors++;
        }
        
        // --- *** THIS IS THE FIX (V4 - Smart Pause) *** ---
        // We now check the 'isRateLimited' flag from the geminiService.
        if (geminiService.isRateLimited) {
          // If we are rate limited, pause for 60 seconds to let the quota fully recover.
          console.log('...Snail Mode Active 🐌... pausing for 60s to let quota recover...');
          await sleep(60000); // 60-second (60000ms) "cooldown" pause
        } else {
          // If all is good, pause for 3 seconds to stay under the limit.
          console.log('...pausing for 3s to respect free tier rate limit...');
          await sleep(3000); // 3-second (3000ms) "normal" pause
        }
        // --- *** END OF FIX *** ---

    } // End loop

    stats.end_time = Date.now();
    const duration = ((stats.end_time - stats.start_time) / 1000).toFixed(2);
    console.log(`\n🏁 Fetch cycle finished in ${duration}s: ${stats.processed} processed, ${stats.skipped_duplicate} duplicate(s), ${stats.skipped_junk} junk, ${stats.skipped_invalid} invalid, ${stats.errors} error(s).\n`);
    return stats;

  } catch (error) { // Catch critical errors during the initial news fetch stage
    console.error('❌ CRITICAL Error during news fetch stage:', error.message);
    stats.errors++;
    stats.end_time = Date.now();
    const duration = ((stats.end_time - stats.start_time) / 1000).toFixed(2);
    console.log(`\n⚠️ Fetch cycle aborted after ${duration}s due to fetch error. Stats: ${JSON.stringify(stats)}`);
    // Allow process to end without throwing if run by cron
  }
}

// --- THIS IS THE FIX: The sleep() function was REMOVED from here ---

// --- Scheduled Tasks ---

// --- *** THIS IS THE FIX: Changed from '*/30 * * * *' (every 30 mins) to '0 */2 * * *' (every 2 hours) *** ---
cron.schedule('0 */2 * * *', () => {
  if (isFetchRunning) {
    console.log('⏰ Cron: Skipping scheduled fetch - previous job still active.');
    return;
  }
  console.log('⏰ Cron: Triggering scheduled news fetch (every 2 hours)...');
  isFetchRunning = true;

  // --- *** THIS IS THE FIX *** ---
  // Reset the throttle state at the beginning of every new batch
  geminiService.isRateLimited = false;
  // --- *** END OF FIX *** ---

  fetchAndAnalyzeNews()
    .catch(err => { console.error('❌ CRITICAL Error during scheduled fetch:', err.message); })
    .finally(() => { // --- THIS IS THE FIX ---
        isFetchRunning = false; 
        console.log('🟢 Scheduled fetch process complete.');
     });
});

// Auto-cleanup daily at 2 AM server time
cron.schedule('0 2 * * *', async () => {
  console.log('🧹 Cron: Triggering daily article cleanup...');
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // Limit deletion batch size for safety and performance
    const result = await Article.deleteMany({ createdAt: { $lt: sevenDaysAgo } }).limit(5000);
    console.log(`🗑️ Cleanup successful: Deleted ${result.deletedCount} articles older than 7 days (batch limit 5000).`);
  } catch (error) {
    console.error('❌ CRITICAL Error during scheduled cleanup:', error.message);
  }
});

// --- Error Handling & Server Startup ---

// 404 Handler for undefined routes
app.use((req, res, next) => {
  res.status(404).json({ error: `Not Found - Cannot ${req.method} ${req.originalUrl}` });
});

// Global Error Handler (must be the LAST middleware)
app.use((err, req, res, next) => {
  console.error('💥 Global Error Handler:', err);
  const statusCode = err.status || err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' ? 'An unexpected error occurred.' : err.message;
  res.status(statusCode).json({
    error: {
      message: message,
    }
  });
});

const PORT = process.env.PORT || 3001; 
const HOST = process.env.HOST || '0.0.0.0'; 

// Start Server
app.listen(PORT, HOST, () => {
  console.log(`\n🚀 Server listening on host ${HOST}, port ${PORT}`);
  console.log(`🔗 Health Check: http://localhost:${PORT}/`);
  console.log(`API available at /api`);
  console.log(`🕒 News fetch scheduled: Every 2 hours`);
  console.log(`🗑️ Cleanup scheduled: Daily at 2 AM`);
});

// --- Graceful Shutdown ---
const gracefulShutdown = async (signal) => {
  console.log(`\n👋 ${signal} received. Initiating graceful shutdown...`);
  try {
    console.log('🔌 Closing MongoDB connection...');
    await mongoose.connection.close();
    console.log('💾 MongoDB connection closed.');
    console.log('✅ Shutdown complete.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error during graceful shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
