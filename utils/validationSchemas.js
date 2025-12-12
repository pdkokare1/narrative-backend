// utils/validationSchemas.js
const Joi = require('joi');

// Reusable validators
const objectId = Joi.string().regex(/^[0-9a-fA-F]{24}$/).message('Invalid ID format');

const schemas = {
  // --- Profile Routes ---
  createProfile: Joi.object({
    username: Joi.string().min(3).max(30).trim().required()
      .pattern(/^[a-zA-Z0-9_ ]+$/)
      .message('Username can only contain letters, numbers, underscores, and spaces'),
  }),

  // --- Activity Routes ---
  logActivity: Joi.object({
    articleId: objectId.required(),
    // Allow action to be optional if the route implies it (e.g., specific endpoints), 
    // or strictly require it if using a generic log route.
    // For specific routes like /log-view, we might only validate articleId in the body.
  }),

  // --- Article Routes ---
  feedFilters: Joi.object({
    category: Joi.string().valid(
      'All Categories', 'Politics', 'Global Conflict', 'Economy', 'Business', 
      'Justice', 'Science', 'Tech', 'Health', 'Education', 'Sports', 
      'Entertainment', 'Lifestyle', 'Human Interest', 'Other'
    ).optional(),
    lean: Joi.string().valid(
      'All Leans', 'Left', 'Left-Leaning', 'Center', 'Right-Leaning', 'Right'
    ).optional(),
    region: Joi.string().valid('Global', 'India', 'All').optional(),
    articleType: Joi.string().valid('All Types', 'Hard News', 'Opinion & Reviews').optional(),
    quality: Joi.string().optional(),
    sort: Joi.string().valid('Latest First', 'Highest Quality', 'Most Covered', 'Lowest Bias').optional(),
    limit: Joi.number().integer().min(1).max(50).default(12),
    offset: Joi.number().integer().min(0).default(0),
  }),

  search: Joi.object({
    q: Joi.string().trim().min(1).max(100).required(),
    limit: Joi.number().integer().min(1).max(50).default(12)
  }),

  clusterView: Joi.object({
    clusterId: Joi.number().integer().positive().required()
  }),

  saveArticle: Joi.object({
    id: objectId.required()
  }),

  // --- TTS Routes ---
  getAudio: Joi.object({
    text: Joi.string().min(10).max(5000).required(),
    articleId: objectId.required(),
    voiceId: Joi.string().optional()
  }),
  
  // --- Emergency Routes ---
  emergencyFilters: Joi.object({
    scope: Joi.string().optional(),
    country: Joi.string().optional()
  })
};

module.exports = schemas;
