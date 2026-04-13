const { ok, fail } = require('../../utils/response');
const { log } = require('../../utils/auditLog');
const faceService = require('./face.service');

function validateEmbedding(embedding) {
  if (embedding == null) {
    return [];
  }

  if (!Array.isArray(embedding) || embedding.length !== 128) {
    return [
      {
        field: 'faceEmbedding',
        message: 'faceEmbedding must be a 128 length numeric array',
      },
    ];
  }

  return [];
}

async function enroll(req, res) {
  const details = validateEmbedding(req.body.faceEmbedding);

  if (!req.body.selfieBase64) {
    details.push({
      field: 'selfieBase64',
      message: 'selfieBase64 is required',
    });
  }

  if (details.length > 0) {
    return fail(res, 'FACE_002', 'Invalid face enrollment payload', details, 422);
  }

  try {
    const data = await faceService.enqueueEnrollment({
      orgId: req.org_id,
      empId: req.employee.id,
      embedding: req.body.faceEmbedding || null,
      selfieBase64: req.body.selfieBase64,
    });

    await log(
      req.employee,
      'face.enroll.requested',
      { type: 'employee', id: req.employee.id },
      null,
      { status: 'pending' },
      req
    );

    return ok(res, data, 'Face enrollment queued', 202);
  } catch (error) {
    return fail(res, error.code || 'FACE_004', error.message, error.details || [], error.statusCode || 400);
  }
}

async function verify(req, res) {
  const details = validateEmbedding(req.body.faceEmbedding);

  if (details.length > 0) {
    return fail(res, 'FACE_002', 'Invalid face verification payload', details, 422);
  }

  try {
    // ✅ FIX: Use logged-in employee, not from request body
    const data = await faceService.verifyFace(
      req.employee.id,  // Use authenticated employee
      req.org_id,       // Use org from middleware
      req.body.faceEmbedding || null,
      faceService.decodeSelfie(req.body.selfieBase64)
    );

    return ok(res, data, 'Face verified');
  } catch (error) {
    // ✅ FIX: Return generic error for 404 to prevent info leakage
    if (error.statusCode === 404 || error.code === 'FACE_001') {
      return fail(res, 'FACE_003', 'Face verification failed', [], 401);
    }
    return fail(res, error.code || 'FACE_003', error.message, error.details || [], error.statusCode || 400);
  }
}

async function status(req, res) {
  try {
    const data = await faceService.getEnrollmentStatus({
      requester: req.employee,
      orgId: req.org_id,
      empId: req.params.empId,
    });

    return ok(res, data, 'Face status fetched');
  } catch (error) {
    return fail(res, error.code || 'FACE_006', error.message, error.details || [], error.statusCode || 400);
  }
}

async function remove(req, res) {
  try {
    const data = await faceService.resetEnrollment({
      orgId: req.org_id,
      empId: req.params.empId,
    });

    await log(
      req.employee,
      'face.enrollment.reset',
      { type: 'employee', id: req.params.empId },
      null,
      { reset: true },
      req
    );

    return ok(res, data, 'Face enrollment reset');
  } catch (error) {
    return fail(res, error.code || 'FACE_007', error.message, error.details || [], error.statusCode || 400);
  }
}

module.exports = {
  enroll,
  verify,
  status,
  remove,
};
