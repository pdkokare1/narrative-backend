// utils/validationSchemas.ts
import { z } from 'zod';

/**
 * Reusable Validation Rules
 */
const rules = {
    objectId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid ID format"),
    
    username: z.string()
        .min(3, "Username must be at least 3 characters")
        .max(20, "Username cannot exceed 20 characters")
        .regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores"),
    
    email: z.string().email("Invalid email address"),
    
    url: z.string().url("Invalid URL format"),

    // Pagination & Limits
    limit: z.coerce.number().min(1).max(100).default(12),
    page: z.coerce.number().min(1).default(1),
};

/**
 * Route Schemas
 */
const schemas = {
    // --- Profile Routes ---
    createProfile: z.object({
        body: z.object({
            username: rules.username,
        })
    }),

    updateProfile: z.object({
        body: z.object({
            username: rules.username.optional(),
            notificationsEnabled: z.boolean().optional(),
        }).refine(data => Object.keys(data).length > 0, {
            message: "At least one field must be provided for update"
        })
    }),

    saveToken: z.object({
        body: z.object({
            token: z.string().min(1, "Token is required")
        })
    }),

    // --- Article Interaction ---
    byId: z.object({
        params: z.object({
            id: rules.objectId
        })
    }),

    saveArticle: z.object({
        params: z.object({
            id: rules.objectId
        })
    }),

    // --- Search & Discovery (Strict Validation) ---
    search: z.object({
        query: z.object({
            q: z.string().trim().optional(),
            limit: rules.limit,
            // Filters
            category: z.string().optional(),
            politicalLean: z.string().optional()
        })
    }),

    // --- Feed Filters ---
    feedFilters: z.object({
        query: z.object({
            limit: rules.limit,
            cursor: z.string().optional(), // For infinite scroll
            category: z.string().optional(),
            politicalLean: z.string().optional(),
            country: z.string().optional(),
            source: z.string().optional()
        })
    }),

    // --- Trending ---
    trending: z.object({
        query: z.object({
            limit: rules.limit
        })
    }),

    // --- Legacy / Passthrough (For backwards compatibility) ---
    shareParams: z.object({
        params: z.object({ id: rules.objectId })
    }),
    
    logActivity: z.object({
        body: z.object({ articleId: rules.objectId })
    }),

    clusterView: z.object({
        query: z.object({ clusterId: z.string().optional() })
    }).passthrough(),

    emergencyFilters: z.object({}).passthrough(),
    
    getAudio: z.object({}).passthrough(),
    createCluster: z.object({}).passthrough(),
    updateCluster: z.object({}).passthrough(),
};

export default schemas;
