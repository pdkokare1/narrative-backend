// models/cacheModel.ts
import mongoose, { Schema, Document, Model } from 'mongoose';

// Interface defined inline since it's internal utility
interface ICache {
  key: string;
  data: any;
  expiresAt: Date;
}

export interface CacheDocument extends ICache, Document {
  createdAt: Date;
  updatedAt: Date;
}

const cacheSchema = new Schema<CacheDocument>({
  key: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true 
  },
  data: { 
    type: Schema.Types.Mixed, 
    required: true 
  },
  expiresAt: { 
    type: Date, 
    required: true 
  }
}, { timestamps: true });

cacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Cache: Model<CacheDocument> = mongoose.model<CacheDocument>('Cache', cacheSchema);

export default Cache;
