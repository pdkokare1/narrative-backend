// utils/constants.ts
import config from './config';

export const ONE_MINUTE = 60 * 1000;
export const FIFTEEN_MINUTES = 15 * 60 * 1000;

// --- CENTRAL CONFIGURATION ---
export const CONSTANTS = {
  // Error Codes
  ERROR_CODES: {
    AUTH_NO_APP_CHECK: 'AUTH_NO_APP_CHECK',
    AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
    AUTH_MISSING_TOKEN: 'AUTH_MISSING_TOKEN',
    ACCESS_DENIED: 'ACCESS_DENIED',
    NOT_FOUND: 'NOT_FOUND', // ADDED: Fixes the build error in adminController
  },

  // Rate Limiting
  RATE_LIMIT: {
    WINDOW_MS: FIFTEEN_MINUTES,
    API_MAX_REQUESTS: 1000,
    TTS_MAX_REQUESTS: 10,
  },

  // News Fetching & Processing
  NEWS: {
    BATCH_SIZE: 5,
    FETCH_LIMIT: 15,       // Max articles to fetch per source
    SEMANTIC_AGE_HOURS: 24, // If a similar article is older than this, re-analyze it
  },

  // Cache Settings & TTLs (Time To Live in Seconds)
  CACHE: {
    TTL_DEFAULT: 900,  // 15 mins
    TTL_SHORT: 300,    // 5 mins
    
    // Specific Use Cases
    TTL_TRENDING: 1800, // 30 mins
    TTL_FEED: 300,      // 5 mins
    TTL_SEARCH: 600,    // 10 mins
    TTL_PERSONAL: 900,  // 15 mins
  },
  
  // Timeouts (Standardized)
  TIMEOUTS: {
    EXTERNAL_API: 90000, // Updated: 90s for Gemini 2.5 Pro Deep Analysis
  },

  // AI Configuration (Gemini 2.5 Series - Dec 2025 Standard)
  AI_MODELS: {
    FAST: config.aiModels.fast,      // Defaults to "gemini-2.5-flash"
    QUALITY: config.aiModels.pro,    // Defaults to "gemini-2.5-pro"
    EMBEDDING: config.aiModels.embedding // Defaults to "text-embedding-004"
  },
  
  // Cost Control
  AI_LIMITS: {
      MAX_INPUT_CHARS: 300000, // ~75k tokens
      MIN_CONTENT_CHARS: 100, // Skip analysis if content is too thin
  },

  // Queue Configuration
  QUEUE: {
    NAME: 'news-fetch-queue',
  },

  // Redis Keys (Prevent typos)
  REDIS_KEYS: {
    BANNED_DOMAINS: 'GATEKEEPER:BANNED_DOMAINS',
    // CHANGED TO V5: Invalidate old decisions to apply new strict rules
    GATEKEEPER_CACHE: 'GATEKEEPER_DECISION_V5_', 
    TRENDING: 'trending_topics_smart',
    NEWS_CYCLE: 'news:fetch_cycle',
    NEWS_SEEN_PREFIX: 'news:seen:',
  }
};

// --- NEWS FETCH CYCLES ---
export const FETCH_CYCLES = [
    { name: 'US-Focus', gnews: { country: 'us' } },
    { name: 'IN-Focus', gnews: { country: 'in' } },
    { name: 'World-Focus', gnews: { topic: 'world' } }
];

// --- TRUSTED SOURCES (VIP List) ---
// Indian Hard News added. Tech/Science removed (they must now pass AI Audition).
export const TRUSTED_SOURCES = [
    // Global Wires
    'reuters', 'associated press', 'bloomberg', 'bbc', 'al jazeera', 'deutsche welle',
    
    // Financial/Policy
    'the wall street journal', 'financial times', 'the economist',
    'npr', 'pbs',
    
    // India "Hard News"
    'the indian express', 'the hindu', 'livemint', 'ndtv', 'business standard',
    'the print', 'scroll.in', 'ani news', 'deccan herald', 'the tribune'
];

// --- GLOBAL BLOCKLISTS ---
export const DEFAULT_BANNED_DOMAINS = [
    // Tabloids & Gossip
    'dailymail.co.uk', 'thesun.co.uk', 'nypost.com', 'tmz.com', 'perezhilton.com', 
    'mirror.co.uk', 'express.co.uk', 'dailystar.co.uk', 'radaronline.com',
    
    // Clickbait & Viral
    'buzzfeed.com', 'upworthy.com', 'viralnova.com', 'clickhole.com', 
    'ladbible.com', 'unilad.com', 'boredpanda.com',
    
    // Satire
    'theonion.com', 'babylonbee.com', 'duffelblog.com', 'newyorker.com/humor',
    
    // Propaganda / Extreme Bias
    'infowars.com', 'sputniknews.com', 'rt.com', 'breitbart.com', 'naturalnews.com',
    
    // Shopping / PR Wires
    'prweb.com', 'businesswire.com', 'prnewswire.com', 'globenewswire.com',
    'marketwatch.com'
];

// --- JUNK KEYWORDS (The "Trap") ---
// Any title containing these gets a -20 penalty (Immediate Deletion).
// SAFETY UPDATE: Removed 'feud', 'drama', 'shocking', 'reveals' to protect Hard News.
export const JUNK_KEYWORDS = [
    // Lifestyle Blacklist (Strictly Non-News)
    'dating', 'relationship advice', 'tips for', 'diet', 'weight loss', 
    'workout', 'fashion', 'beauty', 'outfit', 'skin care', 'hairstyle', 
    'makeup', 'gift idea',
    
    // Shopping & Deals
    'coupon', 'promo code', 'discount', 'deal of the day', 'price drop', 'bundle',
    'shopping', 'gift guide', 'best buy', 'amazon prime', 'black friday', 
    'cyber monday', 'sale', '% off', 'where to buy', 'restock', 'clearance',
    'bargain', 'doorbuster', 'cheapest', 'affiliate link',
    
    // Gaming Guides
    'wordle', 'connections hint', 'connections answer', 'crossword', 'sudoku', 
    'daily mini', 'spoilers', 'walkthrough', 'guide', 'today\'s answer', 'quordle',
    'patch notes', 'loadout', 'tier list', 'how to get', 'where to find', 
    'twitch drops', 'codes for',
    
    // Fluff
    'horoscope', 'zodiac', 'astrology', 'tarot', 'psychic', 'manifesting',
    'celeb look', 'red carpet', 'net worth',
    
    // Gambling
    'powerball', 'mega millions', 'lottery results', 'winning numbers', 
    'betting odds', 'prediction', 'parlay', 'gambling',
    
    // Admin / Paywall
    'subscribe now', 'sign up', 'newsletter', 'login', 'register',
    'have an account?', 'exclusive content', 'premium', 'giveaway'
];
