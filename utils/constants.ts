// utils/constants.ts

export const ONE_MINUTE = 60 * 1000;
export const FIFTEEN_MINUTES = 15 * 60 * 1000;

// --- CENTRAL CONFIGURATION ---
export const CONSTANTS = {
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

  // Cache Settings
  CACHE: {
    TTL_DEFAULT: 900, // 15 mins (in seconds)
    TTL_SHORT: 300,   // 5 mins
  },
  
  // Timeouts (Standardized)
  TIMEOUTS: {
    EXTERNAL_API: 15000, // 15 seconds
  },

  // AI Configuration
  AI_MODELS: {
    FAST: "gemini-2.5-flash", // For Gatekeeper & Quick Checks
    QUALITY: "gemini-2.5-pro", // For Deep Analysis
    EMBEDDING: "text-embedding-004"
  },

  // Queue Configuration (Centralized)
  QUEUE: {
    NAME: 'news-fetch-queue',
  },

  // Redis Keys (Prevent typos)
  REDIS_KEYS: {
    BANNED_DOMAINS: 'GATEKEEPER:BANNED_DOMAINS',
    GATEKEEPER_CACHE: 'GATEKEEPER_DECISION_',
    TRENDING: 'trending_topics_smart',
    NEWS_CYCLE: 'news:fetch_cycle',
  }
};

// --- NEWS FETCH CYCLES ---
// Controls which regions/topics we rotate through to keep content diverse
export const FETCH_CYCLES = [
    { name: 'US-Focus', gnews: { country: 'us' }, newsapi: { country: 'us' } },
    { name: 'IN-Focus', gnews: { country: 'in' }, newsapi: { country: 'in' } },
    { name: 'World-Focus', gnews: { topic: 'world' }, newsapi: { q: 'international', language: 'en' } }
];

// --- TRUSTED SOURCES (Boost Score) ---
export const TRUSTED_SOURCES = [
    'reuters', 'associated press', 'bloomberg', 'bbc', 'npr', 'pbs', 
    'the wall street journal', 'financial times', 'deutsche welle', 
    'al jazeera english', 'the economist', 'nature', 'science',
    'the indian express', 'the hindu', 'livemint'
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
    'prweb.com', 'businesswire.com', 'prnewswire.com', 'globenewswire.com'
];

export const JUNK_KEYWORDS = [
    // Shopping & Deals
    'coupon', 'promo code', 'discount', 'deal of the day', 'price drop', 'bundle',
    'shopping', 'gift guide', 'best buy', 'amazon prime', 'black friday', 
    'cyber monday', 'sale', '% off', 'where to buy', 'restock', 'clearance',
    'bargain', 'doorbuster', 'cheapest',
    
    // Gaming Guides
    'wordle', 'connections hint', 'connections answer', 'crossword', 'sudoku', 
    'daily mini', 'spoilers', 'walkthrough', 'guide', 'today\'s answer', 'quordle',
    'patch notes', 'loadout', 'tier list', 'how to get', 'where to find', 
    'twitch drops', 'codes for',
    
    // Fluff & Lifestyle
    'horoscope', 'zodiac', 'astrology', 'tarot', 'psychic', 'manifesting',
    'celeb look', 'red carpet', 'outfit', 'dress', 'fashion', 'makeup',
    'royal family', 'kardashian', 'jenner', 'relationship timeline', 'net worth',
    
    // Clickbait Phrases
    'watch:', 'video:', 'photos:', 'gallery:', 'live:', 'live updates', 
    'you need to know', 'here\'s why', 'what we know', 'everything we know',
    'reaction', 'reacts to', 'internet is losing it', 'fans are',
    
    // Gambling / Lottery
    'powerball', 'mega millions', 'lottery results', 'winning numbers', 
    'betting odds', 'prediction', 'parlay', 'gambling'
];
