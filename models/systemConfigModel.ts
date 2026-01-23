// narrative-backend/models/systemConfigModel.ts
import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ISystemConfig extends Document {
  key: string;
  value: any; // Changed from string[] to any (Mixed) to support JSON objects
  description?: string; // Added for UI clarity
  lastUpdated: Date;
}

const systemConfigSchema = new Schema<ISystemConfig>({
  key: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true 
  },
  value: { 
    type: Schema.Types.Mixed, // Allows Strings, Numbers, Arrays, or Objects
    required: true
  },
  description: {
    type: String,
    default: ''
  },
  lastUpdated: { 
    type: Date, 
    default: Date.now 
  }
});

const SystemConfig: Model<ISystemConfig> = mongoose.model<ISystemConfig>('SystemConfig', systemConfigSchema);

export default SystemConfig;
