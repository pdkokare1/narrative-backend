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

    // --- Share/Public Routes ---
    shareParams: z.object({
        params: z.object({
            id: rules.objectId
        })
    }),

    // --- Generic ID Param ---
    byId: z.object({
        params: z.object({
            id: rules.objectId
        })
    })
};

export default schemas;
