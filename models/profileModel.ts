// models/profileModel.ts
import mongoose, { Document, Schema } from 'mongoose';
import { IBadge } from '../types';

export interface IHabit {
  type: 'daily_minutes' | 'weekly_articles';
  target: number;
  label: string;
}

export interface IProfile extends Document {
  userId: string;
  email?: string;
  phoneNumber?: string;
  username: string;
  
  // Gamification
  currentStreak: number;
  lastActiveDate?: Date;
  streakFreezes: number; // NEW: Streak Protection
  habits: IHabit[];      // NEW: Explicit Goals
  
  badges: IBadge[];

  // Stats Counters
  articlesViewedCount: number;
  comparisonsViewedCount: number;
  articlesSharedCount: number;
  
  // Settings
  notificationsEnabled: boolean;
  fcmToken?: string;
  
  // Personalization
  savedArticles: string[];
  userEmbedding?: number[]; // 1536-dim vector
  
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
  streakFreezes: { type: Number, default: 1 }, // Give 1 freebie
  
  habits: [{
    type: { type: String, enum: ['daily_minutes', 'weekly_articles'] },
    target: Number,
    label: String
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
  
  // Personalization
  savedArticles: [{ type: String }],
  userEmbedding: { type: [Number], select: false }, // Heavy field
  
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  
}, {
  timestamps: true
});

const Profile = mongoose.model<IProfile>('Profile', profileSchema);

export default Profile;
