// types/index.ts

// --- 1. Article Interface ---
export interface IArticle {
  _id?: string;
  headline: string;
  summary: string;
  content?: string; 
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

// --- NEW: Narrative Interface (The Meta-Summary) ---
export interface INarrative {
  _id?: string;
  clusterId: number;
  lastUpdated: Date;
  
  // The "Meta" Content
  masterHeadline: string;
  executiveSummary: string; 
  
  // Stats
  sourceCount: number;
  sources: string[]; // ["CNN", "Fox", "Reuters"]
  
  // The Deep Analysis
  consensusPoints: string[]; 
  divergencePoints: {
    point: string; // "Economic Impact"
    perspectives: {
      source: string;
      stance: string; // "Claims it will cause inflation"
    }[];
  }[];

  // Metadata
  category: string;
  country: string;
}

// --- 2. External News API Interfaces ---
export interface INewsSourceArticle {
  source: { id?: string; name: string };
  title: string;
  description: string;
  content?: string;
  url: string;
  image?: string;      
  urlToImage?: string; 
  publishedAt: string;
  score?: number;      
}

export interface INewsAPIResponse {
  status: string;
  totalResults: number;
  articles: INewsSourceArticle[];
}

// --- 3. Google Gemini Interfaces ---
export interface IGeminiPart {
  text: string;
}

export interface IGeminiContent {
  parts: IGeminiPart[];
  role?: string;
}

export interface IGeminiCandidate {
  content: IGeminiContent;
  finishReason?: string;
  safetyRatings?: any[];
}

export interface IGeminiResponse {
  candidates?: IGeminiCandidate[];
  promptFeedback?: any;
}

export interface IGeminiBatchResponse {
  embeddings: { values: number[] }[];
}

// --- 4. Gamification Interfaces ---
export interface IBadge {
  id: string;
  label: string;
  icon: string;
  description: string;
  earnedAt: Date;
}

// --- 5. User Profile Interface ---
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

// --- 6. Activity Log Interface ---
export interface IActivityLog {
  userId: string;
  articleId: string;
  action: 'view_analysis' | 'view_comparison' | 'share_article' | 'read_external';
  timestamp?: Date;
}

// --- 7. Emergency Contact Interface ---
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

// --- 8. AI Prompt Interface ---
export interface IAIPrompt {
  type: 'ANALYSIS' | 'GATEKEEPER' | 'ENTITY_EXTRACTION';
  text: string;
  version: number;
  active: boolean;
  description?: string;
}
