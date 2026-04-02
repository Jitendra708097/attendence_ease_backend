const { DeleteFacesCommand, IndexFacesCommand, SearchFacesByImageCommand } = require('@aws-sdk/client-rekognition');
const env = require('../../config/env');
const rekognitionClient = require('../../config/rekognition');

function canUseRekognition() {
  return Boolean(
    env.aws.region &&
      env.aws.accessKeyId &&
      env.aws.secretAccessKey &&
      env.aws.rekognitionCollectionId
  );
}

/**
 * @param {Buffer} selfieBuffer
 * @param {{ face_embedding_id?: string | null }} employee
 * @returns {Promise<{ matched: boolean, confidence: number | null, provider: string }>}
 */
async function verifyWithRekognition(selfieBuffer, employee) {
  if (!canUseRekognition() || !Buffer.isBuffer(selfieBuffer) || !employee.face_embedding_id) {
    return {
      matched: false,
      confidence: null,
      provider: 'rekognition_skipped',
    };
  }

  const command = new SearchFacesByImageCommand({
    CollectionId: env.aws.rekognitionCollectionId,
    Image: {
      Bytes: selfieBuffer,
    },
    FaceMatchThreshold: 80,
    MaxFaces: 3,
  });

  try {
    const response = await rekognitionClient.send(command);
    const matchingFace = (response.FaceMatches || []).find(
      (item) => item.Face && item.Face.FaceId === employee.face_embedding_id
    );

    return {
      matched: Boolean(matchingFace),
      confidence: matchingFace ? matchingFace.Similarity || null : null,
      provider: 'rekognition',
    };
  } catch (error) {
    return {
      matched: false,
      confidence: null,
      provider: 'rekognition_error',
    };
  }
}

/**
 * @param {string} employeeId
 * @param {Buffer} selfieBuffer
 * @returns {Promise<string | null>}
 */
async function enrollWithRekognition(employeeId, selfieBuffer) {
  if (!canUseRekognition() || !Buffer.isBuffer(selfieBuffer)) {
    return null;
  }

  const command = new IndexFacesCommand({
    CollectionId: env.aws.rekognitionCollectionId,
    ExternalImageId: employeeId,
    DetectionAttributes: [],
    Image: {
      Bytes: selfieBuffer,
    },
    MaxFaces: 1,
    QualityFilter: 'AUTO',
  });

  try {
    const response = await rekognitionClient.send(command);
    return response.FaceRecords && response.FaceRecords[0] && response.FaceRecords[0].Face
      ? response.FaceRecords[0].Face.FaceId
      : null;
  } catch (error) {
    return null;
  }
}

/**
 * @param {string | null | undefined} faceId
 * @returns {Promise<boolean>}
 */
async function deleteFromRekognition(faceId) {
  if (!canUseRekognition() || !faceId) {
    return false;
  }

  const command = new DeleteFacesCommand({
    CollectionId: env.aws.rekognitionCollectionId,
    FaceIds: [faceId],
  });

  try {
    await rekognitionClient.send(command);
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = {
  canUseRekognition,
  verifyWithRekognition,
  enrollWithRekognition,
  deleteFromRekognition,
};
