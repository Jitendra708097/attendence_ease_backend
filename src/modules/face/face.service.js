const crypto = require('crypto');
const { Employee } = require('../../models');
const { redisClient } = require('../../config/redis');
const { faceEnrollment } = require('../../queues');
const { compareEmbeddings, isValidEmbedding, normalizeEmbedding } = require('./face.localModel');
const { verifyWithRekognition, enrollWithRekognition, deleteFromRekognition } = require('./face.cloudService');

const THRESHOLDS = {
  probationary: 0.88,
  default: 0.84,
  trusted: 0.8,
  flagged: 0.95,
};

const BORDERLINE_MARGIN = 0.03;

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

async function verifyFace(empId, orgId, embedding, selfieBuffer) {
  // ✅ FIX: Validate org context
  if (!orgId || !empId) {
    throw createError('FACE_002', 'Organization and employee context required', 422);
  }
  
  const employee = await getEmployeeForOrg(empId, orgId);
  
  // ✅ FIX: Validate employee belongs to org
  if (employee.org_id !== orgId && employee.org_id.toString() !== orgId.toString()) {
    throw createError('FACE_006', 'Employee not found in organization', 404);
  }
  
  const normalizedEmbedding = Array.isArray(embedding) ? normalizeEmbedding(embedding) : null;
  const hasLocalEmbedding =
    Array.isArray(employee.face_embedding_local) && employee.face_embedding_local.length === 128;
  const threshold = getThreshold(employee);
  const dedupKey = getDedupKey(orgId, empId);
  const sessionKey = getSessionKey(orgId, empId);

  if (!hasLocalEmbedding && !employee.face_embedding_id) {
    throw createError('FACE_001', 'Face enrollment not found for employee', 404);
  }

  if (!normalizedEmbedding && !Buffer.isBuffer(selfieBuffer)) {
    throw createError('FACE_002', 'Face verification requires a face embedding or selfie image', 422);
  }

  if (normalizedEmbedding && !isValidEmbedding(normalizedEmbedding)) {
    throw createError('FACE_002', 'Invalid face embedding payload', 422);
  }

  if (normalizedEmbedding) {
    const embeddingHash = crypto.createHash('sha256').update(JSON.stringify(normalizedEmbedding)).digest('hex');
    const existingDedup = await safeRedisGet(dedupKey);

    if (existingDedup && existingDedup === embeddingHash) {
      return { verified: true, source: 'dedup_cache', threshold, score: 1 };
    }

    const existingSession = await safeRedisGet(sessionKey);

    if (existingSession) {
      return { verified: true, source: 'session_cache', threshold, score: 1 };
    }

    if (hasLocalEmbedding) {
      const localResult = compareEmbeddings(normalizedEmbedding, employee.face_embedding_local);

      if (localResult.score >= threshold) {
        await safeRedisSet(dedupKey, embeddingHash, 5 * 60);
        await safeRedisSet(sessionKey, JSON.stringify({ verifiedAt: new Date().toISOString(), score: localResult.score }), 10 * 60);

        return {
          verified: true,
          source: 'local',
          threshold,
          score: localResult.score,
        };
      }

      const isBorderline = localResult.score >= Math.max(0, threshold - BORDERLINE_MARGIN);

      if (isBorderline) {
        const cloudResult = await verifyWithRekognition(selfieBuffer, employee);

        if (cloudResult.matched) {
          await safeRedisSet(dedupKey, embeddingHash, 5 * 60);
          await safeRedisSet(sessionKey, JSON.stringify({ verifiedAt: new Date().toISOString(), score: localResult.score, confidence: cloudResult.confidence }), 10 * 60);

          return {
            verified: true,
            source: cloudResult.provider,
            threshold,
            score: localResult.score,
            confidence: cloudResult.confidence,
          };
        }
      }

      throw createError('FACE_003', 'Face verification failed', 401, [
        {
          field: 'faceEmbedding',
          message: 'Submitted face did not meet verification threshold',
        },
      ]);
    }
  }

  const cloudOnlyResult = await verifyWithRekognition(selfieBuffer, employee);

  if (cloudOnlyResult.matched) {
    await safeRedisSet(sessionKey, JSON.stringify({ verifiedAt: new Date().toISOString(), confidence: cloudOnlyResult.confidence }), 10 * 60);
    return {
      verified: true,
      source: cloudOnlyResult.provider,
      threshold,
      score: null,
      confidence: cloudOnlyResult.confidence,
    };
  }

  throw createError('FACE_003', 'Face verification failed', 401, [
    {
      field: 'selfieBase64',
      message: 'Submitted face did not match enrolled employee face',
    },
  ]);
}

async function enqueueEnrollment({ orgId, empId, embedding, selfieBase64 }) {
  const employee = await getEmployeeForOrg(empId, orgId);
  const normalizedEmbedding = Array.isArray(embedding) ? normalizeEmbedding(embedding) : null;
  const jobId = `face_enrollment_${orgId}_${empId}`;

  if (normalizedEmbedding && !isValidEmbedding(normalizedEmbedding)) {
    throw createError('FACE_002', 'Invalid face embedding payload', 422);
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

  await faceEnrollment.add(
    'face_enrollment',
    {
      orgId,
      empId,
      embedding: normalizedEmbedding,
      selfieBase64,
    },
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

  return {
    employeeId: employee.id,
    status: 'pending',
  };
}

async function processEnrollmentJob(jobData) {
  const { orgId, empId, embedding, selfieBase64 } = jobData;
  const employee = await getEmployeeForOrg(empId, orgId);
  const normalizedEmbedding = Array.isArray(embedding) ? normalizeEmbedding(embedding) : null;
  const selfieBuffer = decodeSelfie(selfieBase64);
  const statusKey = getEnrollmentStatusKey(orgId, empId);

  if ((normalizedEmbedding && !isValidEmbedding(normalizedEmbedding)) || !selfieBuffer) {
    throw createError('FACE_005', 'Enrollment job payload is invalid', 422);
  }

  const faceId = await enrollWithRekognition(empId, selfieBuffer);

  await employee.update({
    face_embedding_local: normalizedEmbedding,
    face_embedding_id: faceId,
    face_enrolled_at: new Date(),
  });

  await safeRedisSet(
    statusKey,
    JSON.stringify({
      status: 'enrolled',
      updatedAt: new Date().toISOString(),
    }),
    24 * 60 * 60
  );

  return {
    employeeId: empId,
    enrolled: true,
    providerFaceId: faceId,
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
  const hasLocalEmbedding =
    Array.isArray(employee.face_embedding_local) && employee.face_embedding_local.length === 128;
  const isEnrolled = Boolean(employee.face_embedding_id || hasLocalEmbedding);

  return {
    employeeId: employee.id,
    enrolled: isEnrolled,
    status: isEnrolled ? 'enrolled' : parsedStatus ? parsedStatus.status : 'not_enrolled',
    faceId: employee.face_embedding_id || null,
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
