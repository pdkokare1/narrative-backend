// models/articleModel.js
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
  analysisVersion: { type: String, default: '2.14' }
}, {
  timestamps: true, // Adds createdAt and updatedAt
  autoIndex: process.env.NODE_ENV !== 'production',
});

// --- NEW: Text Index for Search ---
// This allows us to search headlines, summaries, and nouns instantly.
articleSchema.index({ 
  headline: 'text', 
  summary: 'text', 
  clusterTopic: 'text', 
  primaryNoun: 'text', 
  secondaryNoun: 'text' 
}, {
  name: 'GlobalSearchIndex',
  weights: {
    headline: 10,     // Headlines matches are most important
    clusterTopic: 8,  // Topic matches are very important
    primaryNoun: 5,   // Specific people/orgs are important
    summary: 1        // Summary matches are less critical
  }
});

// Indexes for performance
articleSchema.index({ category: 1, publishedAt: -1 });
articleSchema.index({ politicalLean: 1, publishedAt: -1 });
articleSchema.index({ clusterId: 1, trustScore: -1 });
articleSchema.index({ trustScore: -1, publishedAt: -1 });
articleSchema.index({ biasScore: 1, publishedAt: -1 });
articleSchema.index({ createdAt: 1 });
articleSchema.index({ analysisType: 1, publishedAt: -1 });
articleSchema.index({ headline: 1, source: 1, publishedAt: -1 });
// 5-Field Cluster Index
articleSchema.index({ clusterTopic: 1, category: 1, country: 1, primaryNoun: 1, secondaryNoun: 1, publishedAt: -1 }, {
  name: "5_Field_Cluster_Index"
});
articleSchema.index({ country: 1, analysisType: 1, publishedAt: -1 });

module.exports = mongoose.model('Article', articleSchema);
