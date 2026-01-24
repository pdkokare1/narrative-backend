// models/searchLogModel.ts
import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ISearchLog extends Document {
  query: string;
  normalizedQuery: string; // Lowercase, trimmed
  count: number;
  lastSearched: Date;
  zeroResults: boolean; // True if the last search returned 0 items
  resultCountAvg: number; // Moving average of results found
}

const searchLogSchema = new Schema<ISearchLog>({
  query: { type: String, required: true },
  normalizedQuery: { type: String, required: true, unique: true, index: true },
  count: { type: Number, default: 1 },
  lastSearched: { type: Date, default: Date.now },
  zeroResults: { type: Boolean, default: false },
  resultCountAvg: { type: Number, default: 0 }
}, {
  timestamps: { createdAt: true, updatedAt: false }
});

// Index for getting "Trending" (Sort by count + recency logic in query)
searchLogSchema.index({ count: -1 });
searchLogSchema.index({ lastSearched: -1 });

const SearchLog: Model<ISearchLog> = mongoose.model<ISearchLog>('SearchLog', searchLogSchema);

export default SearchLog;
