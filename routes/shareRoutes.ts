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
        // FIX: Add User-Agent to prevent 403 Forbidden from news sites
        const response = await axios({
            url: imageUrl,
            method: 'GET',
            responseType: 'stream',
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/*'
            }
        });

        // Clean headers to avoid double-compression or chunking issues
        const contentType = response.headers['content-type'];
        res.setHeader('Content-Type', contentType || 'image/jpeg');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day

        // Pipe data
        response.data.pipe(res);
    } catch (error) {
        // Do not log full error stack for 404s/timeouts to keep logs clean
        logger.warn(`Image Proxy Failed for ${imageUrl}`);
        res.status(404).send('Image not found');
    }
});

// --- SHARE CARD HANDLER ---
router.get('/:id', async (req: Request, res: Response) => {
    const userAgent = (req.headers['user-agent'] || '').toLowerCase();
    
    // AGGRESSIVE Bot Detection
    // Covers: WhatsApp, Facebook, Twitter, iMessage (Applebot), Discord, Slack, Telegram, LinkedIn
    const isBot = /bot|googlebot|crawler|spider|robot|crawling|facebookexternalhit|whatsapp|slackbot|discord|twitterbot|telegram|snapchat|linkedin|embedly|quora|pinterest|skype|applebot/i.test(userAgent);
    
    const articleId = req.params.id;

    // --- CASE 1: HUMAN USER ---
    // FIX: We do NOT strictly redirect here anymore. 
    // We render the HTML for everyone, but inject a JS redirect for humans.
    // This fixes the issue where WhatsApp/Telegram follow the redirect and show the app's (empty) metadata.
    const appUrl = `${config.frontendUrl}/?article=${articleId}`;
    
    // Default fallback image
    const DEFAULT_IMAGE = "https://narrative-news.com/logo512.png"; 

    // --- CASE 2: SOCIAL BOT (and Humans now fall through to here) ---
    try {
        const article = await Article.findById(articleId).select('headline summary imageUrl').lean();
        
        if (!article) {
             return res.redirect(config.frontendUrl);
        }

        // Force HTTPS for the canonical URL
        const protocol = req.get('x-forwarded-proto') || req.protocol;
        const host = req.get('host');
        // Self URL must be the backend URL so scrapers stay here
        const selfUrl = `${protocol}://${host}${req.originalUrl}`;
        
        // Ensure Image URL is absolute and proxied if needed (though raw usually works for og:image)
        const imageUrl = article.imageUrl || DEFAULT_IMAGE;

        const html = `
            <!DOCTYPE html>
            <html lang="en" prefix="og: http://ogp.me/ns#">
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                
                <title>${article.headline} | The Gamut</title>
                <meta name="description" content="${article.summary}" />
                
                <meta property="og:type" content="article" />
                <meta property="og:url" content="${selfUrl}" />
                <meta property="og:title" content="${article.headline}" />
                <meta property="og:description" content="${article.summary}" />
                <meta property="og:image" content="${imageUrl}" />
                <meta property="og:image:width" content="1200" />
                <meta property="og:image:height" content="630" />
                <meta property="og:site_name" content="The Gamut" />
                <meta property="og:locale" content="en_US" />
                
                <meta name="twitter:card" content="summary_large_image" />
                <meta name="twitter:url" content="${selfUrl}" />
                <meta name="twitter:title" content="${article.headline}" />
                <meta name="twitter:description" content="${article.summary}" />
                <meta name="twitter:image" content="${imageUrl}" />
                
                <script>
                   // FIX: Redirect Humans to the App
                   // We use 'replace' to ensure the back button works intuitively
                   ${!isBot ? `window.location.replace("${appUrl}");` : ''}
                </script>
            </head>
            <body style="font-family: sans-serif; padding: 20px; text-align:center;">
                <div style="max-width:600px; margin:0 auto;">
                    <h1 style="font-size: 24px; margin-bottom: 10px;">${article.headline}</h1>
                    <img src="${imageUrl}" style="max-width:100%; height:auto; border-radius: 8px;" />
                    <p style="font-size: 16px; line-height: 1.5; color: #333;">${article.summary}</p>
                    <a href="${appUrl}" style="display:inline-block; margin-top:15px; padding:10px 20px; background:#000; color:#fff; text-decoration:none; border-radius:4px;">Read Full Story</a>
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
