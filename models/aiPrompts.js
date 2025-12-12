// models/aiPrompts.js
const mongoose = require('mongoose');

const promptSchema = new mongoose.Schema({
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

module.exports = mongoose.model('Prompt', promptSchema);
