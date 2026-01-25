// models/userStatsModel.ts
import mongoose, { Document, Schema } from 'mongoose';

export interface IUserStats extends Document {
  userId: string;
  totalTimeSpent: number; // in seconds
  
  // Quality Metric
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

  // Reading Progress (Stop Points)
  // Maps Article ID -> Scroll Position (pixels)
  readingProgress: Map<string, number>;

  // Last known timezone (for streak calculation)
  lastTimezone: string;

  // --- HABIT & STREAK TRACKING (NEW) ---
  currentStreak: number;
  longestStreak: number;
  lastActiveDate: Date; // Used to check if streak is alive

  // Historical Data (Last 30 Days) - New field to support history graph
  recentDailyHistory: Array<{
    date: string; // YYYY-MM-DD format for easy lookup
    timeSpent: number;
    articlesRead: number;
    goalsMet: boolean;
  }>;

  // Existing Daily Progress (Preserved for backward compatibility)
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
  
  // Impressions Map
  topicImpressions: { type: Map, of: Number, default: {} },

  // Negative Interest Map
  negativeInterest: { type: Map, of: Number, default: {} },

  // Stop Points
  readingProgress: { type: Map, of: Number, default: {} },
  lastTimezone: { type: String, default: 'UTC' },

  // --- HABIT & STREAK TRACKING (NEW) ---
  currentStreak: { type: Number, default: 0 },
  longestStreak: { type: Number, default: 0 },
  lastActiveDate: { type: Date, default: Date.now },

  recentDailyHistory: [{
    date: { type: String }, 
    timeSpent: { type: Number, default: 0 },
    articlesRead: { type: Number, default: 0 },
    goalsMet: { type: Boolean, default: false }
  }],

  // Daily Stats Tracking (Preserved)
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
