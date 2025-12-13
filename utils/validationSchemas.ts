// utils/validationSchemas.ts
import Joi from 'joi';

const objectId = Joi.string().regex(/^[0-9a-fA-F]{24}$/).message('Invalid ID format');

const schemas = {
  createProfile: Joi.object({
    username: Joi.string().min(3).max(30).trim().required()
      .pattern(/^[a-zA-Z0-9_ ]+$/)
      .message('Username can only contain letters, numbers, underscores, and spaces'),
  }),

  logActivity: Joi.object({
    articleId: objectId.required(),
  }),

  feedFilters: Joi.object({
    category: Joi.string().optional(),
    lean: Joi.string().optional(),
    region: Joi.string().optional(),
    articleType: Joi.string().optional(),
    quality: Joi.string().optional(),
    sort: Joi.string().optional(),
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

  getAudio: Joi.object({
    text: Joi.string().min(10).max(5000).required(),
    articleId: objectId.required(),
    voiceId: Joi.string().optional()
  }),
  
  emergencyFilters: Joi.object({
    scope: Joi.string().optional(),
    country: Joi.string().optional()
  })
};

export = schemas;
