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

        // Clean headers to avoid double-compression or chunking issues
        const contentType = response.headers['content-type'];
        if (contentType) res.setHeader('Content-Type', contentType);
        
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for speed

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
    const articleId = req.params.id;
    // Default fallback image if article has none (You can replace this with your actual logo URL)
    const DEFAULT_IMAGE = "https://narrative-news.com/logo512.png"; 

    try {
        const article = await Article.findById(articleId).select('headline summary imageUrl politicalLean').lean();
        
        // If article not found, redirect to home
        if (!article) {
             return res.redirect(config.frontendUrl);
        }

        // Force HTTPS for the canonical URL
        const protocol = req.get('x-forwarded-proto') || req.protocol;
        const host = req.get('host');
        const selfUrl = `${protocol}://${host}${req.originalUrl}`.replace('http://', 'https://');
        
        // Ensure Image URL is absolute
        const imageUrl = article.imageUrl || DEFAULT_IMAGE;

        // Construct target URL for the user
        const appUrl = `${config.frontendUrl}/?article=${articleId}`;

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
                <meta property="og:site_name" content="The Gamut" />
                <meta property="og:locale" content="en_US" />
                
                <meta name="twitter:card" content="summary_large_image" />
                <meta name="twitter:url" content="${selfUrl}" />
                <meta name="twitter:title" content="${article.headline}" />
                <meta name="twitter:description" content="${article.summary}" />
                <meta name="twitter:image" content="${imageUrl}" />
                
                <script>
                   window.location.replace("${appUrl}");
                </script>
            </head>
            <body style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; padding: 40px; background: #f4f4f4; text-align: center;">
                <div style="background: white; padding: 20px; border-radius: 8px; max-width: 600px; margin: 0 auto; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                    <h1 style="font-size: 22px; color: #333; margin-bottom: 15px;">${article.headline}</h1>
                    <img src="${imageUrl}" style="max-width:100%; height:auto; border-radius: 4px; margin-bottom: 15px;" />
                    <p style="font-size: 16px; line-height: 1.6; color: #555;">${article.summary}</p>
                    <a href="${appUrl}" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background-color: #000; color: #fff; text-decoration: none; border-radius: 5px;">Read on The Gamut</a>
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
