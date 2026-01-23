// narrative-backend/types/index.ts

// --- 1. Article Interface ---
export interface IArticle {
  _id?: string;
  type?: 'Article'; 
  
  // Core Content
  headline: string;
  summary: string;
  content?: string; 
  source: string;
  category: string;
  politicalLean: string;
  url: string;
  imageUrl?: string;
  audioUrl?: string | null;
  publishedAt: Date;
  
  // Analysis Data
  analysisType: 'Full' | 'SentimentOnly';
  sentiment: 'Positive' | 'Negative' | 'Neutral';
  analysisVersion?: string;
  
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
  clusterCount?: number;
  clusterTopic?: string;
  country: string;
  primaryNoun?: string;
  secondaryNoun?: string;
  
  // Feed Optimization (FIXED: Added this field)
  isLatest?: boolean;

  // AI Vector
  embedding?: number[];
  
  // Insights
  keyFindings?: string[];
  recommendations?: string[];
  suggestionType?: 'Comfort' | 'Challenge';
  
  createdAt?: Date;
  updatedAt?: Date;
}

// --- 2. Narrative Interface (The Meta-Summary) ---
export interface INarrative {
  _id?: string;
  type?: 'Narrative';
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

// --- 3. External News API Interfaces ---
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

// --- 4. Google Gemini Interfaces ---
export interface IGeminiPart {
  text: string;
}

export interface IGeminiContent {
  parts: IGeminiPart[];
  role?: string;
  parts_count?: number; // Optional helper
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

// --- 5. Gamification Interfaces ---
export interface IBadge {
  id: string;
  label: string;
  icon: string;
  description: string;
  earnedAt: Date;
}

// --- 6. User Profile Interface ---
export interface IUserProfile {
  userId: string;
  email: string;
  username: string;
  role?: IUserRole; // ADDED: For RBAC
  
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

// --- 7. Activity Log Interface ---
export interface IActivityLog {
  userId: string;
  articleId: string;
  action: 'view_analysis' | 'view_comparison' | 'share_article' | 'read_external';
  timestamp?: Date;
}

// --- 8. Emergency Contact Interface ---
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

// --- 9. AI Prompt Interface ---
export interface IAIPrompt {
  // UPDATED: Added 'SUMMARY_ONLY' to the allowed types
  type: 'ANALYSIS' | 'GATEKEEPER' | 'ENTITY_EXTRACTION' | 'SUMMARY_ONLY';
  text: string;
  version: number;
  active: boolean;
  description?: string;
}

// --- 10. NEW: Shared Service Interfaces ---

export type IUserRole = 'user' | 'admin' | 'moderator';

export interface FeedFilters {
    category?: string;
    lean?: string;
    politicalLean?: string; // ADDED
    sentiment?: string;     // ADDED
    source?: string;        // ADDED
    region?: string;
    articleType?: string;
    quality?: string;
    sort?: string;
    limit?: number | string;
    offset?: number | string;
    startDate?: string;     // ADDED
    endDate?: string;       // ADDED
    
    // NEW: Topic Filter for InFocus Bar
    topic?: string; 
}

export interface IServiceResponse<T> {
    success: boolean;
    data?: T;
    error?: string;
    meta?: any;
}

// Decoupled AI Service Interface (Future-Proofing)
export interface IAIService {
    analyzeArticle(article: Partial<IArticle>, model?: string): Promise<Partial<IArticle>>;
    generateNarrative(articles: IArticle[]): Promise<any>;
    createEmbedding(text: string): Promise<number[] | null>;
}
