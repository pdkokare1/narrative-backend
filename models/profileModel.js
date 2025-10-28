// In file: models/profileModel.js
const mongoose = require('mongoose');

const profileSchema = new mongoose.Schema({
  // This links the profile to the Firebase Auth user
  userId: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true 
  },
  email: { 
    type: String, 
    required: true, 
    unique: true 
  },
  username: { 
    type: String, 
    required: true, 
    unique: true, 
    trim: true 
  },
  // We will use this for User Stats!
  articlesViewedCount: { 
    type: Number, 
    default: 0 
  },
  // --- ADD THESE TWO LINES ---
  comparisonsViewedCount: {
    type: Number,
    default: 0
  },
  articlesSharedCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true // Adds createdAt and updatedAt
});

module.exports = mongoose.model('Profile', profileSchema);
