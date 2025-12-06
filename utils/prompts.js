// utils/prompts.js
// This file contains the instructions (prompts) sent to the Gemini AI.
// Centralizing it here makes it easier to tweak the AI's "personality" or logic.

const getAnalysisPrompt = (article) => {
  const title = article?.title || "No Title";
  const description = article?.description || "No Description";
  const currentDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

  return `CURRENT_CONTEXT: Today's date is ${currentDate}.

Analyze this article:
Title: "${title}"
Description: "${description}"

Respond ONLY with valid JSON. Do not include markdown formatting like \`\`\`json.

INSTRUCTIONS:
1. Determine 'analysisType': 'Full' (Hard News) or 'SentimentOnly' (Opinion/Review).
2. If 'Full', provide numerical scores (0-100). If 'SentimentOnly', scores must be 0.
3. 'isJunk': Set to true ONLY if it is an advertisement, spam, or broken text.

JSON Structure:
{
  "summary": "Neutral summary (approx 60 words).",
  "category": "Politics" | "Economy" | "Technology" | "Health" | "Environment" | "Justice" | "Education" | "Entertainment" | "Sports" | "Other",
  "politicalLean": "Left" | "Left-Leaning" | "Center" | "Right-Leaning" | "Right" | "Not Applicable",
  "analysisType": "Full" | "SentimentOnly",
  "sentiment": "Positive" | "Negative" | "Neutral",
  "isJunk": false,
  "clusterTopic": "Specific Event Name (e.g. 'G20 Summit 2024') or null",
  "country": "USA" | "India" | "Global",
  "primaryNoun": "Main Person/Org",
  "secondaryNoun": "Secondary Person/Org",
  "biasScore": 0, "biasLabel": "Label",
  "biasComponents": {"linguistic": {"sentimentPolarity": 0, "emotionalLanguage": 0, "loadedTerms": 0, "complexityBias": 0}, "sourceSelection": {"sourceDiversity": 0, "expertBalance": 0, "attributionTransparency": 0}, "demographic": {"genderBalance": 0, "racialBalance": 0, "ageRepresentation": 0}, "framing": {"headlineFraming": 0, "storySelection": 0, "omissionBias": 0}},
  "credibilityScore": 0, "credibilityGrade": "Grade",
  "credibilityComponents": {"sourceCredibility": 0, "factVerification": 0, "professionalism": 0, "evidenceQuality": 0, "transparency": 0, "audienceTrust": 0},
  "reliabilityScore": 0, "reliabilityGrade": "Grade",
  "reliabilityComponents": {"consistency": 0, "temporalStability": 0, "qualityControl": 0, "publicationStandards": 0, "correctionsPolicy": 0, "updateMaintenance": 0},
  "trustLevel": "Label",
  "coverageLeft": 0, "coverageCenter": 0, "coverageRight": 0,
  "keyFindings": ["Point 1", "Point 2"],
  "recommendations": ["Rec 1", "Rec 2"]
}`;
};

module.exports = { getAnalysisPrompt };
