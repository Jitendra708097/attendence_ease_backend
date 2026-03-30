/**
 * @param {number[]} values
 * @returns {number[]}
 */
function normalizeEmbedding(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values.map((value) => Number(value));
}

/**
 * @param {number[]} embedding
 * @returns {boolean}
 */
function isValidEmbedding(embedding) {
  return (
    Array.isArray(embedding) &&
    embedding.length === 128 &&
    embedding.every((value) => Number.isFinite(Number(value)))
  );
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, val, index) => sum + val * b[index], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));

  if (!magA || !magB) {
    return 0;
  }

  return dot / (magA * magB);
}

/**
 * @param {number[]} submittedEmbedding
 * @param {number[]} storedEmbedding
 * @returns {{ score: number, isMatch: boolean }}
 */
function compareEmbeddings(submittedEmbedding, storedEmbedding) {
  const normalizedSubmitted = normalizeEmbedding(submittedEmbedding);
  const normalizedStored = normalizeEmbedding(storedEmbedding);

  if (!isValidEmbedding(normalizedSubmitted) || !isValidEmbedding(normalizedStored)) {
    return {
      score: 0,
      isMatch: false,
    };
  }

  const score = cosineSimilarity(normalizedSubmitted, normalizedStored);

  return {
    score,
    isMatch: score > 0,
  };
}

module.exports = {
  normalizeEmbedding,
  isValidEmbedding,
  cosineSimilarity,
  compareEmbeddings,
};
