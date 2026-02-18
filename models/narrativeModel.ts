// src/models/narrativeModel.ts
import mongoose, { Schema, Document } from 'mongoose';
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

// REMOVED: The TTL index definition has been deleted to prevents auto-deletion.
// Ensure you have run db.narratives.dropIndex("updatedAt_1") in your database.

const Narrative = mongoose.model<NarrativeDocument>('Narrative', narrativeSchema, 'narratives');

export default Narrative;
