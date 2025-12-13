// models/profileModel.ts
import mongoose, { Schema, Document, Model } from 'mongoose';
import { IUserProfile } from '../types';

// We explicitly tell TypeScript that 'savedArticles' are ObjectIds inside the database,
// overriding the string[] definition from our generic interface.
export interface ProfileDocument extends Omit<IUserProfile, 'savedArticles'>, Document {
  savedArticles: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const profileSchema = new Schema<ProfileDocument>({
  // This links the profile to the Firebase Auth user
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
  articlesViewedCount: { 
    type: Number, 
    default: 0 
  },
  comparisonsViewedCount: {
    type: Number,
    default: 0
  },
  articlesSharedCount: {
    type: Number,
    default: 0
  },
  // Saved Articles Link
  savedArticles: [{
    type: Schema.Types.ObjectId,
    ref: 'Article' // Links to Article model
  }],
  // Push Notification Token
  fcmToken: {
    type: String,
    default: null
  },
  notificationsEnabled: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

const Profile: Model<ProfileDocument> = mongoose.model<ProfileDocument>('Profile', profileSchema);

export default Profile;
