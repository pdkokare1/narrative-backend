// utils/helpers.ts

// 1. Pause execution for X milliseconds
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// 2. Clean up messy text (HTML tags, extra spaces)
export const cleanText = (text: string): string => {
    if (!text) return "";
    // Remove HTML tags
    let clean = text.replace(/<[^>]*>?/gm, '');
    // Remove common "Read more" suffixes
    clean = clean.replace(/\[\+\d+\s?chars\]/g, ''); 
    // Normalize whitespace
    return clean.replace(/\s+/g, ' ').trim();
};

// 3. Format Headlines (Capitalize first letter, ensure punctuation)
export const formatHeadline = (title: string): string => {
    if (!title) return "No Title";
    let clean = title.trim();
    clean = clean.charAt(0).toUpperCase() + clean.slice(1);
    if (!/[.!?]["']?$/.test(clean)) {
        clean += ".";
    }
    return clean;
};

// 4. Normalize URLs (Remove tracking parameters)
export const normalizeUrl = (url: string): string => {
    if (!url) return "";
    try {
        const urlObj = new URL(url);
        const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'source', 'fbclid', 'gclid'];
        trackingParams.forEach(param => urlObj.searchParams.delete(param));
        return urlObj.toString();
    } catch (e) {
        return url; 
    }
};
