const { RekognitionClient } = require("@aws-sdk/client-rekognition");
const env = require('./env');

const rekognitionClient = new RekognitionClient({
  region: env.aws.region,
  credentials: {
    accessKeyId: env.aws.accessKeyId,
    secretAccessKey: env.aws.secretAccessKey,
  },
});

module.exports = rekognitionClient;