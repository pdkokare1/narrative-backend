// In file: services/clusteringService.js
// --- FIX: Declare variables at the top, but do not await ---
let pipeline;
let cos_sim;
let transformersLoaded = false; // Add a flag

// --- Configuration ---
const SIMILARITY_THRESHOLD = 0.95;
// The model we'll use for embeddings. 'glist-query-v1.1' is small, fast, and powerful.
const EMBEDDING_MODEL = 'Xenova/glist-query-v1.1';

/**
 * --- NEW: Async function to load the library ---
 * This ensures we only 'await import' one time, inside an async context.
 */
async function initializeTransformers() {
  // Check the flag. If it's true, the library is already loaded.
  if (transformersLoaded) return;
  
  console.log('🤖 Loading @xenova/transformers library...');
  
  // Use 'await import' inside this async function
  const transformers = await import('@xenova/transformers');
  
  // Assign the imported functions to our top-level variables
  pipeline = transformers.pipeline;
  cos_sim = transformers.cos_sim;
  
  // Set the flag to true so we don't load it again
  transformersLoaded = true;
  console.log('✅ @xenova/transformers library loaded.');
}


/**
 * Singleton class to ensure we only load the AI model once.
 * This is crucial for performance, as loading the model is expensive.
 */
class EmbeddingPipelineSingleton {
  static instance = null;

  static async getInstance() {
    // --- FIX: Ensure library is loaded *before* getting instance ---
    // This will run the import on the first call and skip on subsequent calls.
    await initializeTransformers();

    if (this.instance === null) {
      console.log('🤖 Loading embedding model for clustering...');
      // 'pipeline' is now available because initializeTransformers() finished
      this.instance = pipeline('feature-extraction', EMBEDDING_MODEL);
      console.log('✅ Embedding model loaded successfully.');
    }
    return this.instance;
  }
}

/**
 * Calculates the cosine similarity between two vectors.
 * --- FIX: This function is now async ---
 * @param {number[]} vecA - The first vector.
 *@param {number[]} vecB - The second vector.
 * @returns {Promise<number>} - The similarity score (0 to 1).
 */
async function calculateCosineSimilarity(vecA, vecB) {
  // --- FIX: Ensure library is loaded *before* using cos_sim ---
  await initializeTransformers();

  // 'cos_sim' is now available
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
 * --- FIX: This function is now async ---
 * @param {number[]} newVector - The vector of the new article.
 * @param {object[]} candidates - Array of recent articles from the DB.
 * @returns {Promise<object|null>} - The best matching article (if above threshold) or null.
 */
async function findBestMatch(newVector, candidates) {
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

    // --- FIX: Must await the async similarity function ---
    const similarity = await calculateCosineSimilarity(newVector, candidate.clusterTopicVector);

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
};}

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
