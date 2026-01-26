// models/profileModel.ts
import mongoose, { Document, Schema } from 'mongoose';
import { IBadge } from '../types';

export interface IHabit {
  type: 'daily_minutes' | 'weekly_articles';
  target: number;
  label: string;
}

export interface IQuest {
  id: string;
  type: 'read_opposing' | 'read_deep' | 'share_article' | 'topic_explorer';
  target: number;      // e.g., 1
  progress: number;    // e.g., 0
  isCompleted: boolean;
  reward: string;      // 'xp', 'streak_freeze'
  description: string;
  expiresAt: Date;
}

export interface IProfile extends Document {
  userId: string;
  email?: string;
  phoneNumber?: string;
  username: string;
  
  // Gamification
  currentStreak: number;
  lastActiveDate?: Date;
  streakFreezes: number; 
  habits: IHabit[];      
  
  // NEW: Quest System
  quests: IQuest[];

  badges: IBadge[];

  // Stats Counters
  articlesViewedCount: number;
  comparisonsViewedCount: number;
  articlesSharedCount: number;
  
  // Settings
  notificationsEnabled: boolean;
  fcmToken?: string;
  
  // NEW: Privacy Mode
  isIncognito: boolean; // If true, stop tracking history

  // Personalization
  savedArticles: string[];
  userEmbedding?: number[]; 
  
  role: 'user' | 'admin';
  createdAt: Date;
}

const profileSchema = new Schema<IProfile>({
  userId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  email: { 
    type: String, 
    unique: true, 
    sparse: true 
  },
  phoneNumber: {
    type: String,
    unique: true, 
    sparse: true 
  },
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 30
  },
  
  // Gamification
  currentStreak: { type: Number, default: 0 },
  lastActiveDate: { type: Date },
  streakFreezes: { type: Number, default: 1 }, 
  
  habits: [{
    type: { type: String, enum: ['daily_minutes', 'weekly_articles'] },
    target: Number,
    label: String
  }],
  
  // NEW: Quests
  quests: [{
    id: String,
    type: { type: String, enum: ['read_opposing', 'read_deep', 'share_article', 'topic_explorer'] },
    target: Number,
    progress: { type: Number, default: 0 },
    isCompleted: { type: Boolean, default: false },
    reward: String,
    description: String,
    expiresAt: Date
  }],

  badges: [{
    id: String,
    label: String,
    icon: String,
    description: String,
    earnedAt: Date
  }],

  // Stats
  articlesViewedCount: { type: Number, default: 0 },
  comparisonsViewedCount: { type: Number, default: 0 },
  articlesSharedCount: { type: Number, default: 0 },

  // Settings
  notificationsEnabled: { type: Boolean, default: true },
  fcmToken: { type: String },
  
  // NEW: Privacy
  isIncognito: { type: Boolean, default: false },

  // Personalization
  savedArticles: [{ type: String }],
  userEmbedding: { type: [Number], select: false }, 
  
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  
}, {
  timestamps: true
});

const Profile = mongoose.model<IProfile>('Profile', profileSchema);

export default Profile;
