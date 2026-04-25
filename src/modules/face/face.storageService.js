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

async function uploadEnrollmentSelfie(buffer, orgId, empId) {
  if (!isCloudinaryConfigured) {
    return null;
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `attendease/face-enrollment/${orgId}`,
        public_id: `${empId}-${Date.now()}`,
        resource_type: 'image',
      },
      (error, result) => {
        if (error) {
          reject(error);
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

async function deleteEnrollmentSelfie(publicId) {
  if (!isCloudinaryConfigured || !publicId) {
    return false;
  }

  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = {
  uploadEnrollmentSelfie,
  deleteEnrollmentSelfie,
};
