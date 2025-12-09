// utils/prompts.js
// OPTIMIZED V3.1: Style Guidelines (No Hyphens) + Tone

/**
 * Generates the specific AI prompt based on the Gatekeeper's classification.
 */
const getAnalysisPrompt = (article, type) => {
  const title = article?.title || "No Title";
  const desc = article?.description || "No Description";
  const date = new Date().toISOString().split('T')[0];

  const STYLE_RULES = `
Style Guidelines:
- Do NOT use hyphens (-), dashes (—), or colons (:) within sentences. 
- Use commas or periods for pauses.
- Sentences must be complete and professional.
`;

  // --- 1. HARD NEWS PROMPT ---
  if (type === 'Hard News') {
    return `Analyze this Hard News article:
Title: "${title}"
Desc: "${desc}"
Date: ${date}

Tasks:
1. Analysis Type: 'Full'
2. Summarize: Factual, neutral summary (max 60 words). ${STYLE_RULES}
3. Bias/Trust: Assess strictly.
4. Categories: Politics, Business, Economy, Global Conflict, Tech, Science, Health, Justice.

Respond ONLY in JSON:
{
  "summary": "Neutral summary string.",
  "category": "CategoryString",
  "politicalLean": "Left"|"Left-Leaning"|"Center"|"Right-Leaning"|"Right",
  "analysisType": "Full",
  "sentiment": "Neutral",
  "clusterTopic": "Event Name",
  "country": "USA"|"India"|"Global",
  "primaryNoun": "Person/Org",
  "secondaryNoun": "Person/Org",
  "biasScore": 0-100, 
  "biasLabel": "Label",
  "biasComponents": {
    "linguistic": {"sentimentPolarity": 0, "emotionalLanguage": 0, "loadedTerms": 0, "complexityBias": 0},
    "sourceSelection": {"sourceDiversity": 0, "expertBalance": 0, "attributionTransparency": 0},
    "demographic": {"genderBalance": 0, "racialBalance": 0, "ageRepresentation": 0},
    "framing": {"headlineFraming": 0, "storySelection": 0, "omissionBias": 0}
  },
  "credibilityScore": 0-100, "credibilityGrade": "A/B/C/D/F",
  "credibilityComponents": {"sourceCredibility": 0, "factVerification": 0, "professionalism": 0, "evidenceQuality": 0, "transparency": 0, "audienceTrust": 0},
  "reliabilityScore": 0-100, "reliabilityGrade": "A/B/C/D/F",
  "reliabilityComponents": {"consistency": 0, "temporalStability": 0, "qualityControl": 0, "publicationStandards": 0, "correctionsPolicy": 0, "updateMaintenance": 0},
  "trustLevel": "High/Medium/Low",
  "keyFindings": ["Fact 1", "Fact 2"],
  "recommendations": []
}`;
  }

  // --- 2. SOFT NEWS / OPINION PROMPT ---
  return `Analyze this ${type === 'Opinion' ? 'Opinion/Op-Ed' : 'Soft News'} article:
Title: "${title}"
Desc: "${desc}"

Tasks:
1. Analysis Type: 'SentimentOnly' (No Bias/Trust scores).
2. Summary: 
   - If Opinion: Extract the core ARGUMENT.
   - If Soft News: Simple summary.
   - ${STYLE_RULES}
3. Tone (Mapped to Sentiment):
   - "Positive" = Supportive / Praising / Optimistic
   - "Negative" = Critical / Condemning / Pessimistic
   - "Neutral" = Balanced / Factual

Respond ONLY in JSON:
{
  "summary": "The Argument or Summary.",
  "category": "Sports"|"Entertainment"|"Lifestyle"|"Technology"|"Business"|"Other",
  "politicalLean": "Not Applicable",
  "analysisType": "SentimentOnly",
  "sentiment": "Positive"|"Negative"|"Neutral",
  "clusterTopic": "Topic Name",
  "country": "Global",
  "primaryNoun": "Subject",
  "secondaryNoun": null,
  "biasScore": 0,
  "credibilityScore": 0,
  "reliabilityScore": 0,
  "trustScore": 0,
  "keyFindings": [],
  "recommendations": []
}`;
};

module.exports = { getAnalysisPrompt };
