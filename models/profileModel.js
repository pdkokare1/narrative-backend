// models/profileModel.js
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
  // User Stats
  articlesViewedCount: { 
    type: Number, 
    default: 0 
  },
  comparisonsViewedCount: {
    type: Number,
    default: 0
  },
  articlesSharedCount: {
    type: Number,
    default: 0
  },
  // Saved Articles Link
  savedArticles: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Article' // Links to Article model
  }]
}, {
  timestamps: true
});

// CRITICAL: This must define 'Profile', NOT 'Prompt'
module.exports = mongoose.model('Profile', profileSchema);
