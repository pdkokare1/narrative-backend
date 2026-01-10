// models/profileModel.ts
import mongoose, { Schema, Document, Model } from 'mongoose';
import { IUserProfile, IBadge } from '../types';

// FIX: Override IUserProfile to make email optional for Phone Auth
// We also add phoneNumber which might not be in the shared type yet
export interface ProfileDocument extends Omit<IUserProfile, 'savedArticles' | 'email'>, Document {
  email?: string;
  phoneNumber?: string; 
  savedArticles: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const badgeSchema = new Schema<IBadge>({
  id: { type: String, required: true },
  label: { type: String, required: true },
  icon: { type: String, required: true },
  description: { type: String, required: true },
  earnedAt: { type: Date, default: Date.now }
}, { _id: false });

const profileSchema = new Schema<ProfileDocument>({
  // Auth Link
  userId: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true 
  },
  
  // FIX: Email is now Optional & Sparse (allows multiple nulls)
  email: { 
    type: String, 
    required: false, 
    unique: true,
    sparse: true 
  },

  // FIX: Added Phone Number for Phone Auth users
  phoneNumber: {
    type: String,
    required: false,
    unique: true,
    sparse: true
  },

  username: { 
    type: String, 
    required: true, 
    unique: true, 
    trim: true 
  },
  
  // User Stats
  articlesViewedCount: { type: Number, default: 0 },
  comparisonsViewedCount: { type: Number, default: 0 },
  articlesSharedCount: { type: Number, default: 0 },
  
  // Gamification
  currentStreak: { type: Number, default: 0 },
  lastActiveDate: { type: Date, default: Date.now },
  badges: [badgeSchema],

  // Saved Articles Link
  savedArticles: [{
    type: Schema.Types.ObjectId,
    ref: 'Article' 
  }],
  
  // AI Personalization Vector
  userEmbedding: { 
    type: [Number], 
    default: [],
    select: false 
  },
  
  // Push Notification Token
  fcmToken: { type: String, default: null },
  notificationsEnabled: { type: Boolean, default: false }
}, {
  timestamps: true
});

const Profile: Model<ProfileDocument> = mongoose.model<ProfileDocument>('Profile', profileSchema);

export default Profile;
