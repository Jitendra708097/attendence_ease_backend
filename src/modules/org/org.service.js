const { Branch, Department, Employee, Organisation, Shift } = require('../../models');
const { deleteOrgLogo, uploadOrgLogoToCloudinary } = require('./org.storageService');

const DEFAULT_ATTENDANCE_SETTINGS = {
  allowRemoteCheckIn: false,
  requireGeofence: true,
  requireFaceRecognition: true,
  toleranceMinutes: 15,
};

function createError(code, message, statusCode, details = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function cleanOptionalString(value, fallback = null) {
  if (value === undefined) {
    return fallback;
  }

  if (value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeLogoValue(value, fallback = null) {
  if (value === undefined) {
    return fallback;
  }

  if (value === null) {
    return null;
  }

  return typeof value === 'string' ? cleanOptionalString(value, fallback) : fallback;
}

function normalizeBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  return Boolean(value);
}

function normalizeToleranceMinutes(value, fallback = DEFAULT_ATTENDANCE_SETTINGS.toleranceMinutes) {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, Math.min(180, Math.round(parsed)));
}

function normalizeOrgSettings(settings = {}) {
  const currentSettings = settings && typeof settings === 'object' ? settings : {};
  const profile = currentSettings.profile && typeof currentSettings.profile === 'object'
    ? currentSettings.profile
    : {};
  const attendance = currentSettings.attendance && typeof currentSettings.attendance === 'object'
    ? currentSettings.attendance
    : {};

  return {
    ...currentSettings,
    profile: {
      email: cleanOptionalString(profile.email),
      phone: cleanOptionalString(profile.phone),
      address: cleanOptionalString(profile.address),
      logo: normalizeLogoValue(profile.logo),
      logoPublicId: cleanOptionalString(profile.logoPublicId),
    },
    attendance: {
      allowRemoteCheckIn: normalizeBoolean(
        attendance.allowRemoteCheckIn,
        DEFAULT_ATTENDANCE_SETTINGS.allowRemoteCheckIn
      ),
      requireGeofence: normalizeBoolean(
        attendance.requireGeofence,
        DEFAULT_ATTENDANCE_SETTINGS.requireGeofence
      ),
      requireFaceRecognition: normalizeBoolean(
        attendance.requireFaceRecognition,
        DEFAULT_ATTENDANCE_SETTINGS.requireFaceRecognition
      ),
      toleranceMinutes: normalizeToleranceMinutes(
        attendance.toleranceMinutes,
        DEFAULT_ATTENDANCE_SETTINGS.toleranceMinutes
      ),
    },
  };
}

async function getOrganisationOrThrow(orgId) {
  const organisation = await Organisation.findOne({
    where: { id: orgId },
  });

  if (!organisation) {
    throw createError('HTTP_404', 'Organisation not found', 404);
  }

  return organisation;
}

async function getActorProfile(orgId, employeeId) {
  if (!employeeId) {
    return null;
  }

  return Employee.findOne({
    where: {
      id: employeeId,
      org_id: orgId,
    },
    attributes: ['id', 'name', 'email', 'phone'],
  });
}

function buildOrgProfile(organisation, actorProfile = null) {
  const settings = normalizeOrgSettings(organisation.settings);

  return {
    id: organisation.id,
    name: organisation.name,
    slug: organisation.slug,
    email: settings.profile.email || actorProfile?.email || '',
    phone: settings.profile.phone || actorProfile?.phone || '',
    address: settings.profile.address || '',
    timezone: organisation.timezone || 'Asia/Kolkata',
    logo: settings.profile.logo || null,
    plan: organisation.plan,
    isActive: Boolean(organisation.is_active),
  };
}

function buildAttendanceSettings(organisation) {
  return normalizeOrgSettings(organisation.settings).attendance;
}

async function getOrgStats(orgId) {
  const organisation = await getOrganisationOrThrow(orgId);

  const [employeeCount, activeEmployeeCount, branchCount, departmentCount, shiftCount] = await Promise.all([
    Employee.count({ where: { org_id: orgId } }),
    Employee.count({ where: { org_id: orgId, is_active: true } }),
    Branch.count({ where: { org_id: orgId } }),
    Department.count({ where: { org_id: orgId } }),
    Shift.count({ where: { org_id: orgId } }),
  ]);

  return {
    orgId: organisation.id,
    name: organisation.name,
    plan: organisation.plan,
    timezone: organisation.timezone || 'Asia/Kolkata',
    isActive: Boolean(organisation.is_active),
    employeeCount,
    activeEmployeeCount,
    inactiveEmployeeCount: Math.max(0, employeeCount - activeEmployeeCount),
    branchCount,
    departmentCount,
    shiftCount,
  };
}

async function getOrgInfo(orgId, employeeId) {
  const [organisation, actorProfile] = await Promise.all([
    getOrganisationOrThrow(orgId),
    getActorProfile(orgId, employeeId),
  ]);

  return {
    ...buildOrgProfile(organisation, actorProfile),
    createdAt: organisation.created_at,
    updatedAt: organisation.updated_at,
    trialEndsAt: organisation.trial_ends_at,
    attendanceSettings: buildAttendanceSettings(organisation),
  };
}

async function getOrgSettings(orgId, employeeId) {
  const [organisation, actorProfile] = await Promise.all([
    getOrganisationOrThrow(orgId),
    getActorProfile(orgId, employeeId),
  ]);

  return {
    org: buildOrgProfile(organisation, actorProfile),
    attendanceSettings: buildAttendanceSettings(organisation),
  };
}

async function updateOrgProfile(orgId, payload = {}, employeeId = null) {
  const organisation = await getOrganisationOrThrow(orgId);
  const actorProfile = await getActorProfile(orgId, employeeId);
  const previousValue = buildOrgProfile(organisation, actorProfile);
  const currentSettings = normalizeOrgSettings(organisation.settings);

  const nextProfile = {
    ...currentSettings.profile,
    email: cleanOptionalString(payload.email, currentSettings.profile.email),
    phone: cleanOptionalString(payload.phone, currentSettings.profile.phone),
    address: cleanOptionalString(payload.address, currentSettings.profile.address),
    logo: normalizeLogoValue(payload.logo, currentSettings.profile.logo),
  };

  const nextTimezone = cleanOptionalString(payload.timezone, organisation.timezone) || organisation.timezone || 'Asia/Kolkata';

  const nextSettings = {
    ...currentSettings,
    timezone: nextTimezone,
    profile: nextProfile,
  };

  await organisation.update({
    name: String(payload.name).trim(),
    timezone: nextTimezone,
    settings: nextSettings,
  });

  const updatedOrg = await getOrganisationOrThrow(orgId);
  const nextValue = buildOrgProfile(updatedOrg, actorProfile);

  return {
    oldValue: previousValue,
    newValue: nextValue,
  };
}

async function updateOrgSettings(orgId, payload = {}, employeeId = null) {
  const organisation = await getOrganisationOrThrow(orgId);
  const actorProfile = await getActorProfile(orgId, employeeId);
  const previousValue = await getOrgSettings(orgId, employeeId);
  const currentSettings = normalizeOrgSettings(organisation.settings);

  const nextAttendanceSettings = {
    ...currentSettings.attendance,
    allowRemoteCheckIn: normalizeBoolean(
      payload.allowRemoteCheckIn,
      currentSettings.attendance.allowRemoteCheckIn
    ),
    requireGeofence: normalizeBoolean(
      payload.requireGeofence,
      currentSettings.attendance.requireGeofence
    ),
    requireFaceRecognition: normalizeBoolean(
      payload.requireFaceRecognition,
      currentSettings.attendance.requireFaceRecognition
    ),
    toleranceMinutes: normalizeToleranceMinutes(
      payload.toleranceMinutes,
      currentSettings.attendance.toleranceMinutes
    ),
  };

  const nextSettings = {
    ...currentSettings,
    attendance: nextAttendanceSettings,
  };

  await organisation.update({
    settings: nextSettings,
  });

  const updatedOrg = await getOrganisationOrThrow(orgId);

  return {
    oldValue: previousValue,
    newValue: {
      org: buildOrgProfile(updatedOrg, actorProfile),
      attendanceSettings: buildAttendanceSettings(updatedOrg),
    },
  };
}

async function uploadOrgLogo(orgId, file) {
  const organisation = await getOrganisationOrThrow(orgId);
  const currentSettings = normalizeOrgSettings(organisation.settings);
  const previousValue = buildOrgProfile(organisation);
  const uploaded = await uploadOrgLogoToCloudinary(file.buffer, orgId);

  const nextSettings = {
    ...currentSettings,
    profile: {
      ...currentSettings.profile,
      logo: uploaded.secureUrl,
      logoPublicId: uploaded.publicId,
    },
  };

  await organisation.update({
    settings: nextSettings,
  });

  if (currentSettings.profile.logoPublicId && currentSettings.profile.logoPublicId !== uploaded.publicId) {
    await deleteOrgLogo(currentSettings.profile.logoPublicId);
  }

  const updatedOrg = await getOrganisationOrThrow(orgId);

  return {
    oldValue: previousValue,
    newValue: buildOrgProfile(updatedOrg),
  };
}

module.exports = {
  getOrgStats,
  getOrgInfo,
  getOrgSettings,
  uploadOrgLogo,
  updateOrgProfile,
  updateOrgSettings,
};
