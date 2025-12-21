// utils/logger.ts
import pino from 'pino';

// Define custom levels to match your previous Winston setup
// Pino default levels: trace:10, debug:20, info:30, warn:40, error:50, fatal:60
const customLevels = {
  http: 25, // Positioned between debug and info
};

// Development: Pretty printing (Colors, readable timestamp)
// Production: JSON (Best for Railway/Cloud tools)
const transport = process.env.NODE_ENV === 'development' 
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard', // YYYY-mm-dd HH:MM:ss
        ignore: 'pid,hostname',
      },
    }
  : undefined;

const logger = pino({
  level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
  customLevels,
  // Mixin adds the level label string (e.g., "level": "info") instead of just number
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
  // Ensure we capture timestamps
  timestamp: pino.stdTimeFunctions.isoTime,
}, transport as any); 

// Extend type definition locally to allow .http() usage without TS errors
// (In a strict setup, we might declare this globally, but this works for direct usage)
const typedLogger = logger as typeof logger & { http: (msg: string, ...args: any[]) => void };

export default typedLogger;
