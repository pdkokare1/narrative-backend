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
            responseType: 'stream',
            timeout: 5000 // 5s timeout
        });

        // Forward content-type or default to png
        const contentType = response.headers['content-type'] || 'image/png';
        
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*'); 
        // We do NOT cache here aggressively to avoid stale CORS issues during development
        res.setHeader('Cache-Control', 'no-cache'); 

        // Pipe data
        response.data.pipe(res);
    } catch (error) {
        logger.warn(`Image Proxy Failed for ${imageUrl}`);
        res.status(404).send('Image not found');
    }
});

// --- SHARE CARD HANDLER ---
router.get('/:id', async (req: Request, res: Response) => {
    const articleId = req.params.id;
    const userAgent = (req.headers['user-agent'] || '').toLowerCase();
    
    // Detect Bots (WhatsApp, Facebook, Twitter, Discord, Applebot)
    // We WANT these to stay on this page and read the meta tags.
    const isBot = /bot|googlebot|crawler|spider|robot|crawling|facebookexternalhit|whatsapp|slackbot|discord|twitterbot|telegram|snapchat|linkedin|embedly|quora|pinterest|skype|applebot/i.test(userAgent);

    // Default image if article has none
    const DEFAULT_IMAGE = "https://narrative-news.com/logo512.png"; 

    try {
        const article = await Article.findById(articleId).select('headline summary imageUrl').lean();
        
        // If article not found, redirect to home
        if (!article) {
             return res.redirect(config.frontendUrl);
        }

        // Force HTTPS
        const protocol = req.get('x-forwarded-proto') || req.protocol;
        const host = req.get('host');
        // This is the URL of *this* card (the backend link)
        const selfUrl = `${protocol}://${host}${req.originalUrl}`.replace('http://', 'https://');
        
        // The URL of the App (Frontend)
        const appUrl = `${config.frontendUrl}/?article=${articleId}`;
        
        const imageUrl = article.imageUrl || DEFAULT_IMAGE;

        // --- THE HTML RESPONSE ---
        const html = `
            <!DOCTYPE html>
            <html lang="en" prefix="og: http://ogp.me/ns#">
            <head>
                <meta charset="utf-8" />
                <title>${article.headline} | The Gamut</title>
                
                <meta property="og:url" content="${selfUrl}" />
                <meta property="og:type" content="article" />
                <meta property="og:title" content="${article.headline}" />
                <meta property="og:description" content="${article.summary}" />
                <meta property="og:image" content="${imageUrl}" />
                <meta property="og:site_name" content="The Gamut" />
                
                <meta property="og:image:width" content="1200" />
                <meta property="og:image:height" content="630" />
                
                <meta name="twitter:card" content="summary_large_image" />
                <meta name="twitter:domain" content="${host}" />
                <meta name="twitter:url" content="${selfUrl}" />
                <meta name="twitter:title" content="${article.headline}" />
                <meta name="twitter:description" content="${article.summary}" />
                <meta name="twitter:image" content="${imageUrl}" />

                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 20px; text-align: center; background: #f5f5f5; }
                    .card { background: white; padding: 20px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); max-width: 600px; margin: 20px auto; }
                    img { max-width: 100%; border-radius: 8px; margin-bottom: 15px; }
                    h1 { font-size: 20px; margin-bottom: 10px; color: #111; }
                    p { color: #555; line-height: 1.5; }
                    .btn { display: inline-block; background: #000; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; margin-top: 20px; }
                </style>

                ${!isBot ? `
                <script>
                    window.location.replace("${appUrl}");
                </script>
                ` : ''}

            </head>
            <body>
                <div class="card">
                    <img src="${imageUrl}" alt="Article Image" />
                    <h1>${article.headline}</h1>
                    <p>${article.summary}</p>
                    <a href="${appUrl}" class="btn">Read Full Story</a>
                </div>
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
