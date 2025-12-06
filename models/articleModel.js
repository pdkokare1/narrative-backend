// models/articleModel.js (FINAL v3.2 - Smart Search)
const mongoose = require('mongoose');

const articleSchema = new mongoose.Schema({
  headline: { type: String, required: true, trim: true },
  summary: { type: String, required: true, trim: true },
  source: { type: String, required: true, trim: true },
  category: { type: String, required: true, trim: true },
  politicalLean: { type: String, required: true, trim: true },
  url: { type: String, required: true, unique: true, trim: true, index: true },
  imageUrl: { type: String, trim: true },
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
  timestamps: true, // Adds createdAt and updatedAt
  autoIndex: process.env.NODE_ENV !== 'production',
});

// --- SMART SEARCH INDEX ---
// Expanded to include Source, Category, and Lean for "natural language" feel.
articleSchema.index({ 
  headline: 'text', 
  summary: 'text', 
  clusterTopic: 'text', 
  primaryNoun: 'text', 
  secondaryNoun: 'text',
  source: 'text',       // <--- NEW
  category: 'text',     // <--- NEW
  politicalLean: 'text' // <--- NEW
}, {
  name: 'GlobalSearchIndex',
  weights: {
    headline: 10,
    clusterTopic: 8,
    primaryNoun: 6,
    source: 5,       // High weight for finding specific outlets
    category: 4,
    secondaryNoun: 3,
    politicalLean: 3,
    summary: 1
  }
});

// --- PERFORMANCE INDEXES ---

// 1. "For You" Feed Optimization (Compound Index)
articleSchema.index({ category: 1, politicalLean: 1, publishedAt: -1 });

// 2. Feed Sorting & Filtering
articleSchema.index({ category: 1, publishedAt: -1 });
articleSchema.index({ politicalLean: 1, publishedAt: -1 });
articleSchema.index({ analysisType: 1, publishedAt: -1 });
articleSchema.index({ country: 1, publishedAt: -1 });

// 3. Sorting by Scores
articleSchema.index({ trustScore: -1, publishedAt: -1 });
articleSchema.index({ biasScore: 1, publishedAt: -1 });

// 4. Clustering & Deduplication
articleSchema.index({ clusterId: 1, publishedAt: -1 });
articleSchema.index({ headline: 1, source: 1, publishedAt: -1 });

// 5. Advanced Clustering Lookup (5-Field)
articleSchema.index({ 
  clusterTopic: 1, 
  category: 1, 
  country: 1, 
  primaryNoun: 1, 
  secondaryNoun: 1, 
  publishedAt: -1 
}, { name: "5_Field_Cluster_Index" });

module.exports = mongoose.model('Article', articleSchema);
