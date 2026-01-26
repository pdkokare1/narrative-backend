// models/articleModel.ts
import mongoose, { Schema, Document, Model } from 'mongoose';
import { IArticle } from '../types';

// Extended Interface for the Document
export interface ArticleDocument extends Omit<IArticle, '_id'>, Document {
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null; // NEW: Track when item was moved to trash
  
  // NEW: Fields required by StatsService (Type Compatibility)
  topics?: string[];
  detectedBias?: number; // -1 (Left) to 1 (Right)
}

// Interface for the Model (Static Methods)
interface ArticleModel extends Model<ArticleDocument> {
  smartSearch(term: string, limit?: number): Promise<ArticleDocument[]>;
}

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
  // UPDATED: Added index: true for fast "Palate Cleanser" retrieval
  sentiment: { type: String, default: 'Neutral', enum: ['Positive', 'Negative', 'Neutral'], index: true },
  
  // Scores
  biasScore: { type: Number, default: 0, min: 0, max: 100 },
  biasLabel: String,
  biasComponents: Schema.Types.Mixed,
  
  // NEW: Numerical Bias for Vector/Stats calculations (-1 to 1)
  detectedBias: { type: Number, default: 0, index: true },

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
  clusterTopic: { type: String, trim: true }, 
  country: { type: String, index: true, trim: true, default: 'Global' }, 
  primaryNoun: { type: String, trim: true, default: null },
  secondaryNoun: { type: String, trim: true, default: null },

  // NEW: Array of topics for Interest Profiling
  topics: { type: [String], index: true, default: [] },

  // Feed Optimization Flag
  // true = This is the latest version of the story in its cluster
  // false = This is an older version and should be hidden from the main feed
  isLatest: { type: Boolean, default: true, index: true },

  // NEW: Archive / Trash Support
  // If set, the article is in the "Recycle Bin" waiting for permanent deletion
  deletedAt: { type: Date, default: null, index: true },
  
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

// A. "For You" Feed: Filter by Category + Lean + Date + Latest Only
articleSchema.index({ category: 1, politicalLean: 1, isLatest: 1, publishedAt: -1 });

// B. "Trusted News" Feed: Filter by Lean + High Trust + Date
articleSchema.index({ politicalLean: 1, trustScore: -1, publishedAt: -1 });

// C. "Cluster View": Quickly find all articles in a specific event cluster
articleSchema.index({ clusterId: 1, publishedAt: -1 });

// D. "Regional News": Filter by Country + Category + Date + Latest Only
articleSchema.index({ country: 1, category: 1, isLatest: 1, publishedAt: -1 });

// E. "Viral/Trending" - DISABLED FOR PERFORMANCE (Too heavy)
// articleSchema.index({ publishedAt: -1, trustScore: -1, biasScore: -1 });

// F. "Duplicate Check": Optimizes the pipeline's duplicate check
articleSchema.index({ url: 1 }, { unique: true });

// --- 3. DATA RETENTION ---
// Automatically delete articles older than 90 days (Global retention policy)
articleSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

// --- 4. STATIC METHODS ---
// This moves complex search logic OUT of the controller and INTO the model.
articleSchema.statics.smartSearch = async function(term: string, limit: number = 20) {
  let results: ArticleDocument[] = [];
  let atlasFailed = false;

  // Option A: Atlas Search (Primary)
  // This provides fuzzy matching and better relevance if the index exists.
  try {
    results = await this.aggregate([
      {
        $search: {
          index: "default", // Ensure you create this index in Atlas Dashboard
          text: { 
            query: term, 
            path: { wildcard: "*" },
            fuzzy: {} // ENABLED: Typo tolerance active
          }
        }
      },
      { 
        $limit: limit 
      },
      {
        $project: {
          headline: 1, summary: 1, url: 1, imageUrl: 1, 
          source: 1, category: 1, publishedAt: 1,
          score: { $meta: "searchScore" }
        }
      }
    ]);
  } catch (error) {
    // console.warn("Atlas Search failed (Index missing?), falling back to Standard Text Search.");
    atlasFailed = true;
  }

  // Option B: Standard MongoDB Text Search (Fallback)
  // We run this if Atlas failed OR if Atlas returned 0 results.
  if (atlasFailed || results.length === 0) {
    return this.find(
      { $text: { $search: term } },
      { score: { $meta: 'textScore' } } // Return relevance score
    )
    .sort({ score: { $meta: 'textScore' }, publishedAt: -1 }) // Sort by relevance, then date
    .limit(limit);
  }

  return results;
};

const Article = mongoose.model<ArticleDocument, ArticleModel>('Article', articleSchema);

export default Article;
