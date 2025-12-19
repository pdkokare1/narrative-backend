// utils/helpers.ts
import config from './config';

// 1. Pause execution for X milliseconds
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// 2. Clean up messy text (HTML tags, extra spaces)
export const cleanText = (text: string): string => {
    if (!text) return "";
    // Remove HTML tags
    let clean = text.replace(/<[^>]*>?/gm, '');
    // Remove common "Read more" suffixes and [brackets]
    clean = clean.replace(/\[\+\d+\s?chars\]/g, ''); 
    clean = clean.replace(/\[.*?\]/g, ''); 
    // Normalize whitespace (turn multiple spaces/newlines into single space)
    return clean.replace(/\s+/g, ' ').trim();
};

// 3. Format Headlines (Capitalize first letter, ensure punctuation)
export const formatHeadline = (title: string): string => {
    if (!title) return "No Title";
    let clean = title.trim();
    // Capitalize first letter
    clean = clean.charAt(0).toUpperCase() + clean.slice(1);
    // Ensure it ends with punctuation if it's a sentence
    if (!/[.!?]["']?$/.test(clean)) {
        clean += ".";
    }
    return clean;
};

// 4. Smart URL Normalization (Stricter for Better Deduplication)
export const normalizeUrl = (url: string): string => {
    if (!url) return "";
    try {
        const urlObj = new URL(url);

        // A. Remove Fragment (#section)
        urlObj.hash = '';

        // B. Aggressive Query Parameter Removal
        // Most news sites use the path for the article ID (e.g., cnn.com/2024/01/story).
        // Query params are almost always for tracking or UI state, which breaks deduplication.
        
        // Exception: YouTube and some video sites need 'v' or 'id'
        const allowListDomains = ['youtube.com', 'youtu.be', 'vimeo.com'];
        const isAllowListed = allowListDomains.some(d => urlObj.hostname.includes(d));

        if (!isAllowListed) {
            // For standard news sites, STRIP ALL QUERY PARAMS.
            // This massively improves deduplication (e.g., ?utm_source=twitter vs ?mobile=1).
            urlObj.search = '';
        } else {
            // For allow-listed domains, only keep essential params (simplified)
            const keepParams = ['v', 'id', 'q'];
            const currentParams = new URLSearchParams(urlObj.search);
            const newParams = new URLSearchParams();
            
            keepParams.forEach(p => {
                if (currentParams.has(p)) newParams.set(p, currentParams.get(p)!);
            });
            urlObj.search = newParams.toString();
        }

        // C. Remove Trailing Slash (cnn.com/story/ == cnn.com/story)
        let finalUrl = urlObj.toString();
        if (finalUrl.endsWith('/')) {
            finalUrl = finalUrl.slice(0, -1);
        }

        return finalUrl;

    } catch (e) {
        return url; 
    }
};

// 5. Robust JSON Extractor (Prevents AI Parsing Crashes)
export const extractJSON = (text: string): string => {
    if (!text) return "{}";
    try {
        // If it's already clean JSON, return it
        JSON.parse(text);
        return text;
    } catch (e) {
        // Fallback: Find the first '{' and the last '}'
        const firstOpen = text.indexOf('{');
        const lastClose = text.lastIndexOf('}');
        
        if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
            return text.substring(firstOpen, lastClose + 1);
        }
        return "{}"; // Failed to find JSON object
    }
};

// 6. Centralized Admin Check Helper
// Determines if a user token represents an admin
export const isUserAdmin = (userToken: any): boolean => {
    if (!userToken) return false;

    // Check A: Is user in the hardcoded Allow-List? (Highest Priority)
    if (config.adminUids && config.adminUids.includes(userToken.uid)) {
        return true;
    }

    // Check B: Does user have the custom Firebase claim?
    if (userToken.admin === true) {
        return true;
    }

    return false;
};

/**
 * 7. Dice Coefficient for String Similarity
 * Returns a score between 0 (no match) and 1 (exact match).
 * Used for Fuzzy Deduplication of headlines.
 */
export const getSimilarityScore = (str1: string, str2: string): number => {
    if (!str1 || !str2) return 0;
    
    const bigrams = (str: string) => {
        const s = str.toLowerCase().replace(/[^a-z0-9]/g, '');
        const res: string[] = []; // <--- FIXED: Added Type Annotation
        for (let i = 0; i < s.length - 1; i++) {
            res.push(s.substring(i, i + 2));
        }
        return res;
    };

    const s1 = bigrams(str1);
    const s2 = bigrams(str2);
    
    if (s1.length === 0 || s2.length === 0) return 0;

    const intersection = s1.filter(val => s2.includes(val)).length;
    return (2 * intersection) / (s1.length + s2.length);
};
