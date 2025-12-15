// models/profileModel.ts
import mongoose, { Schema, Document, Model } from 'mongoose';
import { IUserProfile, IBadge } from '../types';

// We explicitly tell TypeScript that 'savedArticles' are ObjectIds inside the database
export interface ProfileDocument extends Omit<IUserProfile, 'savedArticles'>, Document {
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
}, { _id: false }); // No separate ID for badges inside the array

const profileSchema = new Schema<ProfileDocument>({
  // Auth Link
  userId: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true 
  },
  email: { 
    type: String, 
    required: true, 
    unique: true 
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
  
  // AI Personalization Vector (New)
  userEmbedding: { 
    type: [Number], 
    default: [],
    select: false // Don't return this huge array in standard API calls
  },
  
  // Push Notification Token
  fcmToken: { type: String, default: null },
  notificationsEnabled: { type: Boolean, default: false }
}, {
  timestamps: true
});

const Profile: Model<ProfileDocument> = mongoose.model<ProfileDocument>('Profile', profileSchema);

export default Profile;
