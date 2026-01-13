// routes/assetGenRoutes.ts
import express, { Request, Response } from 'express';
import ttsService from '../services/ttsService';
import logger from '../utils/logger';
import config from '../utils/config';

const router = express.Router();

// --- VOICE CONFIGURATION ---
const VOICES = {
    MIRA: "SmLgXu8CcwHJvjiqq2rw",
    RAJAT: "SZQ4R1VKS2t6wmBJpK5H",
    SHUBHI: "2n8AzqIsQUPMvb1OgO72"
};

// --- 1. SEGUES (Transitions) ---
// Kept short/simple for now as requested.
const SEGUES = [
    // --- MIRA ---
    { id: "mira_segue_01", text: "In other developments,", voiceId: VOICES.MIRA },
    { id: "mira_segue_02", text: "Moving on,", voiceId: VOICES.MIRA },
    { id: "mira_segue_03", text: "Turning to other news,", voiceId: VOICES.MIRA },
    { id: "mira_segue_04", text: "Also making headlines,", voiceId: VOICES.MIRA },
    { id: "mira_segue_05", text: "Staying with the top stories,", voiceId: VOICES.MIRA },
    { id: "mira_segue_06", text: "Elsewhere in the news,", voiceId: VOICES.MIRA },
    { id: "mira_segue_07", text: "Shifting our focus,", voiceId: VOICES.MIRA },
    { id: "mira_segue_08", text: "Focusing now on this,", voiceId: VOICES.MIRA },
    { id: "mira_segue_09", text: "Here is another story we are tracking,", voiceId: VOICES.MIRA },
    { id: "mira_segue_10", text: "Continuing with our coverage,", voiceId: VOICES.MIRA },

    // --- RAJAT ---
    { id: "rajat_segue_01", text: "Also in the news,", voiceId: VOICES.RAJAT },
    { id: "rajat_segue_02", text: "Looking at other indicators,", voiceId: VOICES.RAJAT },
    { id: "rajat_segue_03", text: "In the technology and business sector,", voiceId: VOICES.RAJAT },
    { id: "rajat_segue_04", text: "Shifting focus,", voiceId: VOICES.RAJAT },
    { id: "rajat_segue_05", text: "Meanwhile, in the industry,", voiceId: VOICES.RAJAT },
    { id: "rajat_segue_06", text: "Analyzing the broader impact,", voiceId: VOICES.RAJAT },
    { id: "rajat_segue_07", text: "On the corporate front,", voiceId: VOICES.RAJAT },
    { id: "rajat_segue_08", text: "There are also developments here,", voiceId: VOICES.RAJAT },
    { id: "rajat_segue_09", text: "Let’s look at another key factor,", voiceId: VOICES.RAJAT },
    { id: "rajat_segue_10", text: "Expanding our view,", voiceId: VOICES.RAJAT },

    // --- SHUBHI ---
    { id: "shubhi_segue_01", text: "And in the world of culture,", voiceId: VOICES.SHUBHI },
    { id: "shubhi_segue_02", text: "Also trending today,", voiceId: VOICES.SHUBHI },
    { id: "shubhi_segue_03", text: "On a different note,", voiceId: VOICES.SHUBHI },
    { id: "shubhi_segue_04", text: "Moving to the lighter side of the news,", voiceId: VOICES.SHUBHI },
    { id: "shubhi_segue_05", text: "And here is a story catching attention,", voiceId: VOICES.SHUBHI },
    { id: "shubhi_segue_06", text: "Checking the social feeds,", voiceId: VOICES.SHUBHI },
    { id: "shubhi_segue_07", text: "In other news,", voiceId: VOICES.SHUBHI },
    { id: "shubhi_segue_08", text: "But wait, there is more,", voiceId: VOICES.SHUBHI },
    { id: "shubhi_segue_09", text: "And check this out,", voiceId: VOICES.SHUBHI },
    { id: "shubhi_segue_10", text: "Also in the mix,", voiceId: VOICES.SHUBHI }
];

// --- 2. OPENERS (Greetings) ---
// BRANDED: "The Gamut Radio" added to all scripts.
const OPENERS = [
    // --- MIRA (Anchor / Professional) ---
    { 
        id: "mira_open_morn_1", 
        text: "Good morning, ladies and gentlemen, and welcome to The Gamut Radio. As the world wakes up, we are tracking the significant developments that will define your day.", 
        voiceId: VOICES.MIRA 
    },
    { 
        id: "mira_open_morn_2", 
        text: "Good morning. You are tuned into The Gamut Radio. I am here to guide you through a comprehensive slate of stories, from breaking headlines to in-depth analysis.", 
        voiceId: VOICES.MIRA 
    },
    { 
        id: "mira_open_morn_3", 
        text: "A warm welcome to The Gamut Radio this morning. The news cycle is moving rapidly, and we are here to provide you with the clarity and context you need.", 
        voiceId: VOICES.MIRA 
    },
    
    { 
        id: "mira_open_aft_1", 
        text: "Good afternoon, ladies and gentlemen. You are listening to The Gamut Radio. We are pausing in the middle of this busy day to examine the narratives shaping our world.", 
        voiceId: VOICES.MIRA 
    },
    { 
        id: "mira_open_aft_2", 
        text: "Good afternoon and welcome to The Gamut Radio. As the day progresses, we are seeing new details emerge, and I am here to bring you up to date.", 
        voiceId: VOICES.MIRA 
    },
    { 
        id: "mira_open_aft_3", 
        text: "You are tuned into The Gamut Radio. Good afternoon. I hope your day is treating you well as we step back to examine the critical updates from around the globe.", 
        voiceId: VOICES.MIRA 
    },

    { 
        id: "mira_open_eve_1", 
        text: "Good evening, ladies and gentlemen. Welcome to The Gamut Radio. As the day draws to a close, we reflect on the moments that defined the last twenty-four hours.", 
        voiceId: VOICES.MIRA 
    },
    { 
        id: "mira_open_eve_2", 
        text: "You are tuned into The Gamut Radio. Good evening. The busy hum of the day has settled, giving us the perfect opportunity to review the major headlines.", 
        voiceId: VOICES.MIRA 
    },
    { 
        id: "mira_open_eve_3", 
        text: "A pleasant good evening and welcome to The Gamut Radio. Thank you for joining us to wrap up the day with a briefing of the most impactful stories.", 
        voiceId: VOICES.MIRA 
    },

    // --- RAJAT (Analyst / Business) ---
    { 
        id: "rajat_open_morn_1", 
        text: "Good morning, ladies and gentlemen. This is The Gamut Radio. The global machinery is already moving, and I am here to help you interpret the signals driving the narrative.", 
        voiceId: VOICES.RAJAT 
    },
    { 
        id: "rajat_open_morn_2", 
        text: "Welcome to The Gamut Radio. Good morning. While the headlines tell us what is happening, our goal right now is to understand why.", 
        voiceId: VOICES.RAJAT 
    },
    { 
        id: "rajat_open_morn_3", 
        text: "Good morning. You are tuned into The Gamut Radio. As we prepare for the day ahead, we are looking past the surface noise to identify the structural shifts that matter.", 
        voiceId: VOICES.RAJAT 
    },

    { 
        id: "rajat_open_aft_1", 
        text: "Good afternoon, listeners. You are tuned into The Gamut Radio. As we bridge the gap between morning developments and evening outcomes, let us look at the strategic moves happening now.", 
        voiceId: VOICES.RAJAT 
    },
    { 
        id: "rajat_open_aft_2", 
        text: "Welcome to The Gamut Radio. Good afternoon. The situation is evolving as we speak, and I invite you to join me in analyzing where the momentum is shifting.", 
        voiceId: VOICES.RAJAT 
    },
    { 
        id: "rajat_open_aft_3", 
        text: "Good afternoon, ladies and gentlemen. This is The Gamut Radio. We are tracking real-time shifts in the landscape today, so let us contextualize these changes.", 
        voiceId: VOICES.RAJAT 
    },

    { 
        id: "rajat_open_eve_1", 
        text: "Good evening. Welcome to The Gamut Radio. The day is done and the numbers are in; now is the time to dissect the day's performance and understand the deeper currents.", 
        voiceId: VOICES.RAJAT 
    },
    { 
        id: "rajat_open_eve_2", 
        text: "You are tuned into The Gamut Radio. Good evening. We have crunched the numbers on today's events, and I am here to present you with the executive summary.", 
        voiceId: VOICES.RAJAT 
    },
    { 
        id: "rajat_open_eve_3", 
        text: "Good evening, ladies and gentlemen. This is The Gamut Radio. As we close the book on today's activities, let us review the impact of these events on the days to come.", 
        voiceId: VOICES.RAJAT 
    },

    // --- SHUBHI (Trendsetter / Cultural) ---
    { 
        id: "shubhi_open_morn_1", 
        text: "Hi everyone, good morning! Welcome to The Gamut Radio. Beyond the breaking news, there is a vibrant world of stories waking up today, and I am delighted to bring them to you.", 
        voiceId: VOICES.SHUBHI 
    },
    { 
        id: "shubhi_open_morn_2", 
        text: "Good morning! You are tuned into The Gamut Radio. It is a beautiful day to explore the world, and I have curated the most intriguing topics just for you.", 
        voiceId: VOICES.SHUBHI 
    },
    { 
        id: "shubhi_open_morn_3", 
        text: "A warm and bright good morning, ladies and gentlemen. Welcome to The Gamut Radio. Join me as we explore the cultural heartbeat of the day.", 
        voiceId: VOICES.SHUBHI 
    },

    { 
        id: "shubhi_open_aft_1", 
        text: "Good afternoon, listeners! You are tuned into The Gamut Radio. Amidst your busy schedule, take a moment with us to explore the conversations sparking dialogue right now.", 
        voiceId: VOICES.SHUBHI 
    },
    { 
        id: "shubhi_open_aft_2", 
        text: "Welcome to The Gamut Radio. Good afternoon! If you are looking for a change of pace, I have gathered the stories that are creating a real buzz this afternoon.", 
        voiceId: VOICES.SHUBHI 
    },
    { 
        id: "shubhi_open_aft_3", 
        text: "Good afternoon! This is The Gamut Radio. The world is full of fascinating developments today, so relax for a moment while we catch up on what is truly trending.", 
        voiceId: VOICES.SHUBHI 
    },

    { 
        id: "shubhi_open_eve_1", 
        text: "Good evening, everyone. Welcome to The Gamut Radio. As we wind down, let us turn our attention to the human interest stories that brought color to our day.", 
        voiceId: VOICES.SHUBHI 
    },
    { 
        id: "shubhi_open_eve_2", 
        text: "You are listening to The Gamut Radio. Good evening. The day has been full of events, but now we have the time to appreciate the stories that inspire and entertain.", 
        voiceId: VOICES.SHUBHI 
    },
    { 
        id: "shubhi_open_eve_3", 
        text: "Good evening, ladies and gentlemen. Welcome to The Gamut Radio. Let us end the day on a high note by revisiting the most compelling moments from around the world.", 
        voiceId: VOICES.SHUBHI 
    }
];

// Combine all assets for processing
const ALL_ASSETS = [...SEGUES, ...OPENERS];

const runGeneration = async (req: Request, res: Response) => {
    // SECURITY CHECK: Ensure the caller has the Admin Secret
    // Use ?key=YOUR_SECRET in the URL
    if (req.query.key !== config.adminSecret) {
        logger.warn(`🚫 Unauthorized Asset Gen Attempt: ${req.ip}`);
        return res.status(403).json({ error: "Unauthorized. Missing or invalid key." });
    }

    try {
        logger.info(`🚀 STARTING ASSET BATCH: ${ALL_ASSETS.length} items.`);
        const results: any[] = [];
        
        for (const item of ALL_ASSETS) {
            try {
                // Generate and upload
                // NOTE: We pass 'null' for articleId, and item.id as customFilename
                // IMPORTANT: We pass 'true' for highQuality to use V2 model + Max Quality
                const url = await ttsService.generateAndUpload(item.text, item.voiceId, null, item.id, true);
                results.push({ id: item.id, url, status: 'success' });
                
                // 1.5 second safety pause to respect API rate limits and avoid ElevenLabs concurrency issues
                await new Promise(r => setTimeout(r, 1500));
            } catch (err: any) {
                logger.error(`❌ Failed ${item.id}: ${err.message}`);
                results.push({ id: item.id, error: err.message, status: 'failed' });
            }
        }

        logger.info("✅ ASSET GENERATION BATCH COMPLETE.");
        res.status(200).json({ message: "Batch complete", results });

    } catch (error: any) {
        logger.error(`🔥 Batch Fatal Error: ${error.message}`);
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
};

// --- ROUTES ---
// We allow GET for easy manual triggering via browser, but protected by ?key=
router.get('/generate-assets', runGeneration);
router.post('/generate-assets', runGeneration);

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
