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
    const { text, voiceId, articleId } = req.body;

    // 1. Check Database first (Cache Hit)
    const article = await Article.findById(articleId);
    
    if (article && article.audioUrl) {
        return res.status(200).json({ audioUrl: article.audioUrl });
    }

    // 2. Cache Miss: Generate New Audio
    const targetVoiceId = voiceId || '21m00Tcm4TlvDq8ikWAM'; 
    const newAudioUrl = await ttsService.generateAndUpload(text, targetVoiceId, articleId);

    // 3. Save to Database
    if (article) {
        article.audioUrl = newAudioUrl;
        await article.save();
    }

    res.status(200).json({ audioUrl: newAudioUrl });
}));

export default router;
