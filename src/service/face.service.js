const {
  IndexFacesCommand,
  SearchFacesByImageCommand,
  CreateFaceLivenessSessionCommand,
  GetFaceLivenessSessionResultsCommand,
}  =  require("@aws-sdk/client-rekognition");
const rekognitionClient = require("../config/rekognition");

const COLLECTION_ID = process.env.AWS_REKOGNITION_COLLECTION_ID;

// ✅ 1. INDEX / REGISTER FACE
 const indexFace = async (imageBuffer, userId) => {
  const command = new IndexFacesCommand({
    CollectionId: COLLECTION_ID,
    Image: {
      Bytes: imageBuffer,
    },
    ExternalImageId: userId, // your user ID (e.g. MongoDB _id)
    DetectionAttributes: ["ALL"],
    MaxFaces: 1,
    QualityFilter: "AUTO",
  });

  const response = await rekognitionClient.send(command);

  if (response.FaceRecords.length === 0) {
    throw new Error("No face detected in the image. Please use a clear photo.");
  }

  const face = response.FaceRecords[0].Face;

  return {
    faceId: face.FaceId,
    userId: face.ExternalImageId,
    confidence: face.Confidence,
    message: "Face registered successfully!",
  };
};

// ✅ 2. SEARCH / MATCH FACE
const searchFace = async (imageBuffer) => {
  const command = new SearchFacesByImageCommand({
    CollectionId: COLLECTION_ID,
    Image: {
      Bytes: imageBuffer,
    },
    MaxFaces: 1,
    FaceMatchThreshold: 90, // 90% similarity required
  });

  const response = await rekognitionClient.send(command);

  if (response.FaceMatches.length === 0) {
    return {
      matched: false,
      message: "No matching face found.",
    };
  }

  const match = response.FaceMatches[0];

  return {
    matched: true,
    userId: match.Face.ExternalImageId,
    faceId: match.Face.FaceId,
    similarity: match.Similarity,
    confidence: match.Face.Confidence,
    message: "Face matched successfully!",
  };
};

// ✅ 3. CREATE FACE LIVENESS SESSION
 const createLivenessSession = async () => {
  const command = new CreateFaceLivenessSessionCommand({
    Settings: {
      OutputConfig: {
        S3Bucket: process.env.S3_BUCKET_NAME, // optional - remove if no S3
      },
      AuditImagesLimit: 2,
    },
  });

  const response = await rekognitionClient.send(command);

  return {
    sessionId: response.SessionId,
    message: "Liveness session created!",
  };
};

// ✅ 4. GET FACE LIVENESS RESULT
 const getLivenessResult = async (sessionId) => {
  const command = new GetFaceLivenessSessionResultsCommand({
    SessionId: sessionId,
  });

  const response = await rekognitionClient.send(command);

  return {
    sessionId: response.SessionId,
    status: response.Status,          // SUCCEEDED / FAILED
    confidence: response.Confidence,  // e.g. 99.5
    isLive: response.Confidence >= 75, // 75%+ = real person
    message:
      response.Confidence >= 75
        ? "User is live!"
        : "Liveness check failed!",
  };
};


module.exports = {
  indexFace,
  searchFace,
  createLivenessSession,
  getLivenessResult,
};