// types/index.ts

// --- 1. Article Interface ---
// Defines exactly what a news article looks like in our system.
export interface IArticle {
  _id?: string; // MongoDB ID (optional because it's created by DB)
  headline: string;
  summary: string;
  source: string;
  category: string;
  politicalLean: string;
  url: string;
  imageUrl?: string;
  
  // Audio
  audioUrl?: string | null;
  
  publishedAt: Date;
  
  // Analysis Data
  analysisType: 'Full' | 'SentimentOnly';
  sentiment: 'Positive' | 'Negative' | 'Neutral';
  
  // Scores
  biasScore: number; // 0-100
  biasLabel?: string;
  biasComponents?: any; // We can make this stricter later
  
  credibilityScore: number;
  credibilityGrade?: string;
  credibilityComponents?: any;
  
  reliabilityScore: number;
  reliabilityGrade?: string;
  reliabilityComponents?: any;
  
  trustScore: number;
  trustLevel?: string;
  
  // Coverage Stats
  coverageLeft?: number;
  coverageCenter?: number;
  coverageRight?: number;
  
  // Clustering
  clusterId?: number;
  clusterTopic?: string;
  country: string;
  primaryNoun?: string;
  secondaryNoun?: string;
  
  // AI Vector
  embedding?: number[];
  
  keyFindings?: string[];
  recommendations?: string[];
  analysisVersion?: string;
  
  createdAt?: Date;
  updatedAt?: Date;
}

// --- 2. User Profile Interface ---
// Defines a user account.
export interface IUserProfile {
  userId: string; // Firebase UID
  email: string;
  username: string;
  
  // Stats
  articlesViewedCount: number;
  comparisonsViewedCount: number;
  articlesSharedCount: number;
  
  // Relationships
  savedArticles: string[]; // Array of Article IDs
  
  // Notifications
  fcmToken?: string | null;
  notificationsEnabled: boolean;
}

// --- 3. Activity Log Interface ---
// Defines a user action (view, share, etc.)
export interface IActivityLog {
  userId: string;
  articleId: string;
  action: 'view_analysis' | 'view_comparison' | 'share_article' | 'read_external';
  timestamp?: Date;
}

// --- 4. Emergency Contact Interface ---
export interface IEmergencyContact {
  category: string;
  serviceName: string;
  description?: string;
  number: string;
  scope: string; // e.g., "All India", "Mumbai"
  hours: string;
  country: string;
  isGlobal: boolean;
}

// --- 5. AI Prompt Interface ---
export interface IAIPrompt {
  type: 'ANALYSIS' | 'GATEKEEPER' | 'ENTITY_EXTRACTION';
  text: string;
  version: number;
  active: boolean;
  description?: string;
}
