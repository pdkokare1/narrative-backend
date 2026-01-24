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
  topicInterest: {
    [category: string]: number;
  };

  // NEW: Topics they see but IGNORE (Survivorship Bias Fix)
  negativeInterest: {
    [category: string]: number;
  };

  activityByHour: {
    [hour: string]: number;
  };
  
  engagementScore: number; // 0-100
  lastUpdated: Date;
}

const userStatsSchema = new Schema<IUserStats>({
  userId: { type: String, required: true, unique: true, index: true },
  totalTimeSpent: { type: Number, default: 0 },
  
  // NEW: Default 0
  articlesReadCount: { type: Number, default: 0 },

  averageAttentionSpan: { type: Number, default: 0 },
  
  leanExposure: {
    Left: { type: Number, default: 0 },
    Center: { type: Number, default: 0 },
    Right: { type: Number, default: 0 }
  },
  
  topicInterest: { type: Map, of: Number, default: {} },
  
  // NEW: Negative Interest Map
  negativeInterest: { type: Map, of: Number, default: {} },

  activityByHour: { type: Map, of: Number, default: {} },
  
  engagementScore: { type: Number, default: 50 },
  lastUpdated: { type: Date, default: Date.now }
});

const UserStats = mongoose.model<IUserStats>('UserStats', userStatsSchema);
export default UserStats;
