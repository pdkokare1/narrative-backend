// models/emergencyContactModel.ts
import mongoose, { Schema, Document, Model } from 'mongoose';
import { IEmergencyContact } from '../types';

export interface EmergencyContactDocument extends IEmergencyContact, Document {
  createdAt: Date;
  updatedAt: Date;
}

const emergencyContactSchema = new Schema<EmergencyContactDocument>({
  category: { 
    type: String, 
    required: true, 
    index: true 
  },
  serviceName: { 
    type: String, 
    required: true 
  },
  description: { 
    type: String 
  },
  number: { 
    type: String, 
    required: true 
  },
  scope: { 
    type: String, 
    required: true, 
    index: true 
  }, 
  hours: { 
    type: String, 
    default: '24x7' 
  },
  country: { 
    type: String, 
    default: 'India', 
    index: true 
  },
  isGlobal: { 
    type: Boolean, 
    default: false 
  }
}, {
  timestamps: true
});

const EmergencyContact: Model<EmergencyContactDocument> = mongoose.model<EmergencyContactDocument>('EmergencyContact', emergencyContactSchema);

export default EmergencyContact;
