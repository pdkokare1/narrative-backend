// routes/shareRoutes.ts
import express, { Request, Response } from 'express';
import axios from 'axios';
import Article from '../models/articleModel';
import config from '../utils/config';
import logger from '../utils/logger';

const router = express.Router();

// --- PROXY IMAGE ROUTE (Must be before /:id) ---
// This allows html2canvas on the frontend to capture external images
// by routing them through our domain to avoid CORS tainting.
router.get('/proxy-image', async (req: Request, res: Response) => {
    const imageUrl = req.query.url as string;

    if (!imageUrl) {
        return res.status(400).send('Missing url parameter');
    }

    try {
        const response = await axios({
            url: imageUrl,
            method: 'GET',
            responseType: 'stream'
        });

        // Forward the content type (e.g., image/jpeg)
        res.setHeader('Content-Type', response.headers['content-type']);
        // ALLOW CORS for this specific asset so html2canvas can read it
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        response.data.pipe(res);
    } catch (error) {
        logger.error(`Image Proxy Error for ${imageUrl}:`, error);
        res.status(500).send('Failed to fetch image');
    }
});

// --- SHARE CARD HANDLER ---
router.get('/:id', async (req: Request, res: Response) => {
    const userAgent = (req.headers['user-agent'] || '').toLowerCase();
    
    // Detect common social bots (Twitter, WhatsApp, Facebook, LinkedIn, Discord, Slack)
    const isBot = /bot|googlebot|crawler|spider|robot|crawling|facebookexternalhit|whatsapp|slackbot|discord|twitterbot/i.test(userAgent);
    
    const articleId = req.params.id;

    // --- CASE 1: HUMAN USER ---
    // Redirect immediately to the full app.
    if (!isBot) {
        return res.redirect(`${config.frontendUrl}/?article=${articleId}`);
    }

    // --- CASE 2: SOCIAL BOT ---
    // Fetch minimal data and serve static HTML for the preview card.
    try {
        const article = await Article.findById(articleId).select('headline summary imageUrl').lean();
        
        if (!article) {
             // If ID is wrong, just send them to the home page
             logger.warn(`Share Link Missing Article: ${articleId}`);
             return res.redirect(config.frontendUrl);
        }

        // Generate the Social Preview HTML
        const html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="utf-8" />
                <title>${article.headline} | The Gamut</title>
                <meta name="description" content="${article.summary}" />
                
                <meta property="og:type" content="article" />
                <meta property="og:url" content="${config.frontendUrl}/?article=${articleId}" />
                <meta property="og:title" content="${article.headline}" />
                <meta property="og:description" content="${article.summary}" />
                <meta property="og:image" content="${article.imageUrl || ''}" />
                <meta property="og:site_name" content="The Gamut" />
                
                <meta name="twitter:card" content="summary_large_image" />
                <meta name="twitter:url" content="${config.frontendUrl}/?article=${articleId}" />
                <meta name="twitter:title" content="${article.headline}" />
                <meta name="twitter:description" content="${article.summary}" />
                <meta name="twitter:image" content="${article.imageUrl || ''}" />
            </head>
            <body>
                <h1>${article.headline}</h1>
                <p>${article.summary}</p>
                <img src="${article.imageUrl}" alt="Article Image" />
            </body>
            </html>
        `;
        
        res.setHeader('Content-Type', 'text/html');
        res.send(html);

    } catch (error: any) {
        logger.error(`Share Proxy Error: ${error.message}`);
        res.redirect(config.frontendUrl);
    }
});

export default router;
