// services/aiService.js
const axios = require('axios');
const { getAnalysisPrompt } = require('../utils/prompts');

// --- CONSTANTS ---
const EMBEDDING_MODEL = "text-embedding-004";
const FLASH_MODEL = "gemini-2.5-flash"; // For Soft News
const PRO_MODEL = "gemini-2.5-pro";     // For Hard News

class AIService {
  constructor() {
    this.apiKeys = this.loadApiKeys();
    this.currentKeyIndex = 0;
  }

  loadApiKeys() {
    const keys = [];
    for (let i = 1; i <= 20; i++) {
      const key = process.env[`GEMINI_API_KEY_${i}`]?.trim();
      if (key) keys.push(key);
    }
    const defaultKey = process.env.GEMINI_API_KEY?.trim();
    if (keys.length === 0 && defaultKey) keys.push(defaultKey);
    return keys;
  }

  getNextApiKey() {
    if (this.apiKeys.length === 0) throw new Error("No Gemini Keys");
    const key = this.apiKeys[this.currentKeyIndex];
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
    return key;
  }

  // --- MAIN ANALYSIS ---
  // Now accepts 'targetModel' (Flash vs Pro)
  async analyzeArticle(article, targetModel = PRO_MODEL) {
    const apiKey = this.getNextApiKey();
    const prompt = getAnalysisPrompt(article);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;

    try {
      const response = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.3 }
      }, { timeout: 60000 });

      return this.parseResponse(response.data);
    } catch (error) {
      console.error(`❌ AI Analysis Failed (${targetModel}): ${error.message}`);
      throw error;
    }
  }

  // --- EMBEDDINGS (Clustering) ---
  async createEmbedding(text) {
      if (!text) return null;
      const apiKey = this.getNextApiKey();
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;

      try {
          // Truncate for safety
          const safeText = text.substring(0, 8000); 
          const response = await axios.post(url, {
              content: { parts: [{ text: safeText }] },
              taskType: "CLUSTERING"
          });
          return response.data.embedding.values;
      } catch (error) {
          console.error(`❌ Embedding Failed: ${error.message}`);
          return null;
      }
  }

  parseResponse(data) {
    try {
        let text = data.candidates[0].content.parts[0].text;
        text = text.replace(/```json|```/g, '').trim();
        const jsonStart = text.indexOf('{');
        const jsonEnd = text.lastIndexOf('}');
        return JSON.parse(text.substring(jsonStart, jsonEnd + 1));
    } catch (e) {
        throw new Error("Failed to parse AI JSON response");
    }
  }
}

module.exports = new AIService();
