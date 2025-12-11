// routes/assetGenRoutes.js
const express = require('express');
const router = express.Router();
const ttsService = require('../services/ttsService');

// --- THE 30 SEGUE SCRIPTS (Updated for Intonation) ---
// Note: We use commas (,) to force "Suspended Intonation"
const SEGUES = [
    // --- MIRA (Anchor) ---
    { id: "mira_segue_01", text: "In other developments,", voiceId: "SmLgXu8CcwHJvjiqq2rw" },
    { id: "mira_segue_02", text: "Moving on,", voiceId: "SmLgXu8CcwHJvjiqq2rw" },
    { id: "mira_segue_03", text: "Turning to other news,", voiceId: "SmLgXu8CcwHJvjiqq2rw" },
    { id: "mira_segue_04", text: "Also making headlines,", voiceId: "SmLgXu8CcwHJvjiqq2rw" },
    { id: "mira_segue_05", text: "Staying with the top stories,", voiceId: "SmLgXu8CcwHJvjiqq2rw" },
    { id: "mira_segue_06", text: "Elsewhere in the news,", voiceId: "SmLgXu8CcwHJvjiqq2rw" },
    { id: "mira_segue_07", text: "Shifting our focus,", voiceId: "SmLgXu8CcwHJvjiqq2rw" },
    { id: "mira_segue_08", text: "Focusing now on this,", voiceId: "SmLgXu8CcwHJvjiqq2rw" },
    { id: "mira_segue_09", text: "Here is another story we are tracking,", voiceId: "SmLgXu8CcwHJvjiqq2rw" },
    { id: "mira_segue_10", text: "Continuing with our coverage,", voiceId: "SmLgXu8CcwHJvjiqq2rw" },

    // --- RAJAT (Analyst) - Voice: SZQ4R1VKS2t6wmBJpK5H ---
    { id: "rajat_segue_01", text: "Also in the news,", voiceId: "SZQ4R1VKS2t6wmBJpK5H" },
    { id: "rajat_segue_02", text: "Looking at other indicators,", voiceId: "SZQ4R1VKS2t6wmBJpK5H" },
    { id: "rajat_segue_03", text: "In the technology and business sector,", voiceId: "SZQ4R1VKS2t6wmBJpK5H" },
    { id: "rajat_segue_04", text: "Shifting focus,", voiceId: "SZQ4R1VKS2t6wmBJpK5H" },
    { id: "rajat_segue_05", text: "Meanwhile, in the industry,", voiceId: "SZQ4R1VKS2t6wmBJpK5H" },
    { id: "rajat_segue_06", text: "Analyzing the broader impact,", voiceId: "SZQ4R1VKS2t6wmBJpK5H" },
    { id: "rajat_segue_07", text: "On the corporate front,", voiceId: "SZQ4R1VKS2t6wmBJpK5H" },
    { id: "rajat_segue_08", text: "There are also developments here,", voiceId: "SZQ4R1VKS2t6wmBJpK5H" },
    { id: "rajat_segue_09", text: "Let’s look at another key factor,", voiceId: "SZQ4R1VKS2t6wmBJpK5H" },
    { id: "rajat_segue_10", text: "Expanding our view,", voiceId: "SZQ4R1VKS2t6wmBJpK5H" },

    // --- SHUBHI (Curator) - Voice: 2n8AzqIsQUPMvb1OgO72 ---
    { id: "shubhi_segue_01", text: "And in the world of culture,", voiceId: "2n8AzqIsQUPMvb1OgO72" },
    { id: "shubhi_segue_02", text: "Also trending today,", voiceId: "2n8AzqIsQUPMvb1OgO72" },
    { id: "shubhi_segue_03", text: "On a different note,", voiceId: "2n8AzqIsQUPMvb1OgO72" },
    { id: "shubhi_segue_04", text: "Moving to the lighter side of the news,", voiceId: "2n8AzqIsQUPMvb1OgO72" },
    { id: "shubhi_segue_05", text: "And here is a story catching attention,", voiceId: "2n8AzqIsQUPMvb1OgO72" },
    { id: "shubhi_segue_06", text: "Checking the social feeds,", voiceId: "2n8AzqIsQUPMvb1OgO72" },
    { id: "shubhi_segue_07", text: "In other news,", voiceId: "2n8AzqIsQUPMvb1OgO72" },
    { id: "shubhi_segue_08", text: "But wait, there is more,", voiceId: "2n8AzqIsQUPMvb1OgO72" },
    { id: "shubhi_segue_09", text: "And check this out,", voiceId: "2n8AzqIsQUPMvb1OgO72" },
    { id: "shubhi_segue_10", text: "Also in the mix,", voiceId: "2n8AzqIsQUPMvb1OgO72" }
];

const runGeneration = async (res) => {
    try {
        console.log(`🚀 STARTING SEGUE BATCH: ${SEGUES.length} items.`);
        const results = [];
        
        for (const item of SEGUES) {
            try {
                // Force overwrite existing files with new intonation
                const url = await ttsService.generateAndUpload(item.text, item.voiceId, null, item.id);
                results.push({ id: item.id, url, status: 'success' });
                // 1 second safety pause
                await new Promise(r => setTimeout(r, 1000));
            } catch (err) {
                console.error(`❌ Failed ${item.id}:`, err.message);
                results.push({ id: item.id, error: err.message, status: 'failed' });
            }
        }

        console.log("✅ BATCH COMPLETE.");
        res.status(200).json({ message: "Batch complete", results });

    } catch (error) {
        console.error("Batch Fatal Error:", error);
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
};

// --- ROUTES ---
router.get('/generate-segues', (req, res) => runGeneration(res));
router.post('/generate-segues', (req, res) => runGeneration(res));

router.get('/test', async (req, res) => {
    try {
        const vars = {
            elevenLabs: !!process.env.ELEVENLABS_API_KEY,
            cloudinaryName: !!process.env.CLOUDINARY_CLOUD_NAME,
            cloudinaryKey: !!process.env.CLOUDINARY_API_KEY
        };
        res.json({ status: "Online", variables: vars });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
