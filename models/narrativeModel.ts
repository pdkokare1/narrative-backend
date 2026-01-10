// models/narrativeModel.ts
import mongoose, { Schema, Document, Model } from 'mongoose';
import { INarrative } from '../types';

export interface NarrativeDocument extends Omit<INarrative, '_id'>, Document {}

const narrativeSchema = new Schema<NarrativeDocument>({
  clusterId: { type: Number, required: true, unique: true, index: true },
  lastUpdated: { type: Date, default: Date.now },

  // The "Meta" Content
  masterHeadline: { type: String, required: true, trim: true },
  executiveSummary: { type: String, required: true },

  // Stats
  sourceCount: { type: Number, default: 0 },
  sources: [{ type: String }], 

  // The Deep Analysis
  consensusPoints: [{ type: String }],
  divergencePoints: [{
    point: String,
    perspectives: [{
      source: String,
      stance: String
    }]
  }],

  // Metadata for filtering
  category: { type: String, index: true },
  country: { type: String, index: true }
}, {
  timestamps: true 
});

// TTL: Delete narratives after 14 days to save space
// DISABLED for debugging to prevent data loss on older sets
// narrativeSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 1209600 });

// FIXED: Explicitly bind to 'narratives' collection to prevent naming mismatches
const Narrative = mongoose.model<NarrativeDocument>('Narrative', narrativeSchema, 'narratives');

export default Narrative;
