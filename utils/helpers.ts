// utils/helpers.ts

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

// 4. Smart URL Normalization (Balanced: Safe but Clean)
export const normalizeUrl = (url: string): string => {
    if (!url) return "";
    try {
        const urlObj = new URL(url);

        // A. Remove Fragment (#section)
        urlObj.hash = '';

        // B. Robust Tracking Parameter Removal
        // We strip these from ALL URLs because they are never needed for the article itself.
        const trackingParams = [
            'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
            'fbclid', 'gclid', 'igsh', '_ga', 'yclid', 'msclkid', 'ref', 'source', 
            'context', 'si' 
        ];
        trackingParams.forEach(param => urlObj.searchParams.delete(param));

        // C. Conditional Deep Cleaning
        // If the path is a long "slug" (e.g. /2024/01/my-news-story), the query string is likely junk.
        // But if the path is short (e.g. /article), the query string might contain the ID (?id=123).
        
        const isLongPath = urlObj.pathname.length > 20;
        const isPhpOrAsp = urlObj.pathname.endsWith('.php') || urlObj.pathname.endsWith('.asp');
        
        // Only strip ALL params if it's a long path AND not a script file like index.php
        if (isLongPath && !isPhpOrAsp) {
            urlObj.search = '';
        }

        // D. Remove Trailing Slash (cnn.com/story/ == cnn.com/story)
        let finalUrl = urlObj.toString();
        if (finalUrl.endsWith('/')) {
            finalUrl = finalUrl.slice(0, -1);
        }

        return finalUrl;

    } catch (e) {
        return url; 
    }
};

// 5. Robust JSON Extractor (New: Prevents AI Parsing Crashes)
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
