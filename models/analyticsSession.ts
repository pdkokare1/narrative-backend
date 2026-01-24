// narrative-backend/models/analyticsSession.ts
import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IInteraction {
  contentType: 'article' | 'narrative' | 'radio' | 'feed' | 'copy' | 'audio_action' | 'search' | 'ui_interaction';
  contentId?: string;
  duration?: number; 
  scrollDepth?: number; 
  
  text?: string; 
  audioAction?: 'skip' | 'pause' | 'complete' | 'start'; 
  
  query?: string;
  
  // NEW: Quarterly Retention (Array of seconds)
  quarters?: number[]; 

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
  
  // NEW: Aggregate retention across entire session
  quarterlyRetention: number[]; // [Q1, Q2, Q3, Q4] in seconds

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
  
  // NEW: Default to 0,0,0,0
  quarterlyRetention: { type: [Number], default: [0, 0, 0, 0] },

  interactions: [{
    contentType: { 
      type: String, 
      enum: ['article', 'narrative', 'radio', 'feed', 'copy', 'audio_action', 'search', 'ui_interaction'] 
    },
    contentId: String,
    duration: Number,
    scrollDepth: Number,
    
    text: String,
    audioAction: { type: String, enum: ['skip', 'pause', 'complete', 'start'] },
    
    query: String,
    
    // NEW
    quarters: [Number],
    
    timestamp: { type: Date, default: Date.now }
  }]
}, {
  timestamps: true 
});

const AnalyticsSession: Model<IAnalyticsSession> = mongoose.model<IAnalyticsSession>('AnalyticsSession', analyticsSessionSchema);

export default AnalyticsSession;
