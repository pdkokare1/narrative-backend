// models/emergencyContactModel.js
const mongoose = require('mongoose');

const emergencyContactSchema = new mongoose.Schema({
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
  // Scope helps us filter between "National" vs "Local"
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
  // Use this to show/hide generic global numbers if we add them later
  isGlobal: { 
    type: Boolean, 
    default: false 
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('EmergencyContact', emergencyContactSchema);
