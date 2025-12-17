// utils/validationSchemas.ts
import { z } from 'zod';

// Helper for MongoDB ObjectId
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid ID format');

const schemas = {
  createProfile: z.object({
    username: z.string().min(3).max(30).trim()
      .regex(/^[a-zA-Z0-9_ ]+$/, 'Username can only contain letters, numbers, underscores, and spaces'),
  }),

  // --- NEW: Added Missing Schema ---
  updateProfile: z.object({
    username: z.string().min(3).max(30).trim()
      .regex(/^[a-zA-Z0-9_ ]+$/, 'Username can only contain letters, numbers, underscores, and spaces')
      .optional(),
    notificationsEnabled: z.boolean().optional()
  }),

  logActivity: z.object({
    articleId: objectId,
  }),

  feedFilters: z.object({
    category: z.string().optional(),
    lean: z.string().optional(),
    region: z.string().optional(),
    articleType: z.string().optional(),
    quality: z.string().optional(),
    sort: z.string().optional(),
    // Use z.coerce to correctly handle numbers from URL query strings
    limit: z.coerce.number().int().min(1).max(50).default(12),
    offset: z.coerce.number().int().min(0).default(0),
  }),

  search: z.object({
    q: z.string().trim().min(1).max(100),
    limit: z.coerce.number().int().min(1).max(50).default(12)
  }),

  clusterView: z.object({
    clusterId: z.coerce.number().int().positive()
  }),

  saveArticle: z.object({
    id: objectId
  }),

  getAudio: z.object({
    text: z.string().min(10).max(5000),
    articleId: objectId,
    voiceId: z.string().optional()
  }),
  
  emergencyFilters: z.object({
    scope: z.string().optional(),
    country: z.string().optional()
  })
};

export default schemas;
