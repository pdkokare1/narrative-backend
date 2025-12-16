// routes/assetGenRoutes.ts
import express, { Request, Response } from 'express';
import ttsService from '../services/ttsService';
import logger from '../utils/logger';
import config from '../utils/config';

const router = express.Router();

// Defined outside to keep the handler clean
const SEGUES = [
    // --- MIRA ---
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

    // --- RAJAT ---
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

    // --- SHUBHI ---
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

const runGeneration = async (req: Request, res: Response) => {
    // SECURITY CHECK: Ensure the caller has the Admin Secret
    // Use ?key=YOUR_SECRET in the URL
    if (req.query.key !== config.adminSecret) {
        logger.warn(`🚫 Unauthorized Asset Gen Attempt: ${req.ip}`);
        return res.status(403).json({ error: "Unauthorized. Missing or invalid key." });
    }

    try {
        logger.info(`🚀 STARTING SEGUE BATCH: ${SEGUES.length} items.`);
        const results: any[] = [];
        
        for (const item of SEGUES) {
            try {
                // Generate and upload
                const url = await ttsService.generateAndUpload(item.text, item.voiceId, null, item.id);
                results.push({ id: item.id, url, status: 'success' });
                
                // 1 second safety pause to respect API rate limits
                await new Promise(r => setTimeout(r, 1000));
            } catch (err: any) {
                logger.error(`❌ Failed ${item.id}: ${err.message}`);
                results.push({ id: item.id, error: err.message, status: 'failed' });
            }
        }

        logger.info("✅ SEGUE BATCH COMPLETE.");
        res.status(200).json({ message: "Batch complete", results });

    } catch (error: any) {
        logger.error(`🔥 Batch Fatal Error: ${error.message}`);
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
};

// --- ROUTES ---
// We allow GET for easy manual triggering via browser, but protected by ?key=
router.get('/generate-segues', runGeneration);
router.post('/generate-segues', runGeneration);

router.get('/test', async (req: Request, res: Response) => {
    try {
        const vars = {
            elevenLabs: !!config.keys.elevenLabs,
            cloudinaryName: !!config.cloudinary.cloudName,
            cloudinaryKey: !!config.cloudinary.apiKey
        };
        res.json({ status: "Online", variables: vars });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

export default router;
