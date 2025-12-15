// models/systemConfigModel.ts
import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ISystemConfig extends Document {
  key: string;
  value: string[];
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
    type: [String], 
    default: [] 
  },
  lastUpdated: { 
    type: Date, 
    default: Date.now 
  }
});

const SystemConfig: Model<ISystemConfig> = mongoose.model<ISystemConfig>('SystemConfig', systemConfigSchema);

export default SystemConfig;
