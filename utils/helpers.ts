// narrative-backend/utils/helpers.ts
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

// 5. Robust JSON Extractor
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

// 7. Dice Coefficient for String Similarity
export const getSimilarityScore = (str1: string, str2: string): number => {
    if (!str1 || !str2) return 0;
    
    const bigrams = (str: string) => {
        const s = str.toLowerCase().replace(/[^a-z0-9]/g, '');
        const res: string[] = []; 
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

// --- NEW: Text Complexity Calculator (Flesch-Kincaid) ---
export const calculateReadingComplexity = (text: string): number => {
    if (!text || text.length < 10) return 50; // Default to neutral

    // 1. Sentence Count
    const sentences = text.split(/[.!?]+/).filter(Boolean).length || 1;
    
    // 2. Word Count
    const words = text.split(/\s+/).filter(Boolean);
    const wordCount = words.length || 1;

    // 3. Syllable Count (Heuristic)
    let syllableCount = 0;
    words.forEach(word => {
        word = word.toLowerCase().replace(/[^a-z]/g, '');
        if (word.length <= 3) {
            syllableCount += 1;
        } else {
            // Count vowel groups
            const syllables = word.match(/[aeiouy]+/g);
            syllableCount += syllables ? syllables.length : 1;
            // Subtract silent 'e' at end
            if (word.endsWith('e')) syllableCount -= 1;
        }
    });
    if (syllableCount < 1) syllableCount = 1;

    // 4. Flesch Reading Ease Formula
    // 206.835 - 1.015(total words / total sentences) - 84.6(total syllables / total words)
    const score = 206.835 - (1.015 * (wordCount / sentences)) - (84.6 * (syllableCount / wordCount));

    // Clamp between 0 (Very Hard) and 100 (Very Easy)
    // We invert it for "Complexity": 100 = Complex, 0 = Simple
    const complexity = 100 - Math.max(0, Math.min(100, score));
    
    return Math.round(complexity);
};
