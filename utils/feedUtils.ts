// utils/feedUtils.ts
import { FeedFilters } from '../types';

/**
 * Builds the MongoDB query for fetching Articles based on filters.
 */
export const buildArticleQuery = (filters: FeedFilters) => {
    const { category, lean, region, articleType, quality } = filters;
    
    const query: any = {
        analysisVersion: { $ne: 'pending' }
    };
    
    // Category Filter
    if (category && category !== 'All Categories' && category !== 'All' && category !== 'undefined') {
        query.category = category;
    }

    // Political Lean Filter
    if (lean && lean !== 'All Leans' && lean !== 'undefined') {
        query.politicalLean = lean;
    }

    // Region Filter
    if (region === 'India') {
        query.country = 'India';
    } else if (region === 'Global') {
        query.country = { $ne: 'India' };
    }

    // Article Type Filter
    if (articleType === 'Hard News') {
        query.analysisType = 'Full';
    } else if (articleType === 'Opinion & Reviews') {
        query.analysisType = 'SentimentOnly';
    }

    // Quality/Credibility Filter
    if (quality && quality !== 'All Quality Levels') {
        const gradeMap: Record<string, string[]> = {
            'A+ Excellent (90-100)': ['A+'],
            'A High (80-89)': ['A', 'A-'],
            'B Professional (70-79)': ['B+', 'B', 'B-'],
            'C Acceptable (60-69)': ['C+', 'C', 'C-'],
            'D-F Poor (0-59)': ['D+', 'D', 'D-', 'F', 'D-F']
        };
        const grades = gradeMap[quality];
        if (grades) query.credibilityGrade = { $in: grades };
    }

    return query;
};

/**
 * Builds the MongoDB query for fetching Narratives based on filters.
 */
export const buildNarrativeQuery = (filters: FeedFilters) => {
    const { category, region } = filters;
    const narrativeQuery: any = {};

    if (category && category !== 'All Categories' && category !== 'All' && category !== 'undefined') {
        narrativeQuery.category = category;
    }
    
    if (region === 'India') {
        narrativeQuery.country = 'India';
    }

    // UPDATED: Extended window to 7 days to ensure narratives appear during dev/testing
    narrativeQuery.lastUpdated = { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) };

    return narrativeQuery;
};
