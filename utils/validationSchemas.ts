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
    offset: z.coerce.number().min(0).default(0), // Added offset support
};

/**
 * AI & Analysis Schemas (Aligned with Gemini 2.5 Pro capabilities)
 */
export const SentimentSchema = z.enum(["Positive", "Negative", "Neutral"]);

export const BasicAnalysisSchema = z.object({
  summary: z.string(),
  category: z.string(),
  sentiment: SentimentSchema.optional().default("Neutral")
});

// Detailed Component Schemas for Deep Analysis
const MetricComponentSchema = z.object({
    sentimentPolarity: z.number().optional(), 
    emotionalLanguage: z.number().optional(), 
    loadedTerms: z.number().optional(), 
    complexityBias: z.number().optional()
});

const SourceComponentSchema = z.object({
    sourceDiversity: z.number().optional(), 
    expertBalance: z.number().optional(), 
    attributionTransparency: z.number().optional()
});

const DemographicComponentSchema = z.object({
    genderBalance: z.number().optional(), 
    racialBalance: z.number().optional(), 
    ageRepresentation: z.number().optional()
});

const FramingComponentSchema = z.object({
    headlineFraming: z.number().optional(), 
    storySelection: z.number().optional(), 
    omissionBias: z.number().optional()
});

// The Main Analysis Schema
export const FullAnalysisSchema = z.object({
  summary: z.string(),
  category: z.string(),
  politicalLean: z.string().optional().default("Center"),
  sentiment: SentimentSchema.optional().default("Neutral"),
  
  // Primary Scores
  biasScore: z.union([z.number(), z.string()]).transform(val => Number(val) || 0),
  biasLabel: z.string().optional(),
  
  credibilityScore: z.union([z.number(), z.string()]).transform(val => Number(val) || 0),
  credibilityGrade: z.string().optional(),
  
  reliabilityScore: z.union([z.number(), z.string()]).transform(val => Number(val) || 0),
  reliabilityGrade: z.string().optional(),
  
  trustLevel: z.string().optional(),
  
  // Metadata & Taxonomy
  clusterTopic: z.string().optional(),
  country: z.string().optional(),
  primaryNoun: z.string().optional(),
  secondaryNoun: z.string().optional(),
  
  keyFindings: z.array(z.string()).optional().default([]),
  recommendations: z.array(z.string()).optional().default([]),

  // Complex Analysis Objects
  biasComponents: z.object({
      linguistic: MetricComponentSchema.optional(),
      sourceSelection: SourceComponentSchema.optional(),
      demographic: DemographicComponentSchema.optional(),
      framing: FramingComponentSchema.optional()
  }).optional(),

  credibilityComponents: z.object({
      sourceCredibility: z.number().optional(),
      factVerification: z.number().optional(),
      professionalism: z.number().optional(),
      evidenceQuality: z.number().optional(),
      transparency: z.number().optional(),
      audienceTrust: z.number().optional()
  }).optional(),

  reliabilityComponents: z.object({
      consistency: z.number().optional(),
      temporalStability: z.number().optional(),
      qualityControl: z.number().optional(),
      publicationStandards: z.number().optional(),
      correctionsPolicy: z.number().optional(),
      updateMaintenance: z.number().optional()
  }).optional()
});

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

    // --- Search & Discovery ---
    search: z.object({
        query: z.object({
            q: z.string().trim().optional(),
            limit: rules.limit,
            offset: rules.offset, // Added offset
            // Filters
            category: z.string().optional(),
            politicalLean: z.string().optional()
        })
    }),

    // --- Feed Filters ---
    feedFilters: z.object({
        query: z.object({
            limit: rules.limit,
            offset: rules.offset, // Added offset
            cursor: z.string().optional(),
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

    // --- Legacy / Passthrough ---
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
