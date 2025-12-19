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
        const allowListDomains = ['youtube.com', 'youtu.be', 'vimeo.com'];
        const isAllowListed = allowListDomains.some(d => urlObj.hostname.includes(d));

        if (!isAllowListed) {
            urlObj.search = '';
        } else {
            const keepParams = ['v', 'id', 'q'];
            const currentParams = new URLSearchParams(urlObj.search);
            const newParams = new URLSearchParams();
            
            keepParams.forEach(p => {
                if (currentParams.has(p)) newParams.set(p, currentParams.get(p)!);
            });
            urlObj.search = newParams.toString();
        }

        // C. Remove Trailing Slash
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
        JSON.parse(text);
        return text;
    } catch (e) {
        const firstOpen = text.indexOf('{');
        const lastClose = text.lastIndexOf('}');
        
        if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
            return text.substring(firstOpen, lastClose + 1);
        }
        return "{}"; 
    }
};

// 6. Centralized Admin Check Helper
export const isUserAdmin = (userToken: any): boolean => {
    if (!userToken) return false;
    if (config.adminUids && config.adminUids.includes(userToken.uid)) return true;
    if (userToken.admin === true) return true;
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
        const res = [];
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
