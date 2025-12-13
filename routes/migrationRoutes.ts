// routes/migrationRoutes.ts
import express, { Request, Response } from 'express';
import Article from '../models/articleModel';
// @ts-ignore
import aiService from '../services/aiService';

const router = express.Router();

// POST /api/migration/backfill
router.post('/backfill', async (req: Request, res: Response) => {
    try {
        const articlesToFix = await Article.find({
            $or: [
                { embedding: { $exists: false } },
                { embedding: { $size: 0 } }
            ]
        }).limit(10); 

        if (articlesToFix.length === 0) {
            return res.status(200).json({ message: "🎉 All articles are optimized! No more work to do." });
        }

        let successCount = 0;

        for (const article of articlesToFix) {
            try {
                const textToEmbed = `${article.headline}. ${article.summary}`;
                const embedding = await aiService.createEmbedding(textToEmbed);

                if (embedding) {
                    article.embedding = embedding;
                    await article.save();
                    successCount++;
                    console.log(`✅ Optimized: ${article.headline.substring(0, 30)}...`);
                }
            } catch (err: any) {
                console.error(`❌ Failed to fix article ${article._id}:`, err.message);
            }
        }

        const remaining = await Article.countDocuments({
            $or: [{ embedding: { $exists: false } }, { embedding: { $size: 0 } }]
        });

        res.status(200).json({
            message: `Batch Complete. Fixed ${successCount} articles.`,
            remaining: remaining,
            instruction: remaining > 0 ? "⚠️ PLEASE RUN AGAIN to fix the rest." : "✅ ALL DONE"
        });

    } catch (error) {
        console.error("Migration Error:", error);
        res.status(500).json({ error: "Migration failed" });
    }
});

export default router;
