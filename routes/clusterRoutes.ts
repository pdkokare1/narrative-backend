// src/routes/clusterRoutes.ts
import express, { Request, Response } from 'express';
import mongoose from 'mongoose'; // Added for ObjectId validation
import asyncHandler from '../utils/asyncHandler';
import Article from '../models/articleModel';

const router = express.Router();

// GET /api/cluster/:identifier
router.get('/:clusterId', asyncHandler(async (req: Request, res: Response) => {
    const { clusterId: identifier } = req.params;

    let targetClusterId: number | null = null;

    // --- SMART RESOLUTION LOGIC ---
    // 1. Check if the identifier looks like a MongoDB Article ID (24 hex chars)
    if (mongoose.Types.ObjectId.isValid(identifier)) {
        // It's likely an Article ID. Find the article to get its clusterId.
        const article = await Article.findById(identifier).select('clusterId').lean();
        if (article && article.clusterId) {
            targetClusterId = article.clusterId;
        }
    }

    // 2. If resolution failed (or it wasn't an Article ID), try parsing as a direct Cluster ID (Number)
    if (targetClusterId === null) {
        const parsedId = Number(identifier);
        if (!isNaN(parsedId)) {
            targetClusterId = parsedId;
        }
    }

    // 3. If we still don't have a valid Cluster ID, return 404
    if (targetClusterId === null) {
        return res.status(404).json({ message: 'Cluster not found or invalid ID provided' });
    }

    // --- FETCH CLUSTER DATA ---
    // Fetch all articles belonging to this cluster
    const articles = await Article.find({ clusterId: targetClusterId }).lean();

    if (!articles || articles.length === 0) {
        return res.status(404).json({ message: 'No articles found for this cluster' });
    }

    // --- BUCKETIZE ARTICLES ---
    // We categorize them to help the frontend, but we must ensure NO article is lost.
    
    const leftArticles = articles.filter(a => 
        a.analysisType !== 'SentimentOnly' && 
        (a.politicalLean === 'Left' || a.politicalLean === 'Left-Leaning')
    );

    const centerArticles = articles.filter(a => 
        a.analysisType !== 'SentimentOnly' && 
        a.politicalLean === 'Center'
    );

    const rightArticles = articles.filter(a => 
        a.analysisType !== 'SentimentOnly' && 
        (a.politicalLean === 'Right' || a.politicalLean === 'Right-Leaning')
    );

    const reviewArticles = articles.filter(a => 
        a.analysisType === 'SentimentOnly'
    );

    // COLLECT IDS OF CLASSIFIED ARTICLES TO FIND THE REMAINDER
    const classifiedIds = new Set([
        ...leftArticles.map(a => a._id.toString()),
        ...centerArticles.map(a => a._id.toString()),
        ...rightArticles.map(a => a._id.toString()),
        ...reviewArticles.map(a => a._id.toString())
    ]);

    // ANYTHING ELSE (Neutral, Undefined, Satire, etc.) GOES HERE
    const otherArticles = articles.filter(a => !classifiedIds.has(a._id.toString()));

    const response = {
        left: leftArticles,
        center: centerArticles,
        right: rightArticles,
        reviews: reviewArticles,
        others: otherArticles, // New Bucket
        stats: {
            total: articles.length,
            topic: articles[0]?.clusterTopic || 'Unknown Topic'
        }
    };

    res.status(200).json(response);
}));

export default router;
