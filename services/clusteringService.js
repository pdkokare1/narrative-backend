// In file: services/clusteringService.js
const { pipeline, cos_sim } = await import('@xenova/transformers');

// --- Configuration ---
// The similarity threshold. 0.95 is very high (strong match).
const SIMILARITY_THRESHOLD = 0.95;
// The model we'll use for embeddings. 'glist-query-v1.1' is small, fast, and powerful.
const EMBEDDING_MODEL = 'Xenova/glist-query-v1.1';

/**
 * Singleton class to ensure we only load the AI model once.
 * This is crucial for performance, as loading the model is expensive.
 */
class EmbeddingPipelineSingleton {
  static instance = null;

  static async getInstance() {
    if (this.instance === null) {
      console.log('🤖 Loading embedding model for clustering...');
      // Initialize the pipeline
      this.instance = pipeline('feature-extraction', EMBEDDING_MODEL);
      console.log('✅ Embedding model loaded successfully.');
    }
    return this.instance;
  }
}

/**
 * Calculates the cosine similarity between two vectors.
 * @param {number[]} vecA - The first vector.
 * @param {number[]} vecB - The second vector.
 * @returns {number} - The similarity score (0 to 1).
 */
function calculateCosineSimilarity(vecA, vecB) {
  // Use the built-in cos_sim function from the library
  return cos_sim(vecA, vecB);
}

/**
 * Converts a text string into a numerical vector (embedding).
 * @param {string} text - The text to embed (e.g., the clusterTopic).
 * @returns {Promise<number[]>} - The numerical vector.
 */
async function getEmbedding(text) {
  const extractor = await EmbeddingPipelineSingleton.getInstance();
  
  // Generate the embedding
  const output = await extractor(text, {
    pooling: 'mean', // Average the vectors of all tokens in the text
    normalize: true, // Normalize the vector (important for cosine similarity)
  });

  // Convert the Tensor output to a standard JavaScript array
  return Array.from(output.data);
}

/**
 * Finds the best matching cluster from a list of candidates.
 * @param {number[]} newVector - The vector of the new article.
 * @param {object[]} candidates - Array of recent articles from the DB.
 * @returns {object|null} - The best matching article (if above threshold) or null.
 */
function findBestMatch(newVector, candidates) {
  let bestMatch = null;
  let highestSimilarity = -1; // Start at -1 (lowest possible score)

  if (!newVector || newVector.length === 0 || !candidates || candidates.length === 0) {
    return null;
  }

  // Loop through every recent article
  for (const candidate of candidates) {
    // Ensure the candidate has a valid vector
    if (!candidate.clusterTopicVector || candidate.clusterTopicVector.length === 0) {
      continue;
    }

    // Calculate the similarity
    const similarity = calculateCosineSimilarity(newVector, candidate.clusterTopicVector);

    // If this is the new best match, record it
    if (similarity > highestSimilarity) {
      highestSimilarity = similarity;
      bestMatch = candidate;
    }
  }

  // After checking all candidates, see if the best one met our threshold
  if (highestSimilarity >= SIMILARITY_THRESHOLD) {
    console.log(`✅ Found cluster match! Similarity: ${highestSimilarity.toFixed(4)}`);
    return bestMatch;
  } else {
    // No match was strong enough
    return null;
  }
}

module.exports = {
  getEmbedding,
  findBestMatch,
};
