// models/articleModel.ts
import mongoose, { Schema, Document, Model } from 'mongoose';
import { IArticle } from '../types';

// We use "Omit" to exclude '_id' from IArticle so it doesn't conflict with Mongoose's Document._id
export interface ArticleDocument extends Omit<IArticle, '_id'>, Document {
  createdAt: Date;
  updatedAt: Date;
}

const articleSchema = new Schema<ArticleDocument>({
  headline: { type: String, required: true, trim: true },
  summary: { type: String, required: true, trim: true },
  source: { type: String, required: true, trim: true },
  category: { type: String, required: true, trim: true, index: true }, 
  politicalLean: { type: String, required: true, trim: true, index: true },
  url: { type: String, required: true, unique: true, trim: true }, 
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
  biasComponents: Schema.Types.Mixed,
  credibilityScore: { type: Number, default: 0, min: 0, max: 100 },
  credibilityGrade: String,
  credibilityComponents: Schema.Types.Mixed,
  reliabilityScore: { type: Number, default: 0, min: 0, max: 100 },
  reliabilityGrade: String,
  reliabilityComponents: Schema.Types.Mixed,
  trustScore: { type: Number, default: 0, min: 0, max: 100, index: true }, 
  trustLevel: String,
  
  // Coverage Stats
  coverageLeft: { type: Number, default: 0 },
  coverageCenter: { type: Number, default: 0 },
  coverageRight: { type: Number, default: 0 },
  
  // Clustering Fields
  clusterId: { type: Number, index: true },
  clusterTopic: { type: String, trim: true }, 
  country: { type: String, index: true, trim: true, default: 'Global' }, 
  primaryNoun: { type: String, trim: true, default: null },
  secondaryNoun: { type: String, trim: true, default: null },
  
  // Vector Embedding
  embedding: { type: [Number], select: false }, 
  
  keyFindings: [String],
  recommendations: [String],
  analysisVersion: { type: String, default: '3.5' }
}, {
  timestamps: true, 
  autoIndex: process.env.NODE_ENV !== 'production',
});

// --- SMART SEARCH INDEX ---
articleSchema.index({ 
  headline: 'text', 
  summary: 'text', 
  clusterTopic: 'text'
}, {
  name: 'GlobalSearchIndex',
  weights: {
    headline: 10,
    clusterTopic: 5,
    summary: 1
  }
});

// --- OPTIMIZED COMPOUND INDEXES ---
articleSchema.index({ category: 1, publishedAt: -1 }); 
articleSchema.index({ politicalLean: 1, publishedAt: -1 }); 
articleSchema.index({ clusterId: 1, publishedAt: -1 }); 
articleSchema.index({ country: 1, publishedAt: -1 }); 

// ** NEW: For You Feed Optimization **
// Allows fast filtering by category AND lean simultaneously
articleSchema.index({ category: 1, politicalLean: 1, publishedAt: -1 });

// --- DATA RETENTION (TTL INDEX) ---
// Automatically delete articles older than 90 days (7776000 seconds)
articleSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

const Article: Model<ArticleDocument> = mongoose.model<ArticleDocument>('Article', articleSchema);

export default Article;
