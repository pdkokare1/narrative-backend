// narrative-backend/models/analyticsSession.ts
import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IInteraction {
  contentType: 'article' | 'narrative' | 'radio' | 'feed';
  contentId?: string;
  duration: number; // Seconds spent in this specific interaction
  scrollDepth?: number; // NEW: Percentage (0-100) of content viewed
  timestamp: Date;
}

export interface IAnalyticsSession extends Document {
  userId?: string;     // Optional: specific user ID if logged in
  sessionId: string;   // Required: Unique ID for this browser session
  date: Date;          // For daily aggregation
  
  // Aggregate Metrics (Seconds)
  totalDuration: number;
  articleDuration: number;
  radioDuration: number;
  narrativeDuration: number;
  feedDuration: number;

  // The Device/User Info
  platform: string;    // 'web', 'ios', 'android'
  userAgent: string;
  country?: string;

  // Granular Log (Optional - stores the sequence)
  interactions: IInteraction[];
  
  createdAt: Date;
  updatedAt: Date;
}

const analyticsSessionSchema = new Schema<IAnalyticsSession>({
  userId: { type: String, index: true },
  sessionId: { type: String, required: true, unique: true, index: true },
  date: { type: Date, default: Date.now, index: true },
  
  totalDuration: { type: Number, default: 0 },
  articleDuration: { type: Number, default: 0 },
  radioDuration: { type: Number, default: 0 },
  narrativeDuration: { type: Number, default: 0 },
  feedDuration: { type: Number, default: 0 },

  platform: String,
  userAgent: String,
  country: String,

  interactions: [{
    contentType: { type: String, enum: ['article', 'narrative', 'radio', 'feed'] },
    contentId: String,
    duration: Number,
    scrollDepth: Number, // NEW field
    timestamp: { type: Date, default: Date.now }
  }]
}, {
  timestamps: true 
});

const AnalyticsSession: Model<IAnalyticsSession> = mongoose.model<IAnalyticsSession>('AnalyticsSession', analyticsSessionSchema);

export default AnalyticsSession;
