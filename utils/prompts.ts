// utils/prompts.ts

const AI_PERSONALITY = {
    MAX_WORDS: 75, 
    TONE: "Objective, authoritative, and direct (News Wire Style)",
    BIAS_STRICTNESS: "Strict. Flag subtle framing, omission, and emotional language.",
    FORBIDDEN_WORDS: "delves, underscores, crucial, tapestry, landscape, moreover, notably, the article, the report, the author, discusses, highlights, according to"
};

const STYLE_RULES = `
Style Guidelines:
- **DIRECT REPORTING:** Act as the primary source. Do NOT say "The article states" or "The report highlights." Just state the facts.
- **TITLE ACCURACY:** Use the EXACT titles found in the source text.
- Tone: ${AI_PERSONALITY.TONE}.
- Length: Around ${AI_PERSONALITY.MAX_WORDS} words.
- Structure: Use short, punchy sentences suitable for audio reading.
- Grammar: Do NOT use hyphens (-), dashes (—), or colons (:) within sentences. Use periods or commas.
- Vocabulary: Do NOT use these words: ${AI_PERSONALITY.FORBIDDEN_WORDS}.
`;

// We use 'any' for the article input here because it comes from external APIs (GNews/NewsAPI)
// and doesn't match our internal database model yet.
export const getAnalysisPrompt = (article: any): string => {
  const title = article?.title || "No Title";
  const desc = article?.description || "No Description";
  const content = article?.content || ""; 
  const date = new Date().toISOString().split('T')[0];
  
  return `
Role: You are a Lead Editor for a global news wire.
Task: Rewrite the following story into a breaking news brief.

Input Article:
Headline: "${title}"
Description: "${desc}"
Snippet: "${content.substring(0, 400)}"
Date: ${date}

--- INSTRUCTIONS ---

1. **Summarize (News Wire Style)**:
   ${STYLE_RULES}
   - Report the "Who, What, When, Where, Why" immediately.

2. **Categorize**:
   - Choose ONE: Politics, Business, Economy, Global Conflict, Tech, Science, Health, Justice, Sports, Entertainment, Lifestyle, Crypto & Finance, Gaming.

3. **Assess Bias & Trust (${AI_PERSONALITY.BIAS_STRICTNESS})**:
   - Political Lean: Left, Left-Leaning, Center, Right-Leaning, Right.
   - Bias Score (0-100): 0 = Neutral, 100 = Propaganda.
   - Trust Score (0-100): Based on source history and tone.

4. **Extract Entities**:
   - Primary Noun: The main subject (Person, Country, or Org).
   - Secondary Noun: The context or second party.

--- OUTPUT FORMAT ---
Respond ONLY in valid JSON. Do not add markdown blocks.

{
  "summary": "Direct, factual news brief.",
  "category": "CategoryString",
  "politicalLean": "Center",
  "analysisType": "Full",
  "sentiment": "Neutral",
  "clusterTopic": "Main Event Name",
  "country": "Global",
  "primaryNoun": "Subject",
  "secondaryNoun": "Context",
  "biasScore": 10, 
  "biasLabel": "Minimal Bias",
  "biasComponents": {
    "linguistic": {"sentimentPolarity": 0, "emotionalLanguage": 0, "loadedTerms": 0, "complexityBias": 0},
    "sourceSelection": {"sourceDiversity": 0, "expertBalance": 0, "attributionTransparency": 0},
    "demographic": {"genderBalance": 0, "racialBalance": 0, "ageRepresentation": 0},
    "framing": {"headlineFraming": 0, "storySelection": 0, "omissionBias": 0}
  },
  "credibilityScore": 90, "credibilityGrade": "A",
  "credibilityComponents": {"sourceCredibility": 0, "factVerification": 0, "professionalism": 0, "evidenceQuality": 0, "transparency": 0, "audienceTrust": 0},
  "reliabilityScore": 90, "reliabilityGrade": "A",
  "reliabilityComponents": {"consistency": 0, "temporalStability": 0, "qualityControl": 0, "publicationStandards": 0, "correctionsPolicy": 0, "updateMaintenance": 0},
  "trustLevel": "High",
  "keyFindings": ["Finding 1", "Finding 2"],
  "recommendations": []
}`;
};
