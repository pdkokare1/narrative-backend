// narrative-backend/services/articleProcessor.ts
import { INewsSourceArticle } from '../types';
import { cleanText, formatHeadline, getSimilarityScore, calculateReadingComplexity } from '../utils/helpers';
import { TRUSTED_SOURCES, JUNK_KEYWORDS } from '../utils/constants';
import SystemConfig from '../models/systemConfigModel';
import redis from '../utils/redisClient';

// Defaults
const DEFAULT_WEIGHTS = {
    image_bonus: 2,
    missing_image_penalty: -2,
    missing_image_untrusted_penalty: -10,
    trusted_source_bonus: 5,
    title_length_bonus: 1,
    junk_keyword_penalty: -20,
    min_score_cutoff: 0
};

class ArticleProcessor {
    
    private async getWeights() {
        try {
            const cached = await redis.get('CONFIG_SCORING_WEIGHTS');
            if (cached) return JSON.parse(cached);

            const conf = await SystemConfig.findOne({ key: 'scoring_weights' });
            if (conf && conf.value) {
                await redis.set('CONFIG_SCORING_WEIGHTS', JSON.stringify(conf.value), 300);
                return conf.value;
            }
        } catch (e) {}
        return DEFAULT_WEIGHTS;
    }

    public async processBatch(articles: INewsSourceArticle[]): Promise<INewsSourceArticle[]> {
        const weights = await this.getWeights();

        // 1. First pass: Scoring
        const scored = articles.map(a => {
            const score = this.calculateScore(a, weights);
            return { article: a, score };
        });

        // 2. Sort by Quality
        scored.sort((a, b) => b.score - a.score);

        const uniqueArticles: INewsSourceArticle[] = [];
        const seenUrls = new Set<string>();
        const seenTitles: string[] = [];

        // 3. Selection Loop
        for (const item of scored) {
            const article = item.article;

            // A. Quality Cutoff (Dynamic)
            if (item.score < weights.min_score_cutoff) continue;

            // B. Text Cleanup
            article.title = formatHeadline(article.title);
            article.description = cleanText(article.description || "");

            // --- NEW: Calculate Cognitive Complexity ---
            // We append this to the object. It will be saved when mapped to ArticleDocument
            // Note: We are dynamically adding a property to INewsSourceArticle here.
            // In a strict typed env we would cast, but JS allows this assignment.
            // We use description because content is often truncated/missing at this stage.
            (article as any).complexityScore = calculateReadingComplexity(article.description);

            // C. Validation
            if (!this.isValid(article)) continue;

            // D. Deduplication
            if (seenUrls.has(article.url)) continue;
            if (this.isFuzzyDuplicate(article.title, seenTitles)) continue;

            seenUrls.add(article.url);
            seenTitles.push(article.title);
            uniqueArticles.push(article);
        }

        return uniqueArticles.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
    }

    private calculateScore(a: INewsSourceArticle, weights: any): number {
        let score = 0;
        const titleLower = (a.title || "").toLowerCase();
        const sourceLower = (a.source.name || "").toLowerCase();
        
        const isTrusted = TRUSTED_SOURCES.some(src => sourceLower.includes(src.toLowerCase()));

        // Image Quality
        if (a.image && a.image.startsWith('http')) {
            score += weights.image_bonus;
        } else {
            if (!isTrusted) {
                score += weights.missing_image_untrusted_penalty; 
            } else {
                 score += weights.missing_image_penalty;
            }
        }

        // Title Length
        if (a.title && a.title.length > 40) score += weights.title_length_bonus;

        // Trusted Source Bonus
        if (isTrusted) score += weights.trusted_source_bonus; 

        // Junk Penalty
        if (JUNK_KEYWORDS.some(word => titleLower.includes(word))) score += weights.junk_keyword_penalty;

        return score;
    }

    private isValid(article: INewsSourceArticle): boolean {
        if (!article.title || !article.url) return false;
        if (article.title.length < 20) return false; 
        if (article.title === "No Title") return false;
        if (!article.description || article.description.length < 30) return false; 
        
        const totalWords = (article.title + " " + article.description).split(/\s+/).length;
        if (totalWords < 40) return false;

        return true;
    }

    private isFuzzyDuplicate(currentTitle: string, existingTitles: string[]): boolean {
        const currentLen = currentTitle.length;
        
        for (const existing of existingTitles) {
            if (Math.abs(currentLen - existing.length) > 20) continue;
            const score = getSimilarityScore(currentTitle, existing);
            if (score > 0.8) return true; 
        }
        return false;
    }
}

export default new ArticleProcessor();
