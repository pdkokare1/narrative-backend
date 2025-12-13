// models/aiPrompts.ts
import mongoose, { Schema, Document, Model } from 'mongoose';
import { IAIPrompt } from '../types';

export interface PromptDocument extends IAIPrompt, Document {
  createdAt: Date;
  updatedAt: Date;
}

const promptSchema = new Schema<PromptDocument>({
  type: { 
    type: String, 
    required: true, 
    unique: true, 
    enum: ['ANALYSIS', 'GATEKEEPER', 'ENTITY_EXTRACTION'] 
  },
  text: { 
    type: String, 
    required: true 
  },
  version: {
    type: Number,
    default: 1
  },
  active: {
    type: Boolean,
    default: true
  },
  description: String
}, {
  timestamps: true
});

const Prompt: Model<PromptDocument> = mongoose.model<PromptDocument>('Prompt', promptSchema);

export default Prompt;
