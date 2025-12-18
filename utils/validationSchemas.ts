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
};

/**
 * Route Schemas
 */
const schemas = {
    // --- Profile Routes (New Strict Style) ---
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

    // --- Share/Public Routes ---
    shareParams: z.object({
        params: z.object({
            id: rules.objectId
        })
    }),

    byId: z.object({
        params: z.object({
            id: rules.objectId
        })
    }),

    // --- Activity & Logging (Restored) ---
    logActivity: z.object({
        body: z.object({
            articleId: rules.objectId
        })
    }),

    // --- Search & Feeds (Restored) ---
    search: z.object({
        // Allow any query parameters for search
    }).passthrough(),

    feedFilters: z.object({
        // Allow any query parameters for filtering
    }).passthrough(),

    saveArticle: z.object({
        id: rules.objectId
    }),

    clusterView: z.object({
        clusterId: z.string()
    }),

    // --- Legacy / Restored Schemas (Fixes Deployment) ---
    // These allow existing routes to function without changes.
    
    emergencyFilters: z.object({
        // Placeholder: Allows any query params for now to unblock build
    }).passthrough(),

    getAudio: z.object({
        text: z.string().optional(),
        articleId: z.string().optional(),
        voiceId: z.string().optional()
    }).passthrough(),
    
    // Add generic placeholders for other potentially missing keys
    createCluster: z.object({}).passthrough(),
    updateCluster: z.object({}).passthrough(),
};

export default schemas;
