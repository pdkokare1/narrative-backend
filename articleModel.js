// articleModel.js (NEW - Mongoose Model Definition)
const mongoose = require('mongoose');

// --- Mongoose Schema Definition ---
const articleSchema = new mongoose.Schema({
  headline: { type: String, required: true, trim: true },
  summary: { type: String, required: true, trim: true },
  source: { type: String, required: true, trim: true },
  category: { type: String, default: 'General' }, 
  politicalLean: { type: String, default: 'Center' }, 
  url: { type: String, required: true, unique: true, trim: true, index: true },
  imageUrl: { type: String, trim: true },
  publishedAt: { type: Date, default: Date.now, index: true },
  
  // Analysis fields (populated by the ArticleProcessor worker)
  analysisType: { type: String, default: 'Pending', enum: ['Full', 'SentimentOnly', 'Pending'] }, 
  sentiment: { type: String, default: 'Neutral', enum: ['Positive', 'Negative', 'Neutral'] },
  biasScore: { type: Number, default: 0, min: 0, max: 100 },
  biasLabel: String,
  biasComponents: mongoose.Schema.Types.Mixed,
  credibilityScore: { type: Number, default: 0, min: 0, max: 100 },
  credibilityGrade: String,
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
  keyFindings: [String],
  recommendations: [String],
  analysisVersion: { type: String, default: '2.12' }
}, {
  timestamps: true,
  autoIndex: process.env.NODE_ENV !== 'production',
});

// Compound Indexes
articleSchema.index({ category: 1, publishedAt: -1 });
articleSchema.index({ politicalLean: 1, publishedAt: -1 });
articleSchema.index({ clusterId: 1, trustScore: -1 });
articleSchema.index({ trustScore: -1, publishedAt: -1 });
articleSchema.index({ biasScore: 1, publishedAt: -1 });
articleSchema.index({ createdAt: 1 });
articleSchema.index({ clusterTopic: 1, publishedAt: -1 });
articleSchema.index({ headline: 1, source: 1, publishedAt: -1 });
articleSchema.index({ analysisType: 1, publishedAt: -1 });


// Use existing model if defined, otherwise define it.
const Article = mongoose.models.Article || mongoose.model('Article', articleSchema);

module.exports = Article;
