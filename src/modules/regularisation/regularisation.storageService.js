const { v2: cloudinary } = require('cloudinary');
const env = require('../../config/env');

const isCloudinaryConfigured = Boolean(
  env.cloudinary &&
  env.cloudinary.cloudName &&
  env.cloudinary.apiKey &&
  env.cloudinary.apiSecret
);

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: env.cloudinary.cloudName,
    api_key: env.cloudinary.apiKey,
    api_secret: env.cloudinary.apiSecret,
  });
}

function createError(code, message, statusCode, details = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

async function uploadRegularisationEvidence(buffer, orgId, empId, regularisationId) {
  if (!isCloudinaryConfigured) {
    throw createError('REG_010', 'Evidence upload storage is not configured on the server', 503);
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `attendease/regularisations/${orgId}/${empId}`,
        public_id: `${regularisationId}-${Date.now()}`,
        resource_type: 'image',
      },
      (error, result) => {
        if (error) {
          reject(createError('REG_011', 'Failed to upload regularisation evidence', 502));
          return;
        }

        resolve({
          publicId: result.public_id,
          secureUrl: result.secure_url,
        });
      }
    );

    stream.end(buffer);
  });
}

module.exports = {
  uploadRegularisationEvidence,
};
