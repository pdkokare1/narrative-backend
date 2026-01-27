// models/activityLogModel.ts
import mongoose, { Schema, Document, Model } from 'mongoose';
import { IActivityLog } from '../types';

export interface ActivityLogDocument extends IActivityLog, Document {
  timestamp: Date;
}

const activityLogSchema = new Schema<ActivityLogDocument>({
  userId: {
    type: String,
    required: true,
    index: true
  },
  articleId: {
    type: String, // Stored as string ID to match interface
    required: true,
    index: true // Optimized for Article Stats Queries
  },
  action: {
    type: String,
    required: true,
    enum: ['view_analysis', 'view_comparison', 'share_article', 'read_external'],
    default: 'view_analysis'
  }
}, {
  timestamps: { createdAt: 'timestamp', updatedAt: false }
});

// Compound Indexes
activityLogSchema.index({ userId: 1, timestamp: -1 });
activityLogSchema.index({ userId: 1, action: 1, timestamp: -1 });

// --- NEW OPTIMIZATION: Feed Filtering ---
// Allows rapid lookup of "Has user X read article Y?" without full table scan
activityLogSchema.index({ userId: 1, articleId: 1 });

// --- DATA RETENTION: 6 MONTHS ---
// 15552000 seconds = ~180 days
activityLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 15552000 });

const ActivityLog: Model<ActivityLogDocument> = mongoose.model<ActivityLogDocument>('ActivityLog', activityLogSchema);

export default ActivityLog;
