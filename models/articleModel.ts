// models/articleModel.ts
import mongoose, { Schema, Document, Model } from 'mongoose';
import { IArticle } from '../types';

// Extended Interface for the Document
export interface ArticleDocument extends Omit<IArticle, '_id'>, Document {
  createdAt: Date;
  updatedAt: Date;
}

// Interface for the Model
interface ArticleModel extends Model<ArticleDocument> {}

const articleSchema = new Schema<ArticleDocument>({
  headline: { type: String, required: true, trim: true },
  summary: { type: String, required: true, trim: true },
  
  // Indexed for filtering by Publisher (e.g. "Show me only CNN")
  source: { type: String, required: true, trim: true, index: true },
  
  // Core Feed Filters
  category: { type: String, required: true, trim: true, index: true }, 
  politicalLean: { type: String, required: true, trim: true, index: true },
  
  url: { type: String, required: true, unique: true, trim: true }, 
  imageUrl: { type: String, trim: true },
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
  
  // Trust Score (Important for "Trusted News" filters)
  trustScore: { type: Number, default: 0, min: 0, max: 100, index: true }, 
  trustLevel: String,
  
  // Coverage Stats
  coverageLeft: { type: Number, default: 0 },
  coverageCenter: { type: Number, default: 0 },
  coverageRight: { type: Number, default: 0 },
  
  // Clustering Fields
  clusterId: { type: Number, index: true },
  // Used in Trending Topics Grouping
  clusterTopic: { type: String, trim: true, index: true },
  // Used for "Most Covered" sort
  clusterCount: { type: Number, default: 0, index: true },

  country: { type: String, index: true, trim: true, default: 'Global' }, 
  primaryNoun: { type: String, trim: true, default: null },
  secondaryNoun: { type: String, trim: true, default: null },
  
  // Vector Embedding (Hidden by default to save bandwidth)
  embedding: { type: [Number], select: false }, 
  
  keyFindings: [String],
  recommendations: [String],
  analysisVersion: { type: String, default: '3.6' }
}, {
  timestamps: true, 
  autoIndex: process.env.NODE_ENV !== 'production',
});

// --- 1. SEARCH INDEXES ---
// Standard Text Index (Fallback for when Atlas Search isn't active)
articleSchema.index({ 
  headline: 'text', 
  summary: 'text', 
  clusterTopic: 'text',
  primaryNoun: 'text'
}, {
  name: 'GlobalSearchIndex',
  weights: {
    headline: 10,
    clusterTopic: 8,
    primaryNoun: 5,
    summary: 1
  }
});

// --- 2. COMPOUND INDEXES (Performance Boosters) ---
// These are "shortcuts" for specific queries your app runs often.

// A. "For You" Feed: Filter by Category + Lean + Date
articleSchema.index({ category: 1, politicalLean: 1, publishedAt: -1 });

// B. "Trusted News" Feed: Filter by Lean + High Trust + Date
articleSchema.index({ politicalLean: 1, trustScore: -1, publishedAt: -1 });

// C. "Cluster View": Quickly find all articles in a specific event cluster
articleSchema.index({ clusterId: 1, publishedAt: -1 });

// D. "Regional News": Filter by Country + Category + Date
articleSchema.index({ country: 1, category: 1, publishedAt: -1 });

// F. "Duplicate Check": Optimizes the pipeline's duplicate check
articleSchema.index({ url: 1 }, { unique: true });

// --- 3. DATA RETENTION ---
// Automatically delete articles older than 90 days
articleSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

const Article = mongoose.model<ArticleDocument, ArticleModel>('Article', articleSchema);

export default Article;
