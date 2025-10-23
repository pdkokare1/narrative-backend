const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cron = require('node-cron');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// --- Services are imported at the top ---
const geminiService = require('./services/geminiService');
const newsService = require('./services/newsService');

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', limiter);

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB error:', err));

// --- UPDATED SCHEMA ---
const articleSchema = new mongoose.Schema({
  headline: { type: String, required: true },
  summary: { type: String, required: true },
  source: { type: String, required: true },
  category: { type: String, required: true },
  politicalLean: { type: String, required: true },
  url: { type: String, required: true, unique: true },
  imageUrl: String,
  publishedAt: Date,
  
  // NEW: Added fields for new features
  analysisType: { type: String, default: 'Full', enum: ['Full', 'SentimentOnly'] },
  sentiment: { type: String, default: 'Neutral', enum: ['Positive', 'Negative', 'Neutral'] },
  
  // CHANGED: Removed 'required: true' and added 'default: 0'
  biasScore: { type: Number, default: 0 },
  biasLabel: String,
  
  biasComponents: {
    linguistic: {
      sentimentPolarity: Number,
      emotionalLanguage: Number,
      loadedTerms: Number,
      complexityBias: Number
    },
    sourceSelection: {
      sourceDiversity: Number,
      expertBalance: Number,
      attributionTransparency: Number
    },
    demographic: {
      genderBalance: Number,
      racialBalance: Number,
      ageRepresentation: Number
    },
    framing: {
      headlineFraming: Number,
      storySelection: Number,
      omissionBias: Number
    }
  },
  
  credibilityScore: { type: Number, default: 0 },
  credibilityGrade: String,
  credibilityComponents: {
    sourceCredibility: Number,
    factVerification: Number,
    professionalism: Number,
    evidenceQuality: Number,
    transparency: Number,
    audienceTrust: Number
  },
  
  reliabilityScore: { type: Number, default: 0 },
  reliabilityGrade: String,
  reliabilityComponents: {
    consistency: Number,
    temporalStability: Number,
    qualityControl: Number,
    publicationStandards: Number,
    correctionsPolicy: Number,
    updateMaintenance: Number
  },
  
  trustScore: { type: Number, default: 0 },
  trustLevel: String,
  
  coverageLeft: Number,
  coverageCenter: Number,
  coverageRight: Number,
  clusterId: Number,
  
  keyFindings: [String],
  recommendations: [String],
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  analysisVersion: { type: String, default: '2.1' } // Version bump
});
// --- END OF UPDATED SCHEMA ---

articleSchema.index({ category: 1, createdAt: -1 });
articleSchema.index({ politicalLean: 1 });
articleSchema.index({ clusterId: 1 });
articleSchema.index({ trustScore: -1 });
articleSchema.index({ biasScore: 1 });

const Article = mongoose.model('Article', articleSchema);

app.get('/', (req, res) => {
  res.json({
    message: 'The Narrative API v2.1 - Production Ready',
    status: 'healthy',
    features: [
      'Enhanced Bias Detection (30+ parameters)',
      'Complete Credibility Scoring (6 components)',
      'Complete Reliability Scoring (6 components)',
      'Trust Score Calculation',
      'Sentiment Analysis (Positive/Negative/Neutral)',
      'Analysis Type (Full vs. SentimentOnly reviews)',
      'Story Clustering',
      'Advanced Filtering',
      'Auto-refresh every 6 hours'
    ],
    timestamp: new Date(),
    uptime: Math.floor(process.uptime())
  });
});

app.get('/api/articles', async (req, res) => {
  try {
    const { 
      category, 
      lean, 
      quality,
      minTrust,
      maxBias,
      sort, 
      limit = 100, // Corrected default limit
      offset = 0
    } = req.query;
    
    let query = {};
    
    if (category && category !== 'All Categories') {
      query.category = category;
    }
    
    if (lean && lean !== 'All Leans') {
      query.politicalLean = lean;
    }
    
    // This filter will now correctly exclude 'SentimentOnly' articles 
    // (since their trustScore is 0) unless 'All Quality' is selected.
    if (quality && quality !== 'All Quality Levels') {
      if (quality.includes('90-100')) {
        query.trustScore = { $gte: 90 };
      } else if (quality.includes('80-89')) {
        query.trustScore = { $gte: 80, $lt: 90 };
      } else if (quality.includes('70-79')) {
        query.trustScore = { $gte: 70, $lt: 80 };
      } else if (quality.includes('60-69')) {
        query.trustScore = { $gte: 60, $lt: 70 };
      } else if (quality.includes('0-59')) {
        query.trustScore = { $lt: 60 };
      }
    }
    
    if (minTrust) {
      query.trustScore = { $gte: parseInt(minTrust) };
    }
    
    if (maxBias) {
      query.biasScore = { $lte: parseInt(maxBias) };
    }
    
    let sortOption = { createdAt: -1 };
    
    if (sort === 'Highest Quality') {
      sortOption = { trustScore: -1, credibilityScore: -1 };
    } else if (sort === 'Most Covered') {
      sortOption = { clusterId: 1, createdAt: -1 };
    } else if (sort === 'Lowest Bias') {
      sortOption = { biasScore: 1 };
    }
    
    const articles = await Article.find(query)
      .sort(sortOption)
      .limit(parseInt(limit))
      .skip(parseInt(offset));
    
    const total = await Article.countDocuments(query);
    
    res.json({
      articles,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        hasMore: (parseInt(offset) + parseInt(limit)) < total
      }
    });
    
  } catch (error) {
    console.error('Error fetching articles:', error);
    res.status(500).json({ 
      error: 'Failed to fetch articles',
      details: error.message 
    });
  }
});

app.get('/api/articles/:id', async (req, res) => {
  try {
    const article = await Article.findById(req.params.id);
    
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }
    
    res.json(article);
  } catch (error) {
    console.error('Error fetching article:', error);
    res.status(500).json({ error: 'Failed to fetch article' });
  }
});

app.get('/api/cluster/:clusterId', async (req, res) => {
  try {
    const articles = await Article.find({ 
      clusterId: parseInt(req.params.clusterId),
      analysisType: 'Full' // Only cluster 'Full' news articles
    }).sort({ trustScore: -1 });
    
    const grouped = {
      left: articles.filter(a => ['Left', 'Left-Leaning'].includes(a.politicalLean)),
      center: articles.filter(a => a.politicalLean === 'Center'),
      right: articles.filter(a => ['Right-Leaning', 'Right'].includes(a.politicalLean))
    };
    
    const stats = {
      totalArticles: articles.length,
      leftCount: grouped.left.length,
      centerCount: grouped.center.length,
      rightCount: grouped.right.length,
      averageBias: articles.length > 0 ? 
        Math.round(articles.reduce((sum, a) => sum + a.biasScore, 0) / articles.length) : 0,
      averageTrust: articles.length > 0 ?
        Math.round(articles.reduce((sum, a) => sum + a.trustScore, 0) / articles.length) : 0
    };
    
    res.json({
      ...grouped,
      stats
    });
    
  } catch (error) {
    console.error('Error fetching cluster:', error);
    res.status(500).json({ error: 'Failed to fetch cluster' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const totalArticles = await Article.countDocuments();
    const sources = await Article.distinct('source');
    const categories = await Article.distinct('category');
    
    const avgBias = await Article.aggregate([
      { $match: { analysisType: 'Full' } }, // Only average bias for 'Full' articles
      { $group: { _id: null, avg: { $avg: '$biasScore' } } }
    ]);
    
    const avgTrust = await Article.aggregate([
      { $match: { analysisType: 'Full' } }, // Only average trust for 'Full' articles
      { $group: { _id: null, avg: { $avg: '$trustScore' } } }
    ]);
    
    const leanDistribution = await Article.aggregate([
      { $match: { analysisType: 'Full' } },
      { $group: { _id: '$politicalLean', count: { $sum: 1 } } }
    ]);
    
    const categoryDistribution = await Article.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } }
    ]);
    
    res.json({
      totalArticles,
      totalSources: sources.length,
      totalCategories: categories.length,
      averageBias: Math.round(avgBias[0]?.avg || 0),
      averageTrust: Math.round(avgTrust[0]?.avg || 0),
      leanDistribution,
      categoryDistribution,
      lastUpdated: new Date()
    });
    
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

app.get('/api/stats/keys', async (req, res) => {
  try {
    // Services are now imported at the top
    res.json({
      gemini: geminiService.getStatistics(),
      news: newsService.getStatistics(),
      timestamp: new Date()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get key statistics' });
  }
});

app.post('/api/fetch-news', async (req, res) => {
  try {
    console.log('📰 Manual news fetch triggered...');
    const result = await fetchAndAnalyzeNews();
    
    res.json({
      message: 'News fetch completed',
      ...result,
      timestamp: new Date()
    });
    
  } catch (error) {
    console.error('Error in manual fetch:', error);
    res.status(500).json({
      error: 'Failed to fetch news',
      details: error.message
    });
  }
});

async function fetchAndAnalyzeNews() {
  // Services are now imported at the top
  const stats = {
    fetched: 0,
    processed: 0,
    skipped: 0,
    errors: 0
  };
  
  try {
    console.log('📡 Fetching from NewsAPI with rotational keys...');
    
    const articles = await newsService.fetchNews();
    stats.fetched = articles.length;
    console.log(`📰 Found ${articles.length} articles`);
    
    for (const article of articles) {
      try {
        const exists = await Article.findOne({ url: article.url });
        if (exists) {
          stats.skipped++;
          continue;
        }
        
        if (!article.description || article.description.length < 50) {
          stats.skipped++;
          continue;
        }
        
        console.log(`🤖 Analyzing: ${article.title.substring(0, 60)}...`);
        
        const analysis = await geminiService.analyzeArticle(article);
        
        // --- UPDATED to save new fields ---
        const newArticle = new Article({
          headline: article.title,
          summary: analysis.summary,
          source: article.source.name,
          category: analysis.category,
          politicalLean: analysis.politicalLean,
          url: article.url,
          imageUrl: article.urlToImage,
          publishedAt: article.publishedAt,
          
          // NEW FIELDS
          analysisType: analysis.analysisType,
          sentiment: analysis.sentiment,
          
          // These fields will be 0 if analysisType is 'SentimentOnly'
          biasScore: analysis.biasScore,
          biasLabel: analysis.biasLabel,
          biasComponents: analysis.biasComponents,
          
          credibilityScore: analysis.credibilityScore,
          credibilityGrade: analysis.credibilityGrade,
          credibilityComponents: analysis.credibilityComponents,
          
          reliabilityScore: analysis.reliabilityScore,
          reliabilityGrade: analysis.reliabilityGrade,
          reliabilityComponents: analysis.reliabilityComponents,
          
          trustScore: analysis.trustScore,
          trustLevel: analysis.trustLevel,
          
          coverageLeft: analysis.coverageLeft,
          coverageCenter: analysis.coverageCenter,
          coverageRight: analysis.coverageRight,
          clusterId: analysis.clusterId,
          
          keyFindings: analysis.keyFindings || [],
          recommendations: analysis.recommendations || []
        });
        
        await newArticle.save();
        stats.processed++;
        
        console.log(`✅ Saved: ${article.title.substring(0, 60)}... (${analysis.analysisType})`);
        
        // --- Sleep to avoid rate limit ---
        await sleep(1500);
        
      } catch (error) {
        console.error(`❌ Error processing article: ${error.message}`);
        stats.errors++;
      }
    }
    
    console.log(`
✅ Completed: ${stats.processed} processed, ${stats.skipped} skipped, ${stats.errors} errors
    `);
    
    return stats;
    
  } catch (error) {
    console.error('❌ Error fetching news:', error.message);
    throw error;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

cron.schedule('*/30 * * * *', async () => {
  console.log('🔄 Auto-fetching news (scheduled)...');
  try {
    await fetchAndAnalyzeNews();
  } catch (error) {
    console.error('❌ Scheduled fetch failed:', error);
  }
});

cron.schedule('0 2 * * *', async () => {
  console.log('🧹 Cleaning up old articles...');
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await Article.deleteMany({ createdAt: { $lt: sevenDaysAgo } });
    console.log(`🗑️ Deleted ${result.deletedCount} old articles`);
  } catch (error) {
    console.error('❌ Cleanup failed:', error);
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.use((err, req, res, next) => {
  console.error('Global error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║                                            ║
║      THE NARRATIVE API v2.1                ║
║      Production Server Running             ║
║                                            ║
╚════════════════════════════════════════════╝

🚀 Server: http://localhost:${PORT}
📍 Environment: ${process.env.NODE_ENV || 'development'}
💾 Database: Connected
🤖 AI: Multiple Gemini keys (rotational)
📰 News: Multiple NewsAPI keys (rotational)
🔄 Auto-fetch: Every 6 hours
🧹 Auto-cleanup: Daily at 2 AM

API Endpoints:
  GET  /                     - Health check
  GET  /api/articles         - Get articles (with filters)
  GET  /api/articles/:id     - Get single article
  GET  /api/cluster/:id      - Compare coverage
  GET  /api/stats            - Get statistics
  GET  /api/stats/keys       - Get API key usage
  POST /api/fetch-news       - Manual fetch trigger

Ready to serve! 🎉
  `);
});

process.on('SIGTERM', async () => {
  console.log('👋 SIGTERM received, shutting down gracefully...');
  await mongoose.connection.close();
  console.log('💾 MongoDB connection closed');
  process.exit(0);
});
