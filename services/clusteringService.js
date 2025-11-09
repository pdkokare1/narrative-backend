// In file: services/clusteringService.js
const stringSimilarity = require('string-similarity');

// Set the similarity threshold
// 0.7 means "70% similar"
const SIMILARITY_THRESHOLD = 0.7;

/**
 * Finds the best cluster match for a new article topic using string similarity.
 * @param {string} newTopic - The clusterTopic of the new article (e.g., "Ukraine Peace Summit").
 * @param {Array<Object>} candidates - An array of recent articles to compare against.
 * Each object should have { clusterId: 123, clusterTopic: "Ukraine Peace Talks" }.
 * @returns {Object|null} - An object with { clusterId, score } if a match > 70% is found, otherwise null.
 */
function findBestMatch(newTopic, candidates) {
  // If there are no candidates, we can't find a match.
  if (!candidates || candidates.length === 0) {
    return null;
  }

  // 1. Get a list of all unique topic strings from the candidates
  const candidateTopics = candidates.map(c => c.clusterTopic);

  // 2. Use the 'string-similarity' library to find the best match
  // This is much faster than looping ourselves.
  const { bestMatch } = stringSimilarity.findBestMatch(newTopic, candidateTopics);

  // 3. Check if the best match is good enough
  if (bestMatch.rating >= SIMILARITY_THRESHOLD) {
    // 4. It is! Now we find the original candidate that had that matching topic
    // so we can get its clusterId.
    const matchingCandidate = candidates.find(c => c.clusterTopic === bestMatch.target);

    if (matchingCandidate) {
      // 5. Return the clusterId and the similarity score
      return {
        clusterId: matchingCandidate.clusterId,
        score: bestMatch.rating
      };
    }
  }

  // If no match was found, or the best match was not good enough
  return null;
}

// Export the function so server.js can use it
module.exports = {
  findBestMatch
};
