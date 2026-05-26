const crypto = require('crypto');
const { Employee } = require('../../models');
const { redisClient } = require('../../config/redis');
const { faceEnrollment } = require('../../queues');
const { verifyWithRekognition, enrollWithRekognition, deleteFromRekognition } = require('./face.cloudService');
const { uploadEnrollmentSelfie } = require('./face.storageService');
const { notifyOrgRoles, sendPush } = require('../notification/notification.service');

const THRESHOLDS = {
  probationary: 88,
  default: 84,
  trusted: 80,
  flagged: 95,
};

function createError(code, message, statusCode, details = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function getTrustScore(employee) {
  return employee.trust_score || 'probationary';
}

function getThreshold(employee) {
  return THRESHOLDS[getTrustScore(employee)] || THRESHOLDS.default;
}

function getDedupKey(orgId, empId) {
  return `face_dedup:${orgId}:${empId}`;
}

function getSessionKey(orgId, empId) {
  return `face_session:${orgId}:${empId}`;
}

function getEnrollmentStatusKey(orgId, empId) {
  return `face_enrollment_status:${orgId}:${empId}`;
}

async function safeRedisGet(key) {
  try {
    return await redisClient.get(key);
  } catch (error) {
    return null;
  }
}

async function safeRedisSet(key, value, ttlSeconds) {
  try {
    await redisClient.set(key, value, 'EX', ttlSeconds);
  } catch (error) {
    return null;
  }

  return true;
}

async function safeRedisDel(...keys) {
  try {
    if (keys.length > 0) {
      await redisClient.del(...keys);
    }
  } catch (error) {
    return null;
  }

  return true;
}

/**
 * @param {string | null | undefined} selfieBase64
 * @returns {Buffer | null}
 */
function decodeSelfie(selfieBase64) {
  if (!selfieBase64 || typeof selfieBase64 !== 'string') {
    return null;
  }

  const value = selfieBase64.includes(',')
    ? selfieBase64.split(',').pop()
    : selfieBase64;

  try {
    return Buffer.from(value, 'base64');
  } catch (error) {
    return null;
  }
}

async function getEmployeeForOrg(empId, orgId) {
  const employee = await Employee.findOne({
    where: {
      id: empId,
      org_id: orgId,
    },
  });

  if (!employee) {
    throw createError('HTTP_404', 'Employee not found', 404);
  }

  return employee;
}

async function verifyFace(empId, orgId, selfieBuffer) {
  // ✅ FIX: Validate org context
  if (!orgId || !empId) {
    throw createError('FACE_002', 'Organization and employee context required', 422);
  }
  
  const employee = await getEmployeeForOrg(empId, orgId);
  
  // ✅ FIX: Validate employee belongs to org
  if (employee.org_id !== orgId && employee.org_id.toString() !== orgId.toString()) {
    throw createError('FACE_006', 'Employee not found in organization', 404);
  }
  
  const threshold = getThreshold(employee);
  const dedupKey = getDedupKey(orgId, empId);
  const sessionKey = getSessionKey(orgId, empId);

  if (!employee.face_embedding_id) {
    throw createError('FACE_001', 'Face enrollment not found for employee', 404);
  }

  if (!Buffer.isBuffer(selfieBuffer)) {
    throw createError('FACE_002', 'Face verification requires a selfie image', 422);
  }

  const selfieHash = crypto.createHash('sha256').update(selfieBuffer).digest('hex');
  const existingDedup = await safeRedisGet(dedupKey);

  if (existingDedup && existingDedup === selfieHash) {
    return { verified: true, source: 'dedup_cache', threshold, score: 1 };
  }

  const cloudOnlyResult = await verifyWithRekognition(selfieBuffer, employee, { threshold });

  if (cloudOnlyResult.matched) {
    await safeRedisSet(dedupKey, selfieHash, 5 * 60);
    await safeRedisSet(sessionKey, JSON.stringify({ verifiedAt: new Date().toISOString(), confidence: cloudOnlyResult.confidence }), 10 * 60);
    return {
      verified: true,
      source: cloudOnlyResult.provider,
      threshold,
      score: null,
      confidence: cloudOnlyResult.confidence,
    };
  }

  throw createError('FACE_MATCH_FAILED', 'Face verification failed', 401, [
    {
      field: 'selfieBase64',
      message: 'Submitted face did not match enrolled employee face',
    },
  ]);
}

async function enqueueEnrollment({ orgId, empId, selfieBase64 }) {
  const employee = await getEmployeeForOrg(empId, orgId);
  const jobId = `face_enrollment_${orgId}_${empId}`;
  const alreadyEnrolled = Boolean(employee.face_embedding_id);

  if (alreadyEnrolled) {
    throw createError('FACE_005', 'Face is already enrolled. Ask an admin to reset it before enrolling again.', 409);
  }

  const selfieBuffer = decodeSelfie(selfieBase64);

  if (!selfieBuffer) {
    throw createError('FACE_004', 'A valid selfie image is required for enrollment', 422);
  }

  const statusKey = getEnrollmentStatusKey(orgId, empId);

  await safeRedisSet(
    statusKey,
    JSON.stringify({
      status: 'pending',
      updatedAt: new Date().toISOString(),
    }),
    60 * 60
  );

  const existingJob = await faceEnrollment.getJob(jobId);

  if (existingJob) {
    const state = await existingJob.getState();

    if (['completed', 'failed', 'stuck'].includes(state)) {
      await existingJob.remove();
    } else if (['waiting', 'active', 'delayed'].includes(state)) {
      return {
        employeeId: employee.id,
        status: 'pending',
      };
    }
  }

  const jobPayload = {
    orgId,
    empId,
    selfieBase64,
  };

  if (redisClient.status !== 'ready' && redisClient.status !== 'connect') {
    await processEnrollmentJob(jobPayload);
    return {
      employeeId: employee.id,
      status: 'enrolled',
      enrolled: true,
      processedInline: true,
    };
  }

  try {
    await faceEnrollment.add(
      'face_enrollment',
      jobPayload,
      {
        jobId,
        removeOnComplete: true,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      }
    );
  } catch (error) {
    await processEnrollmentJob(jobPayload);
    return {
      employeeId: employee.id,
      status: 'enrolled',
      enrolled: true,
      processedInline: true,
    };
  }

  return {
    employeeId: employee.id,
    status: 'pending',
  };
}

async function processEnrollmentJob(jobData) {
  const { orgId, empId, selfieBase64 } = jobData;
  const employee = await getEmployeeForOrg(empId, orgId);
  const selfieBuffer = decodeSelfie(selfieBase64);
  const statusKey = getEnrollmentStatusKey(orgId, empId);

  if (!selfieBuffer) {
    throw createError('FACE_005', 'Enrollment job payload is invalid', 422);
  }

  const uploadedSelfie = await uploadEnrollmentSelfie(selfieBuffer, orgId, empId);
  const faceId = await enrollWithRekognition(empId, selfieBuffer);

  if (!faceId) {
    throw createError(
      'FACE_005',
      'Face enrollment could not store a usable verifier. Configure Rekognition and try again.',
      422
    );
  }

  await employee.update({
    face_embedding_local: null,
    face_embedding_id: faceId,
    face_enrolled_at: new Date(),
    registered_face_url: uploadedSelfie ? uploadedSelfie.secureUrl : employee.registered_face_url,
    is_face_enrolled: true,
  });

  await safeRedisSet(
    statusKey,
    JSON.stringify({
      status: 'enrolled',
      updatedAt: new Date().toISOString(),
      cloudinaryUploaded: Boolean(uploadedSelfie),
      verifierSource: 'rekognition',
    }),
    24 * 60 * 60
  );

  await sendPush(
    [empId],
    {
      type: 'face_enrollment_complete',
      title: 'Face recognition setup complete',
      body: 'Face recognition setup complete. You can now use face verification for attendance.',
      actionUrl: '/home',
    }
  );

  await notifyOrgRoles(
    orgId,
    ['admin', 'manager'],
    {
      type: 'face_enrollment',
      title: 'Employee face enrolled',
      body: `${employee.name} completed face recognition setup.`,
      actionUrl: '/employees',
      data: {
        employee_id: employee.id,
        emp_id: employee.id,
        priority: 'low',
        status: 'completed',
      },
    },
    {
      excludeEmployeeIds: [empId],
    }
  );

  return {
    employeeId: empId,
    enrolled: true,
    providerFaceId: faceId,
    verifierSource: 'rekognition',
  };
}

async function getEnrollmentStatus({ requester, orgId, empId }) {
  if (
    requester.role !== 'admin' &&
    requester.role !== 'manager' &&
    requester.role !== 'superadmin' &&
    requester.id !== empId
  ) {
    throw createError('HTTP_404', 'Employee not found', 404);
  }

  const employee = await getEmployeeForOrg(empId, orgId);
  const redisStatus = await safeRedisGet(getEnrollmentStatusKey(orgId, empId));
  const parsedStatus = redisStatus ? JSON.parse(redisStatus) : null;
  const isEnrolled = Boolean(employee.face_embedding_id);

  return {
    employeeId: employee.id,
    enrolled: isEnrolled,
    status: isEnrolled ? 'enrolled' : parsedStatus ? parsedStatus.status : 'not_enrolled',
    faceId: employee.face_embedding_id || null,
    registeredFaceUrl: employee.registered_face_url || null,
    localEmbeddingAvailable: false,
    provider: employee.face_embedding_id ? 'rekognition' : null,
    updatedAt: parsedStatus ? parsedStatus.updatedAt : null,
  };
}

async function resetEnrollment({ orgId, empId }) {
  const employee = await getEmployeeForOrg(empId, orgId);

  if (employee.face_embedding_id) {
    await deleteFromRekognition(employee.face_embedding_id);
  }

  await employee.update({
    face_embedding_local: null,
    face_embedding_id: null,
    face_enrolled_at: null,
    registered_face_url: null,
    is_face_enrolled: false,
  });

  await safeRedisDel(
    getDedupKey(orgId, empId),
    getSessionKey(orgId, empId),
    getEnrollmentStatusKey(orgId, empId)
  );

  return {
    employeeId: employee.id,
    reset: true,
  };
}

module.exports = {
  THRESHOLDS,
  decodeSelfie,
  verifyFace,
  enqueueEnrollment,
  processEnrollmentJob,
  getEnrollmentStatus,
  resetEnrollment,
};
