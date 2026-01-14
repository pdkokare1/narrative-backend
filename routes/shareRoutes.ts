// routes/shareRoutes.ts
import express, { Request, Response } from 'express';
import axios from 'axios';
import Article from '../models/articleModel';
import config from '../utils/config';
import logger from '../utils/logger';

const router = express.Router();

// --- PROXY IMAGE ROUTE ---
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

        res.setHeader('Content-Type', response.headers['content-type']);
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
    
    // Expanded bot detection
    const isBot = /bot|googlebot|crawler|spider|robot|crawling|facebookexternalhit|whatsapp|slackbot|discord|twitterbot|telegram|snapchat/i.test(userAgent);
    
    const articleId = req.params.id;

    // --- CASE 1: HUMAN USER ---
    if (!isBot) {
        return res.redirect(`${config.frontendUrl}/?article=${articleId}`);
    }

    // --- CASE 2: SOCIAL BOT ---
    try {
        const article = await Article.findById(articleId).select('headline summary imageUrl').lean();
        
        if (!article) {
             return res.redirect(config.frontendUrl);
        }

        // IMPORTANT: The Canonical URL must be THIS backend URL, not the frontend URL.
        // This prevents the scraper from following og:url to the React app (which has no tags).
        const selfUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        const imageUrl = article.imageUrl || '';

        const html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                
                <title>${article.headline}</title>
                <meta name="description" content="${article.summary}" />
                
                <meta property="og:type" content="article" />
                <meta property="og:url" content="${selfUrl}" />
                <meta property="og:title" content="${article.headline}" />
                <meta property="og:description" content="${article.summary}" />
                <meta property="og:image" content="${imageUrl}" />
                <meta property="og:image:alt" content="${article.headline}" />
                <meta property="og:site_name" content="The Gamut" />
                
                <meta property="og:image:width" content="1200" />
                <meta property="og:image:height" content="630" />
                
                <meta name="twitter:card" content="summary_large_image" />
                <meta name="twitter:url" content="${selfUrl}" />
                <meta name="twitter:title" content="${article.headline}" />
                <meta name="twitter:description" content="${article.summary}" />
                <meta name="twitter:image" content="${imageUrl}" />
            </head>
            <body>
                <h1>${article.headline}</h1>
                <img src="${imageUrl}" style="max-width:100%;" />
                <p>${article.summary}</p>
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
