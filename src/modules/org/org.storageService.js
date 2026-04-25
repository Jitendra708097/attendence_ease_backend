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

async function uploadOrgLogoToCloudinary(buffer, orgId) {
  if (!isCloudinaryConfigured) {
    throw createError('ORG_011', 'Cloudinary is not configured on the server', 503);
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `attendease/org-logos/${orgId}`,
        public_id: `logo-${Date.now()}`,
        resource_type: 'image',
        overwrite: true,
      },
      (error, result) => {
        if (error) {
          reject(createError('ORG_012', 'Failed to upload organisation logo', 502));
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

async function deleteOrgLogo(publicId) {
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
  uploadOrgLogoToCloudinary,
  deleteOrgLogo,
};
