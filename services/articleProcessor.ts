// services/articleProcessor.ts
import { INewsSourceArticle } from '../types';
import { cleanText, formatHeadline, getSimilarityScore } from '../utils/helpers';
import { TRUSTED_SOURCES, JUNK_KEYWORDS } from '../utils/constants';

class ArticleProcessor {
    
    /**
     * Main Pipeline: Clean -> Score -> Deduplicate (Fuzzy)
     */
    public processBatch(articles: INewsSourceArticle[]): INewsSourceArticle[] {
        // 1. First pass: Scoring and Basic Cleaning
        const scored = articles.map(a => {
            const score = this.calculateScore(a);
            return { article: a, score };
        });

        // 2. Sort by Quality (Highest Score First)
        scored.sort((a, b) => b.score - a.score);

        const uniqueArticles: INewsSourceArticle[] = [];
        const seenUrls = new Set<string>();
        const seenTitles: string[] = [];

        // 3. Selection Loop
        for (const item of scored) {
            const article = item.article;

            // A. Quality Cutoff (RAISED BAR)
            // Was -5, now 0. This ensures "Junk Keyword" (-20 penalty) items are always killed.
            if (item.score < 0) continue;

            // B. Text Cleanup
            article.title = formatHeadline(article.title);
            article.description = cleanText(article.description || "");

            // C. Validation
            if (!this.isValid(article)) continue;

            // D. Deduplication (Exact URL)
            if (seenUrls.has(article.url)) continue;

            // E. Deduplication (Fuzzy Title)
            if (this.isFuzzyDuplicate(article.title, seenTitles)) continue;

            // Accepted!
            seenUrls.add(article.url);
            seenTitles.push(article.title);
            uniqueArticles.push(article);
        }

        return uniqueArticles.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
    }

    private calculateScore(a: INewsSourceArticle): number {
        let score = 0;
        const titleLower = (a.title || "").toLowerCase();
        const sourceLower = (a.source.name || "").toLowerCase();
        
        const isTrusted = TRUSTED_SOURCES.some(src => sourceLower.includes(src.toLowerCase()));

        // Image Quality
        // STRICT: If not trusted and no image, massive penalty.
        if (a.image && a.image.startsWith('http')) {
            score += 2;
        } else {
            if (!isTrusted) {
                score -= 10; 
            } else {
                 // Trusted sources sometimes miss images but content is gold.
                 score -= 2;
            }
        }

        // Title Length
        if (a.title && a.title.length > 40) score += 1;

        // Trusted Source Bonus
        if (isTrusted) score += 5; 

        // Junk/Clickbait/Lifestyle Penalty (The Trap)
        if (JUNK_KEYWORDS.some(word => titleLower.includes(word))) score -= 20;

        return score;
    }

    private isValid(article: INewsSourceArticle): boolean {
        if (!article.title || !article.url) return false;
        
        // Increased min length to filter out "ticker" updates
        if (article.title.length < 20) return false; 
        
        if (article.title === "No Title") return false;
        if (!article.description || article.description.length < 30) return false; 
        return true;
    }

    private isFuzzyDuplicate(currentTitle: string, existingTitles: string[]): boolean {
        const currentLen = currentTitle.length;
        
        for (const existing of existingTitles) {
            if (Math.abs(currentLen - existing.length) > 20) {
                continue;
            }
            const score = getSimilarityScore(currentTitle, existing);
            if (score > 0.8) {
                return true; 
            }
        }
        return false;
    }
}

export default new ArticleProcessor();
