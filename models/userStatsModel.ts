// models/userStatsModel.ts
import mongoose, { Document, Schema } from 'mongoose';

export interface IUserStats extends Document {
  userId: string;
  totalTimeSpent: number; // in seconds
  averageAttentionSpan: number; // in seconds
  
  // The "Echo Chamber" Meter (Minutes spent)
  leanExposure: {
    Left: number;
    Center: number;
    Right: number;
  };

  // Topic Velocity (Minutes spent per category)
  topicInterest: {
    [category: string]: number;
  };

  // NEW: Dayparting (Habit Tracking)
  // Map of "Hour (0-23)" -> Minutes Spent
  activityByHour: {
    [hour: string]: number;
  };
  
  // Derived Engagement
  engagementScore: number; // 0-100
  lastUpdated: Date;
}

const userStatsSchema = new Schema<IUserStats>({
  userId: { type: String, required: true, unique: true, index: true },
  totalTimeSpent: { type: Number, default: 0 },
  averageAttentionSpan: { type: Number, default: 0 },
  
  leanExposure: {
    Left: { type: Number, default: 0 },
    Center: { type: Number, default: 0 },
    Right: { type: Number, default: 0 }
  },
  
  topicInterest: { type: Map, of: Number, default: {} },

  // NEW: Activity Histogram
  activityByHour: { type: Map, of: Number, default: {} },
  
  engagementScore: { type: Number, default: 50 },
  lastUpdated: { type: Date, default: Date.now }
});

const UserStats = mongoose.model<IUserStats>('UserStats', userStatsSchema);
export default UserStats;
