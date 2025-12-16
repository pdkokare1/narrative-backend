// routes/shareRoutes.ts
import express, { Request, Response } from 'express';
import Article from '../models/articleModel';
import config from '../utils/config';
import logger from '../utils/logger';

const router = express.Router();

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
