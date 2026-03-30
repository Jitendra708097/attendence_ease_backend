const { faceEnrollment } = require('../index');
const faceService = require('../../modules/face/face.service');
const { redisClient } = require('../../config/redis');

function getEnrollmentStatusKey(orgId, empId) {
  return `face_enrollment_status:${orgId}:${empId}`;
}

async function safeRedisSet(key, value, ttlSeconds) {
  try {
    await redisClient.set(key, value, 'EX', ttlSeconds);
  } catch (error) {
    return null;
  }

  return true;
}

let workerRegistered = false;

function registerFaceEnrollmentWorker() {
  if (workerRegistered) {
    return faceEnrollment;
  }

  faceEnrollment.process('face_enrollment', async (job) => {
    return faceService.processEnrollmentJob(job.data);
  });

  faceEnrollment.on('completed', async (job) => {
    const orgId = job && job.data ? job.data.orgId : null;
    const empId = job && job.data ? job.data.empId : null;

    if (orgId && empId) {
      await safeRedisSet(
        getEnrollmentStatusKey(orgId, empId),
        JSON.stringify({
          status: 'enrolled',
          updatedAt: new Date().toISOString(),
        }),
        24 * 60 * 60
      );
    }
  });

  faceEnrollment.on('failed', async (job, error) => {
    const orgId = job && job.data ? job.data.orgId : null;
    const empId = job && job.data ? job.data.empId : null;

    if (orgId && empId) {
      await safeRedisSet(
        getEnrollmentStatusKey(orgId, empId),
        JSON.stringify({
          status: 'failed',
          updatedAt: new Date().toISOString(),
          error: error.message,
        }),
        24 * 60 * 60
      );
    }

    console.error('[queue:face-enrollment] Job failed:', error.message);
  });

  workerRegistered = true;
  return faceEnrollment;
}

module.exports = {
  registerFaceEnrollmentWorker,
};
