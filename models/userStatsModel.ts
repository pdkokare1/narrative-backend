// models/userStatsModel.ts
import mongoose, { Document, Schema } from 'mongoose';

// NEW: Interface for granular habit tracking
export interface IHabitStatus {
  habitId?: string; // Optional link to a specific config ID
  type: 'daily_minutes' | 'daily_articles' | 'daily_audio';
  current: number;
  target: number;
  completed: boolean;
  label?: string;
}

export interface IUserStats extends Document {
  userId: string;
  totalTimeSpent: number; // in seconds
  
  // Quality Metric
  articlesReadCount: number; // Binary "True Reads"
  totalReadValue: number;    // NEW: Accumulated "Partial Credit" (e.g. 0.5 + 0.8 + 1.0)

  averageAttentionSpan: number; // in seconds
  focusScoreAvg: number; // 0-100 (How often they stay on the tab)

  // NEW: Deep Work Tracking
  deepFocusMinutes: number; // Total minutes spent in "Flow State"

  // NEW: Perspective & Echo Chamber Tracking
  diversityScore: number; // 0-100 (Higher = Better balanced diet)
  lastLeanSequence: string[]; // Keep track of last 10 reads ['Left', 'Right', 'Center'...]

  // NEW: Sentiment Velocity (Doomscrolling Detection)
  lastSentimentSequence: string[]; // Keep track of last 5 reads ['Negative', 'Positive'...]
  suggestPalateCleanser: boolean; // Flag to trigger UI intervention

  // NEW: Smart Habit Calibration
  suggestGoalUpgrade: boolean; // Flag to suggest increasing daily target

  leanExposure: {
    Left: number;
    Center: number;
    Right: number;
  };

  // NEW: Time-of-Day Contextualization
  leanExposureMorning?: {
    Left: number;
    Center: number;
    Right: number;
  };
  leanExposureEvening?: {
    Left: number;
    Center: number;
    Right: number;
  };

  // NEW: Reading Classification
  readingStyle?: 'skimmer' | 'deep_reader' | 'balanced' | 'learner';

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

  // --- HABIT & STREAK TRACKING ---
  currentStreak: number;
  longestStreak: number;
  lastActiveDate: Date; 
  streakFreezes: number; // Number of "saves" available
  lastFreezeUsed: Date | null; // When the last freeze was consumed

  // NEW: Multi-Habit Status (Runs parallel to dailyStats)
  dailyHabitStatus?: IHabitStatus[];

  // Historical Data (Last 30 Days)
  recentDailyHistory: Array<{
    date: string; // YYYY-MM-DD
    timeSpent: number;
    articlesRead: number;
    goalsMet: boolean;
  }>;

  // Existing Daily Progress (Preserved for backward compatibility)
  dailyStats: {
    date: Date;          
    timeSpent: number;   
    articlesRead: number; 
    goalsMet: boolean;   
  };

  activityByHour: Map<string, number>;
  peakLearningTime?: number; // 0-23 (The Golden Hour)
  
  engagementScore: number; // 0-100
  lastUpdated: Date;
}

const userStatsSchema = new Schema<IUserStats>({
  userId: { type: String, required: true, unique: true, index: true },
  totalTimeSpent: { type: Number, default: 0 },
  
  articlesReadCount: { type: Number, default: 0 },
  totalReadValue: { type: Number, default: 0 }, // NEW

  averageAttentionSpan: { type: Number, default: 0 },
  focusScoreAvg: { type: Number, default: 100 }, // Defaults to perfect focus

  // NEW: Deep Focus
  deepFocusMinutes: { type: Number, default: 0 },
  
  // NEW: Perspective Tracking
  diversityScore: { type: Number, default: 50 }, // Start neutral
  lastLeanSequence: { type: [String], default: [] }, // Store "Left", "Right", "Center"

  // NEW: Sentiment Velocity
  lastSentimentSequence: { type: [String], default: [] },
  suggestPalateCleanser: { type: Boolean, default: false },

  // NEW: Smart Habit Calibration
  suggestGoalUpgrade: { type: Boolean, default: false },

  leanExposure: {
    Left: { type: Number, default: 0 },
    Center: { type: Number, default: 0 },
    Right: { type: Number, default: 0 }
  },

  // NEW: Time-of-Day Contextualization
  leanExposureMorning: {
    Left: { type: Number, default: 0 },
    Center: { type: Number, default: 0 },
    Right: { type: Number, default: 0 }
  },
  leanExposureEvening: {
    Left: { type: Number, default: 0 },
    Center: { type: Number, default: 0 },
    Right: { type: Number, default: 0 }
  },

  // NEW: Reading Classification
  readingStyle: { type: String, enum: ['skimmer', 'deep_reader', 'balanced', 'learner'], default: 'balanced' },
  
  topicInterest: { type: Map, of: Number, default: {} },
  
  // Impressions Map
  topicImpressions: { type: Map, of: Number, default: {} },

  // Negative Interest Map
  negativeInterest: { type: Map, of: Number, default: {} },

  // Stop Points
  readingProgress: { type: Map, of: Number, default: {} },
  lastTimezone: { type: String, default: 'UTC' },

  // --- HABIT & STREAK TRACKING ---
  currentStreak: { type: Number, default: 0 },
  longestStreak: { type: Number, default: 0 },
  lastActiveDate: { type: Date, default: Date.now },
  streakFreezes: { type: Number, default: 1 }, // Start with 1 freeze
  lastFreezeUsed: { type: Date, default: null },

  // NEW: Multi-Habit Schema
  dailyHabitStatus: [{
    habitId: String,
    type: { type: String, enum: ['daily_minutes', 'daily_articles', 'daily_audio'] },
    current: Number,
    target: Number,
    completed: Boolean,
    label: String
  }],

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
  peakLearningTime: { type: Number, default: null }, 
  
  engagementScore: { type: Number, default: 50 },
  lastUpdated: { type: Date, default: Date.now }
});

const UserStats = mongoose.model<IUserStats>('UserStats', userStatsSchema);
export default UserStats;
