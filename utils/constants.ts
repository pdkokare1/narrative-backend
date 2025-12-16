// utils/constants.ts

export const ONE_MINUTE = 60 * 1000;
export const FIFTEEN_MINUTES = 15 * 60 * 1000;

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
  
  // Timeouts
  TIMEOUTS: {
    EXTERNAL_API: 30000, // 30 seconds
  }
};
