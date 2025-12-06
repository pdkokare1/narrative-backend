// utils/prompts.js
// OPTIMIZED V2: Reduced token count for cost efficiency while maintaining accuracy.

const getAnalysisPrompt = (article) => {
  const title = article?.title || "No Title";
  const desc = article?.description || "No Description";
  // Shortened date format
  const date = new Date().toISOString().split('T')[0];

  return `Analyze:
Title: "${title}"
Desc: "${desc}"
Date: ${date}

Respond ONLY in valid JSON. No Markdown.

Tasks:
1. Type: 'Full' (Hard News) or 'SentimentOnly' (Opinion).
2. Scores: 0-100 (Integer). If SentimentOnly, scores=0.
3. Junk: true if ad/spam/broken.

JSON Format:
{
  "summary": "Neutral summary (max 60 words).",
  "category": "Politics"|"Economy"|"Technology"|"Health"|"Environment"|"Justice"|"Education"|"Entertainment"|"Sports"|"Other",
  "politicalLean": "Left"|"Left-Leaning"|"Center"|"Right-Leaning"|"Right"|"Not Applicable",
  "analysisType": "Full"|"SentimentOnly",
  "sentiment": "Positive"|"Negative"|"Neutral",
  "isJunk": boolean,
  "clusterTopic": "Specific Event Name or null",
  "country": "USA"|"India"|"Global",
  "primaryNoun": "Person/Org",
  "secondaryNoun": "Person/Org",
  "biasScore": 0, "biasLabel": "Label",
  "biasComponents": {
    "linguistic": {"sentimentPolarity": 0, "emotionalLanguage": 0, "loadedTerms": 0, "complexityBias": 0},
    "sourceSelection": {"sourceDiversity": 0, "expertBalance": 0, "attributionTransparency": 0},
    "demographic": {"genderBalance": 0, "racialBalance": 0, "ageRepresentation": 0},
    "framing": {"headlineFraming": 0, "storySelection": 0, "omissionBias": 0}
  },
  "credibilityScore": 0, "credibilityGrade": "A/B/C/D/F",
  "credibilityComponents": {"sourceCredibility": 0, "factVerification": 0, "professionalism": 0, "evidenceQuality": 0, "transparency": 0, "audienceTrust": 0},
  "reliabilityScore": 0, "reliabilityGrade": "A/B/C/D/F",
  "reliabilityComponents": {"consistency": 0, "temporalStability": 0, "qualityControl": 0, "publicationStandards": 0, "correctionsPolicy": 0, "updateMaintenance": 0},
  "trustLevel": "Label",
  "coverageLeft": 0, "coverageCenter": 0, "coverageRight": 0,
  "keyFindings": ["Point 1", "Point 2"],
  "recommendations": ["Rec 1", "Rec 2"]
}`;
};

module.exports = { getAnalysisPrompt };
