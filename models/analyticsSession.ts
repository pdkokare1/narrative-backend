// narrative-backend/models/analyticsSession.ts
import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IInteraction {
  contentType: 'article' | 'narrative' | 'radio' | 'feed' | 'copy' | 'audio_action' | 'search';
  contentId?: string;
  duration?: number; 
  scrollDepth?: number; 
  
  // High-Fidelity Data
  text?: string; 
  audioAction?: 'skip' | 'pause' | 'complete' | 'start'; 
  
  // NEW: Search Data
  query?: string;

  timestamp: Date;
}

export interface IAnalyticsSession extends Document {
  userId?: string;     
  sessionId: string;   
  date: Date;          
  
  totalDuration: number;
  articleDuration: number;
  radioDuration: number;
  narrativeDuration: number;
  feedDuration: number;

  platform: string;    
  userAgent: string;
  country?: string;

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
    contentType: { 
      type: String, 
      enum: ['article', 'narrative', 'radio', 'feed', 'copy', 'audio_action', 'search'] 
    },
    contentId: String,
    duration: Number,
    scrollDepth: Number,
    
    text: String,
    audioAction: { type: String, enum: ['skip', 'pause', 'complete', 'start'] },
    
    // NEW Field
    query: String,
    
    timestamp: { type: Date, default: Date.now }
  }]
}, {
  timestamps: true 
});

const AnalyticsSession: Model<IAnalyticsSession> = mongoose.model<IAnalyticsSession>('AnalyticsSession', analyticsSessionSchema);

export default AnalyticsSession;
