// routes/ttsRoutes.ts
import express, { Request, Response } from 'express';
import ttsService from '../services/ttsService';
import Article from '../models/articleModel'; 
import asyncHandler from '../utils/asyncHandler';
import validate from '../middleware/validate';
import schemas from '../utils/validationSchemas';

const router = express.Router();

// --- Generate/Get Audio ---
router.post('/get-audio', validate(schemas.getAudio), asyncHandler(async (req: Request, res: Response) => {
    const { text, voiceId, articleId, prefetch } = req.body;

    // 1. Check Database first (Cache Hit)
    const article = await Article.findById(articleId);
    
    if (article && article.audioUrl) {
        // If audio exists, return it immediately
        return res.status(200).json({ audioUrl: article.audioUrl, status: 'cached' });
    }

    const targetVoiceId = voiceId || '21m00Tcm4TlvDq8ikWAM'; 

    // 2. Handle Prefetch (Fire and Forget)
    if (prefetch) {
        // Start generation in background, don't wait
        ttsService.generateAndUpload(text, targetVoiceId, articleId)
            .then(async (url) => {
                if (article) {
                    article.audioUrl = url;
                    await article.save();
                    console.log(`🎙️ Prefetch Complete for: ${articleId}`);
                }
            })
            .catch(err => console.error(`❌ Prefetch Failed for ${articleId}:`, err.message));

        // Return immediately
        return res.status(202).json({ message: 'Audio generation started in background', status: 'processing' });
    }

    // 3. Normal Request (Wait for generation)
    // If user clicked "Listen" and it wasn't ready, they wait here.
    try {
        const newAudioUrl = await ttsService.generateAndUpload(text, targetVoiceId, articleId);
        
        if (article) {
            article.audioUrl = newAudioUrl;
            await article.save();
        }

        res.status(200).json({ audioUrl: newAudioUrl, status: 'generated' });
    } catch (error) {
        res.status(500).json({ error: 'Audio generation failed' });
    }
}));

export default router;
