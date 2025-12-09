// models/cacheModel.js
const mongoose = require('mongoose');

const cacheSchema = new mongoose.Schema({
  key: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true 
  },
  data: { 
    type: mongoose.Schema.Types.Mixed, // Allows storing any JSON data (Arrays, Objects)
    required: true 
  },
  expiresAt: { 
    type: Date, 
    required: true 
  }
}, { timestamps: true });

// TTL Index: MongoDB will automatically delete the document when 'expiresAt' is reached
cacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Cache', cacheSchema);
