const { fail, ok } = require('../../utils/response');
const { log } = require('../../utils/auditLog');
const orgService = require('./org.service');

function validateProfilePayload(body = {}) {
  const details = [];

  if (!body.name || !String(body.name).trim()) {
    details.push({ field: 'name', message: 'Organisation name is required' });
  }

  if (!body.email || !String(body.email).trim()) {
    details.push({ field: 'email', message: 'Organisation email is required' });
  }

  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email).trim())) {
    details.push({ field: 'email', message: 'Organisation email must be valid' });
  }

  if (!body.timezone || !String(body.timezone).trim()) {
    details.push({ field: 'timezone', message: 'Timezone is required' });
  }

  return details;
}

function validateSettingsPayload(body = {}) {
  const details = [];

  const booleanFields = [
    'allowRemoteCheckIn',
    'requireGeofence',
    'requireFaceRecognition',
    'kioskModeEnabled',
    'kioskRequiresOfficeGeofence',
    'requireLiveness',
    'allowEmployeeDeviceExceptionFlow',
    'requireWifiVerification',
    'checkoutReminderEnabled',
    'autoAbsentEnabled',
    'failedLoginAlertEnabled',
    'billingOverrideAlertEnabled',
    'orgConfigChangeAlertEnabled',
    'leaveRequests',
    'regularisation',
    'billing',
    'deviceExceptions',
    'attendanceAnomalies',
  ];

  for (const field of booleanFields) {
    if (body[field] !== undefined && typeof body[field] !== 'boolean') {
      details.push({ field, message: `${field} must be a boolean` });
    }
  }

  if (body.toleranceMinutes !== undefined) {
    const parsed = Number(body.toleranceMinutes);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 180) {
      details.push({
        field: 'toleranceMinutes',
        message: 'Late tolerance must be a number between 0 and 180',
      });
    }
  }

  if (body.faceMatchThreshold !== undefined) {
    const parsed = Number(body.faceMatchThreshold);
    if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 0.99) {
      details.push({
        field: 'faceMatchThreshold',
        message: 'Face match threshold must be between 0.50 and 0.99',
      });
    }
  }

  return details;
}

async function stats(req, res) {
  try {
    const data = await orgService.getOrgStats(req.org_id);
    return ok(res, data, 'Organisation stats fetched');
  } catch (error) {
    return fail(res, error.code || 'ORG_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function info(req, res) {
  try {
    const data = await orgService.getOrgInfo(req.org_id, req.employee?.id);
    return ok(res, data, 'Organisation info fetched');
  } catch (error) {
    return fail(res, error.code || 'ORG_002', error.message, error.details || [], error.statusCode || 400);
  }
}

async function settings(req, res) {
  try {
    const data = await orgService.getOrgSettings(req.org_id, req.employee?.id);
    return ok(res, data, 'Organisation settings fetched');
  } catch (error) {
    return fail(res, error.code || 'ORG_003', error.message, error.details || [], error.statusCode || 400);
  }
}

async function settingsHealth(req, res) {
  try {
    const data = await orgService.getSettingsHealth(req.org_id);
    return ok(res, data, 'Settings health fetched');
  } catch (error) {
    return fail(res, error.code || 'ORG_013', error.message, error.details || [], error.statusCode || 400);
  }
}

async function uploadLogo(req, res) {
  if (!req.file || !req.file.buffer) {
    return fail(res, 'ORG_008', 'Organisation logo file is required', [
      { field: 'file', message: 'Please choose an image file to upload' },
    ], 422);
  }

  if (!String(req.file.mimetype || '').startsWith('image/')) {
    return fail(res, 'ORG_009', 'Organisation logo must be an image', [
      { field: 'file', message: 'Only image uploads are supported' },
    ], 422);
  }

  try {
    const data = await orgService.uploadOrgLogo(req.org_id, req.file);
    await log(req.employee, 'org.upload_logo', { type: 'organisation', id: req.org_id }, data.oldValue, data.newValue, req);
    return ok(res, data.newValue, 'Organisation logo uploaded');
  } catch (error) {
    return fail(res, error.code || 'ORG_010', error.message, error.details || [], error.statusCode || 400);
  }
}

async function removeLogo(req, res) {
  try {
    const data = await orgService.removeOrgLogo(req.org_id);
    await log(req.employee, 'org.remove_logo', { type: 'organisation', id: req.org_id }, data.oldValue, data.newValue, req);
    return ok(res, data.newValue, 'Organisation logo removed');
  } catch (error) {
    return fail(res, error.code || 'ORG_014', error.message, error.details || [], error.statusCode || 400);
  }
}

async function updateProfile(req, res) {
  const details = validateProfilePayload(req.body);

  if (details.length > 0) {
    return fail(res, 'ORG_004', 'Invalid organisation profile payload', details, 422);
  }

  try {
    const data = await orgService.updateOrgProfile(req.org_id, req.body, req.employee?.id);
    await log(req.employee, 'org.update_profile', { type: 'organisation', id: req.org_id }, data.oldValue, data.newValue, req);
    return ok(res, data.newValue, 'Organisation profile updated');
  } catch (error) {
    return fail(res, error.code || 'ORG_005', error.message, error.details || [], error.statusCode || 400);
  }
}

async function updateSettings(req, res) {
  const details = validateSettingsPayload(req.body);

  if (details.length > 0) {
    return fail(res, 'ORG_006', 'Invalid organisation settings payload', details, 422);
  }

  try {
    const data = await orgService.updateOrgSettings(req.org_id, req.body, req.employee?.id);
    await log(req.employee, 'org.update_settings', { type: 'organisation', id: req.org_id }, data.oldValue, data.newValue, req);
    return ok(res, data.newValue, 'Organisation settings updated');
  } catch (error) {
    return fail(res, error.code || 'ORG_007', error.message, error.details || [], error.statusCode || 400);
  }
}

module.exports = {
  stats,
  info,
  settings,
  settingsHealth,
  uploadLogo,
  removeLogo,
  updateProfile,
  updateSettings,
};
