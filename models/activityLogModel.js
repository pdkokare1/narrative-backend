// In file: models/activityLogModel.js
const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    index: true
  },
  articleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Article', // Links to the Article model
    required: true
  },
  action: {
    type: String,
    required: true,
    enum: ['view_analysis', 'view_comparison', 'share_article', 'read_external'], // Added read_external
    default: 'view_analysis'
  }
}, {
  timestamps: { createdAt: 'timestamp' } // We will use 'timestamp' for when it happened
});

// Compound index for fast user lookups
activityLogSchema.index({ userId: 1, timestamp: -1 });
// Index for fetching stats based on action
activityLogSchema.index({ userId: 1, action: 1, timestamp: -1 });


module.exports = mongoose.model('ActivityLog', activityLogSchema);
