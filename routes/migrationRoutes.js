// routes/migrationRoutes.js
const express = require('express');
const router = express.Router();
const Article = require('../models/articleModel');
const aiService = require('../services/aiService');

// POST /api/migration/backfill
// Gives AI vectors to 10 old articles at a time
router.post('/backfill', async (req, res) => {
    try {
        // 1. Find articles that DON'T have a vector yet
        // We limit to 10 to prevent the server from timing out
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

        // 2. Loop through and fix them
        for (const article of articlesToFix) {
            try {
                // Generate the text to analyze
                const textToEmbed = `${article.headline}. ${article.summary}`;
                
                // Ask AI for the vector
                const embedding = await aiService.createEmbedding(textToEmbed);

                if (embedding) {
                    article.embedding = embedding;
                    await article.save();
                    successCount++;
                    console.log(`✅ Optimized: ${article.headline.substring(0, 30)}...`);
                }
            } catch (err) {
                console.error(`❌ Failed to fix article ${article._id}:`, err.message);
            }
        }

        // 3. Check how many are left
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

module.exports = router;
