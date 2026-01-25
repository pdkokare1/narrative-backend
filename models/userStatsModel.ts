// models/userStatsModel.ts
import mongoose, { Document, Schema } from 'mongoose';

export interface IUserStats extends Document {
  userId: string;
  totalTimeSpent: number; // in seconds
  
  // NEW: Quality Metric
  articlesReadCount: number; // Only counts "True Reads"

  averageAttentionSpan: number; // in seconds
  
  leanExposure: {
    Left: number;
    Center: number;
    Right: number;
  };

  // Topics they click/read
  topicInterest: Map<string, number>;

  // Topics they see (Impressions) - Used to calculate CTR/Bias
  topicImpressions: Map<string, number>;

  // Topics they see but IGNORE (Survivorship Bias Fix)
  negativeInterest: Map<string, number>;

  // Daily Progress for Habits
  dailyStats: {
    date: Date;          // The day this stat belongs to
    timeSpent: number;   // Seconds read TODAY
    articlesRead: number; // Articles read TODAY
    goalsMet: boolean;   // Has the daily goal been triggered?
  };

  activityByHour: Map<string, number>;
  
  engagementScore: number; // 0-100
  lastUpdated: Date;
}

const userStatsSchema = new Schema<IUserStats>({
  userId: { type: String, required: true, unique: true, index: true },
  totalTimeSpent: { type: Number, default: 0 },
  
  articlesReadCount: { type: Number, default: 0 },

  averageAttentionSpan: { type: Number, default: 0 },
  
  leanExposure: {
    Left: { type: Number, default: 0 },
    Center: { type: Number, default: 0 },
    Right: { type: Number, default: 0 }
  },
  
  topicInterest: { type: Map, of: Number, default: {} },
  
  // NEW: Impressions Map
  topicImpressions: { type: Map, of: Number, default: {} },

  // Negative Interest Map
  negativeInterest: { type: Map, of: Number, default: {} },

  // NEW: Daily Stats Tracking
  dailyStats: {
    date: { type: Date, default: Date.now },
    timeSpent: { type: Number, default: 0 },
    articlesRead: { type: Number, default: 0 },
    goalsMet: { type: Boolean, default: false }
  },

  activityByHour: { type: Map, of: Number, default: {} },
  
  engagementScore: { type: Number, default: 50 },
  lastUpdated: { type: Date, default: Date.now }
});

const UserStats = mongoose.model<IUserStats>('UserStats', userStatsSchema);
export default UserStats;
