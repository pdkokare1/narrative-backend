// src/routes/clusterRoutes.ts
import express, { Request, Response } from 'express';
import asyncHandler from '../utils/asyncHandler';
import validate from '../middleware/validate';
import schemas from '../utils/validationSchemas';
import Article from '../models/articleModel';

const router = express.Router();

// GET /api/cluster/:clusterId
router.get('/:clusterId', validate(schemas.clusterView, 'params'), asyncHandler(async (req: Request, res: Response) => {
    const { clusterId } = req.params;

    // Fetch all articles belonging to this cluster
    const articles = await Article.find({ clusterId: Number(clusterId) }).lean();

    if (!articles || articles.length === 0) {
        return res.status(404).json({ message: 'Cluster not found' });
    }

    // Bucketize them by political lean
    const response = {
        left: articles.filter(a => 
            a.analysisType !== 'SentimentOnly' && 
            (a.politicalLean === 'Left' || a.politicalLean === 'Left-Leaning')
        ),
        center: articles.filter(a => 
            a.analysisType !== 'SentimentOnly' && 
            a.politicalLean === 'Center'
        ),
        right: articles.filter(a => 
            a.analysisType !== 'SentimentOnly' && 
            (a.politicalLean === 'Right' || a.politicalLean === 'Right-Leaning')
        ),
        reviews: articles.filter(a => 
            a.analysisType === 'SentimentOnly'
        ),
        stats: {
            total: articles.length,
            topic: articles[0].clusterTopic
        }
    };

    res.status(200).json(response);
}));

export default router;
