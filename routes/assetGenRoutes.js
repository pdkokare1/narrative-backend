// routes/assetGenRoutes.js
const express = require('express');
const router = express.Router();
const ttsService = require('../services/ttsService');

// --- THE 27 GREETING SCRIPTS ---
const GREETINGS = [
    // --- MIRA (Anchor) ---
    { id: "mira_open_morn_1", text: "Hello. You’re with The Gamut. I’m Mira. Wishing you a very good morning. Let’s start the day with some clarity.", voiceId: "SmLgXu8CcwHJvjiqq2rw" },
    { id: "mira_open_morn_2", text: "A very good morning to you. I’m Mira. Thank you for joining us. Let’s see the news unfolding around the globe.", voiceId: "SmLgXu8CcwHJvjiqq2rw" },
    { id: "mira_open_morn_3", text: "Good morning. I’m Mira. Hoping you have a productive day ahead. Here is your daily briefing.", voiceId: "SmLgXu8CcwHJvjiqq2rw" },
    { id: "mira_open_aft_1", text: "Good afternoon. Welcome to The Gamut. I’m Mira. Hoping your day is going well. Let’s get you updated.", voiceId: "SmLgXu8CcwHJvjiqq2rw" },
    { id: "mira_open_aft_2", text: "Hello. It is afternoon in the studio. I’m Mira. Thank you for tuning in. Here are the developments you need to know.", voiceId: "SmLgXu8CcwHJvjiqq2rw" },
    { id: "mira_open_aft_3", text: "Good afternoon. I’m Mira. Wishing you a good second half of the day. Let’s look at the top stories.", voiceId: "SmLgXu8CcwHJvjiqq2rw" },
    { id: "mira_open_eve_1", text: "Good evening. You’re tuned in to The Gamut. I’m Mira. Hoping you had a good day. Let’s look at the headlines.", voiceId: "SmLgXu8CcwHJvjiqq2rw" },
    { id: "mira_open_eve_2", text: "Hello. Welcome to the evening broadcast. I’m Mira. Thank you for ending your day with us. Let’s wrap up the news.", voiceId: "SmLgXu8CcwHJvjiqq2rw" },
    { id: "mira_open_eve_3", text: "Good evening. I’m Mira. Wishing you a relaxing evening ahead. Let’s reflect on the stories that mattered today.", voiceId: "SmLgXu8CcwHJvjiqq2rw" },

    // --- RAJAT (Analyst) ---
    { id: "rajat_open_morn_1", text: "Hello. This is The Gamut. I’m Rajat. Wishing you a focused morning. Let’s get straight to the facts.", voiceId: "czw3FmTwixwtnkpOKXZ0" },
    { id: "rajat_open_morn_2", text: "Good morning. I’m Rajat. Thank you for listening. Let’s look at the reality behind the headlines.", voiceId: "czw3FmTwixwtnkpOKXZ0" },
    { id: "rajat_open_morn_3", text: "A very good morning. I’m Rajat. Hoping your day is off to a strong start. Let’s look at the data.", voiceId: "czw3FmTwixwtnkpOKXZ0" },
    { id: "rajat_open_aft_1", text: "Good afternoon. I’m Rajat. Hoping the day has been productive for you. Let’s track the shifting stories.", voiceId: "czw3FmTwixwtnkpOKXZ0" },
    { id: "rajat_open_aft_2", text: "Hello. Afternoon. I’m Rajat. Thank you for joining. Let’s break down the complex developments.", voiceId: "czw3FmTwixwtnkpOKXZ0" },
    { id: "rajat_open_aft_3", text: "Good afternoon. I’m Rajat. Wishing you a good afternoon. Let’s analyze the day so far.", voiceId: "czw3FmTwixwtnkpOKXZ0" },
    { id: "rajat_open_eve_1", text: "Good evening. I’m Rajat. Hoping you had a successful day. Let’s see what the data tells us tonight.", voiceId: "czw3FmTwixwtnkpOKXZ0" },
    { id: "rajat_open_eve_2", text: "Hello. Evening. I’m Rajat. Thank you for tuning in. The day is done, but the analysis continues.", voiceId: "czw3FmTwixwtnkpOKXZ0" },
    { id: "rajat_open_eve_3", text: "Good evening. This is The Gamut. I’m Rajat. Wishing you a restful night. Let’s wrap up the financial day.", voiceId: "czw3FmTwixwtnkpOKXZ0" },

    // --- SHUBHI (Curator) ---
    { id: "shubhi_open_morn_1", text: "Hello! You’re with The Gamut. I’m Shubhi. Wishing you a bright morning. Let’s explore what’s new.", voiceId: "AwEl6phyzczpCHHDxyfO" },
    { id: "shubhi_open_morn_2", text: "Rise and shine. I’m Shubhi. Thank you for starting your day with us. Let’s kick things off with some energy.", voiceId: "AwEl6phyzczpCHHDxyfO" },
    { id: "shubhi_open_morn_3", text: "Good morning. I’m Shubhi. Hoping you have an awesome day ahead. Let’s get into the stories.", voiceId: "AwEl6phyzczpCHHDxyfO" },
    { id: "shubhi_open_aft_1", text: "Good afternoon! I’m Shubhi. Hoping you are having a good day. If you need a break, you’ve come to the right place.", voiceId: "AwEl6phyzczpCHHDxyfO" },
    { id: "shubhi_open_aft_2", text: "Hello there. Good afternoon. I’m Shubhi. Thank you for listening. Let’s catch up on the buzz.", voiceId: "AwEl6phyzczpCHHDxyfO" },
    { id: "shubhi_open_aft_3", text: "Good afternoon. I’m Shubhi. Wishing you a smooth afternoon. Let’s see what is trending.", voiceId: "AwEl6phyzczpCHHDxyfO" },
    { id: "shubhi_open_eve_1", text: "Good evening! I’m Shubhi. Hoping you had a fantastic day. Let’s unwind with some stories.", voiceId: "AwEl6phyzczpCHHDxyfO" },
    { id: "shubhi_open_eve_2", text: "Hello. Evening! I’m Shubhi. Thank you for joining me. You made it through the day, now let’s relax.", voiceId: "AwEl6phyzczpCHHDxyfO" },
    { id: "shubhi_open_eve_3", text: "Good evening. I’m Shubhi. Wishing you a peaceful night. Let’s close out the day.", voiceId: "AwEl6phyzczpCHHDxyfO" }
];

const runGeneration = async (res) => {
    try {
        console.log(`🚀 STARTING BATCH: ${GREETINGS.length} items.`);
        const results = [];
        
        for (const item of GREETINGS) {
            try {
                const url = await ttsService.generateAndUpload(item.text, item.voiceId, null, item.id);
                results.push({ id: item.id, url, status: 'success' });
                // 1 second pause to be safe
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
// We support both GET and POST so you can just paste URL in browser
router.get('/generate-greetings', (req, res) => runGeneration(res));
router.post('/generate-greetings', (req, res) => runGeneration(res));

// --- DIAGNOSTIC ROUTE ---
router.get('/test', async (req, res) => {
    console.log("🔍 Test Endpoint Hit");
    try {
        // Just verify keys exist
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
