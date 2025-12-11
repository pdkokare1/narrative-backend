// models/articleModel.js (FINAL v3.4 - Optimized Indexes)
const mongoose = require('mongoose');

const articleSchema = new mongoose.Schema({
  headline: { type: String, required: true, trim: true },
  summary: { type: String, required: true, trim: true },
  source: { type: String, required: true, trim: true },
  category: { type: String, required: true, trim: true },
  politicalLean: { type: String, required: true, trim: true },
  url: { type: String, required: true, unique: true, trim: true, index: true },
  imageUrl: { type: String, trim: true },
  
  // Audio Caching Field
  audioUrl: { type: String, default: null }, 
  
  publishedAt: { type: Date, default: Date.now, index: true },
  
  // Analysis Data
  analysisType: { type: String, default: 'Full', enum: ['Full', 'SentimentOnly'] },
  sentiment: { type: String, default: 'Neutral', enum: ['Positive', 'Negative', 'Neutral'] },
  
  // Scores
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
  
  // Coverage Stats
  coverageLeft: { type: Number, default: 0 },
  coverageCenter: { type: Number, default: 0 },
  coverageRight: { type: Number, default: 0 },
  
  // Clustering Fields
  clusterId: { type: Number, index: true },
  clusterTopic: { type: String, index: true, trim: true }, 
  country: { type: String, index: true, trim: true, default: 'Global' }, 
  primaryNoun: { type: String, index: true, trim: true, default: null },
  secondaryNoun: { type: String, index: true, trim: true, default: null },
  
  // Vector Embedding
  embedding: { type: [Number], index: false }, 
  
  keyFindings: [String],
  recommendations: [String],
  analysisVersion: { type: String, default: '3.0' }
}, {
  timestamps: true, 
  autoIndex: process.env.NODE_ENV !== 'production',
});

// --- SMART SEARCH INDEX ---
// Keeps full-text search capability
articleSchema.index({ 
  headline: 'text', 
  summary: 'text', 
  clusterTopic: 'text', 
  primaryNoun: 'text', 
  secondaryNoun: 'text',
  source: 'text',       
  category: 'text',     
  politicalLean: 'text' 
}, {
  name: 'GlobalSearchIndex',
  weights: {
    headline: 10,
    clusterTopic: 8,
    primaryNoun: 6,
    source: 5,       
    category: 4,
    secondaryNoun: 3,
    politicalLean: 3,
    summary: 1
  }
});

// --- OPTIMIZED COMPOUND INDEXES ---
// These specific pairings speed up your exact API queries 
// while reducing the total work the database does on every save.

// 1. Main Feed Filters (Filter + Sort by Date)
articleSchema.index({ category: 1, publishedAt: -1 });
articleSchema.index({ politicalLean: 1, publishedAt: -1 });
articleSchema.index({ analysisType: 1, publishedAt: -1 });
articleSchema.index({ country: 1, publishedAt: -1 }); 

// 2. Cluster View (Filter by ID -> Sort by Trust -> Sort by Date)
// Matches route: /cluster/:id
articleSchema.index({ clusterId: 1, trustScore: -1, publishedAt: -1 });

// 3. Trending Logic (Filter by Recent Date -> Group by Topic)
// Matches route: /trending
articleSchema.index({ publishedAt: -1, clusterTopic: 1 });

// 4. Vector Search metadata filter
articleSchema.index({ country: 1 }); 

module.exports = mongoose.model('Article', articleSchema);
