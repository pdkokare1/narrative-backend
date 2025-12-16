// types/index.ts

// --- 1. Article Interface ---
export interface IArticle {
  _id?: string;
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
  biasComponents?: any;
  
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

// --- 2. External News API Interfaces (NEW) ---
export interface INewsSourceArticle {
  source: { id?: string; name: string };
  title: string;
  description: string;
  content?: string;
  url: string;
  image?: string;      // GNews style
  urlToImage?: string; // NewsAPI style
  publishedAt: string;
}

export interface INewsAPIResponse {
  status: string;
  totalResults: number;
  articles: INewsSourceArticle[];
}

// --- 3. Gamification Interfaces ---
export interface IBadge {
  id: string;
  label: string;
  icon: string;
  description: string;
  earnedAt: Date;
}

// --- 4. User Profile Interface ---
export interface IUserProfile {
  userId: string;
  email: string;
  username: string;
  
  articlesViewedCount: number;
  comparisonsViewedCount: number;
  articlesSharedCount: number;
  
  currentStreak: number;
  lastActiveDate?: Date;
  badges: IBadge[];
  
  savedArticles: string[];
  userEmbedding?: number[];

  fcmToken?: string | null;
  notificationsEnabled: boolean;
}

// --- 5. Activity Log Interface ---
export interface IActivityLog {
  userId: string;
  articleId: string;
  action: 'view_analysis' | 'view_comparison' | 'share_article' | 'read_external';
  timestamp?: Date;
}

// --- 6. Emergency Contact Interface ---
export interface IEmergencyContact {
  category: string;
  serviceName: string;
  description?: string;
  number: string;
  scope: string;
  hours: string;
  country: string;
  isGlobal: boolean;
}

// --- 7. AI Prompt Interface ---
export interface IAIPrompt {
  type: 'ANALYSIS' | 'GATEKEEPER' | 'ENTITY_EXTRACTION';
  text: string;
  version: number;
  active: boolean;
  description?: string;
}
