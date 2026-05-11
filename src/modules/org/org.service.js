const { Branch, Department, Employee, Organisation, Shift } = require('../../models');
const { Op, literal } = require('sequelize');
const { deleteOrgLogo, uploadOrgLogoToCloudinary } = require('./org.storageService');
const { notifyOrgRoles } = require('../notification/notification.service');

const DEFAULT_ATTENDANCE_SETTINGS = {
  allowRemoteCheckIn: false,
  requireGeofence: true,
  requireFaceRecognition: true,
  toleranceMinutes: 15,
  kioskModeEnabled: false,
  kioskRequiresOfficeGeofence: true,
  faceMatchThreshold: 0.84,
  requireLiveness: true,
  allowEmployeeDeviceExceptionFlow: true,
  requireWifiVerification: false,
  checkoutReminderEnabled: true,
  autoAbsentEnabled: true,
};

const DEFAULT_SECURITY_SETTINGS = {
  failedLoginAlertEnabled: true,
  billingOverrideAlertEnabled: true,
  orgConfigChangeAlertEnabled: true,
};

const DEFAULT_NOTIFICATION_SETTINGS = {
  leaveRequests: true,
  regularisation: true,
  billing: true,
  deviceExceptions: true,
  attendanceAnomalies: true,
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

function normalizeNumber(value, fallback, min, max, precision = 2) {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const clamped = Math.max(min, Math.min(max, parsed));
  return Number(clamped.toFixed(precision));
}

function normalizeOrgSettings(settings = {}) {
  const currentSettings = settings && typeof settings === 'object' ? settings : {};
  const profile = currentSettings.profile && typeof currentSettings.profile === 'object'
    ? currentSettings.profile
    : {};
  const attendance = currentSettings.attendance && typeof currentSettings.attendance === 'object'
    ? currentSettings.attendance
    : {};
  const security = currentSettings.security && typeof currentSettings.security === 'object'
    ? currentSettings.security
    : {};
  const notifications = currentSettings.notifications && typeof currentSettings.notifications === 'object'
    ? currentSettings.notifications
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
      kioskModeEnabled: normalizeBoolean(attendance.kioskModeEnabled, DEFAULT_ATTENDANCE_SETTINGS.kioskModeEnabled),
      kioskRequiresOfficeGeofence: normalizeBoolean(
        attendance.kioskRequiresOfficeGeofence,
        DEFAULT_ATTENDANCE_SETTINGS.kioskRequiresOfficeGeofence
      ),
      faceMatchThreshold: normalizeNumber(
        attendance.faceMatchThreshold,
        DEFAULT_ATTENDANCE_SETTINGS.faceMatchThreshold,
        0.5,
        0.99,
        2
      ),
      requireLiveness: normalizeBoolean(attendance.requireLiveness, DEFAULT_ATTENDANCE_SETTINGS.requireLiveness),
      allowEmployeeDeviceExceptionFlow: normalizeBoolean(
        attendance.allowEmployeeDeviceExceptionFlow,
        DEFAULT_ATTENDANCE_SETTINGS.allowEmployeeDeviceExceptionFlow
      ),
      requireWifiVerification: normalizeBoolean(
        attendance.requireWifiVerification,
        DEFAULT_ATTENDANCE_SETTINGS.requireWifiVerification
      ),
      checkoutReminderEnabled: normalizeBoolean(
        attendance.checkoutReminderEnabled,
        DEFAULT_ATTENDANCE_SETTINGS.checkoutReminderEnabled
      ),
      autoAbsentEnabled: normalizeBoolean(attendance.autoAbsentEnabled, DEFAULT_ATTENDANCE_SETTINGS.autoAbsentEnabled),
    },
    security: {
      failedLoginAlertEnabled: normalizeBoolean(
        security.failedLoginAlertEnabled,
        DEFAULT_SECURITY_SETTINGS.failedLoginAlertEnabled
      ),
      billingOverrideAlertEnabled: normalizeBoolean(
        security.billingOverrideAlertEnabled,
        DEFAULT_SECURITY_SETTINGS.billingOverrideAlertEnabled
      ),
      orgConfigChangeAlertEnabled: normalizeBoolean(
        security.orgConfigChangeAlertEnabled,
        DEFAULT_SECURITY_SETTINGS.orgConfigChangeAlertEnabled
      ),
    },
    notifications: {
      leaveRequests: normalizeBoolean(notifications.leaveRequests, DEFAULT_NOTIFICATION_SETTINGS.leaveRequests),
      regularisation: normalizeBoolean(notifications.regularisation, DEFAULT_NOTIFICATION_SETTINGS.regularisation),
      billing: normalizeBoolean(notifications.billing, DEFAULT_NOTIFICATION_SETTINGS.billing),
      deviceExceptions: normalizeBoolean(notifications.deviceExceptions, DEFAULT_NOTIFICATION_SETTINGS.deviceExceptions),
      attendanceAnomalies: normalizeBoolean(
        notifications.attendanceAnomalies,
        DEFAULT_NOTIFICATION_SETTINGS.attendanceAnomalies
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

function buildSecuritySettings(organisation) {
  return normalizeOrgSettings(organisation.settings).security;
}

function buildNotificationSettings(organisation) {
  return normalizeOrgSettings(organisation.settings).notifications;
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

async function getSettingsHealth(orgId) {
  const organisation = await getOrganisationOrThrow(orgId);
  const settings = normalizeOrgSettings(organisation.settings);
  const [branchCount, branchesMissingGeofence, employeesMissingFace, employeeCount] = await Promise.all([
    Branch.count({ where: { org_id: orgId } }),
    Branch.count({
      where: {
        org_id: orgId,
        is_remote: false,
        [Op.or]: [
          { geo_fence_polygons: null },
          literal("jsonb_array_length(COALESCE(geo_fence_polygons, '[]'::jsonb)) < 3"),
        ],
      },
    }),
    Employee.count({
      where: {
        org_id: orgId,
        is_active: true,
        is_face_enrolled: false,
      },
    }),
    Employee.count({ where: { org_id: orgId, is_active: true } }),
  ]);

  const checks = [
    {
      key: 'branch_geofence',
      status: settings.attendance.requireGeofence && branchesMissingGeofence > 0 ? 'warning' : 'ok',
      title: 'Branch geofence coverage',
      message:
        settings.attendance.requireGeofence && branchesMissingGeofence > 0
          ? `${branchesMissingGeofence} office branch${branchesMissingGeofence === 1 ? '' : 'es'} need valid geofence polygons.`
          : 'Geofence policy is aligned with branch setup.',
      count: branchesMissingGeofence,
    },
    {
      key: 'face_enrollment',
      status: settings.attendance.requireFaceRecognition && employeesMissingFace > 0 ? 'warning' : 'ok',
      title: 'Face enrollment coverage',
      message:
        settings.attendance.requireFaceRecognition && employeesMissingFace > 0
          ? `${employeesMissingFace} active employee${employeesMissingFace === 1 ? '' : 's'} still need face enrollment.`
          : 'Face recognition policy is aligned with employee enrollment.',
      count: employeesMissingFace,
    },
    {
      key: 'remote_checkin',
      status: settings.attendance.allowRemoteCheckIn ? 'warning' : 'ok',
      title: 'Remote check-in',
      message: settings.attendance.allowRemoteCheckIn
        ? 'Remote check-in is enabled. Use this only for remote workforce policy.'
        : 'Remote check-in is disabled.',
    },
    {
      key: 'logo',
      status: normalizeOrgSettings(organisation.settings).profile.logo ? 'ok' : 'warning',
      title: 'Branding',
      message: normalizeOrgSettings(organisation.settings).profile.logo
        ? 'Organisation logo is uploaded.'
        : 'No organisation logo uploaded.',
    },
    {
      key: 'late_tolerance',
      status: settings.attendance.toleranceMinutes > 30 ? 'warning' : 'ok',
      title: 'Late tolerance',
      message:
        settings.attendance.toleranceMinutes > 30
          ? 'Late tolerance is high. Review if this is intentional.'
          : 'Late tolerance is within recommended range.',
      value: settings.attendance.toleranceMinutes,
    },
  ];

  return {
    summary: {
      branchCount,
      employeeCount,
      issues: checks.filter((check) => check.status !== 'ok').length,
      ok: checks.filter((check) => check.status === 'ok').length,
    },
    checks,
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
    securitySettings: buildSecuritySettings(organisation),
    notificationSettings: buildNotificationSettings(organisation),
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
    securitySettings: buildSecuritySettings(organisation),
    notificationSettings: buildNotificationSettings(organisation),
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
    kioskModeEnabled: normalizeBoolean(payload.kioskModeEnabled, currentSettings.attendance.kioskModeEnabled),
    kioskRequiresOfficeGeofence: normalizeBoolean(
      payload.kioskRequiresOfficeGeofence,
      currentSettings.attendance.kioskRequiresOfficeGeofence
    ),
    faceMatchThreshold: normalizeNumber(
      payload.faceMatchThreshold,
      currentSettings.attendance.faceMatchThreshold,
      0.5,
      0.99,
      2
    ),
    requireLiveness: normalizeBoolean(payload.requireLiveness, currentSettings.attendance.requireLiveness),
    allowEmployeeDeviceExceptionFlow: normalizeBoolean(
      payload.allowEmployeeDeviceExceptionFlow,
      currentSettings.attendance.allowEmployeeDeviceExceptionFlow
    ),
    requireWifiVerification: normalizeBoolean(
      payload.requireWifiVerification,
      currentSettings.attendance.requireWifiVerification
    ),
    checkoutReminderEnabled: normalizeBoolean(
      payload.checkoutReminderEnabled,
      currentSettings.attendance.checkoutReminderEnabled
    ),
    autoAbsentEnabled: normalizeBoolean(payload.autoAbsentEnabled, currentSettings.attendance.autoAbsentEnabled),
  };

  const nextSecuritySettings = {
    ...currentSettings.security,
    failedLoginAlertEnabled: normalizeBoolean(
      payload.failedLoginAlertEnabled,
      currentSettings.security.failedLoginAlertEnabled
    ),
    billingOverrideAlertEnabled: normalizeBoolean(
      payload.billingOverrideAlertEnabled,
      currentSettings.security.billingOverrideAlertEnabled
    ),
    orgConfigChangeAlertEnabled: normalizeBoolean(
      payload.orgConfigChangeAlertEnabled,
      currentSettings.security.orgConfigChangeAlertEnabled
    ),
  };

  const nextNotificationSettings = {
    ...currentSettings.notifications,
    leaveRequests: normalizeBoolean(payload.leaveRequests, currentSettings.notifications.leaveRequests),
    regularisation: normalizeBoolean(payload.regularisation, currentSettings.notifications.regularisation),
    billing: normalizeBoolean(payload.billing, currentSettings.notifications.billing),
    deviceExceptions: normalizeBoolean(payload.deviceExceptions, currentSettings.notifications.deviceExceptions),
    attendanceAnomalies: normalizeBoolean(
      payload.attendanceAnomalies,
      currentSettings.notifications.attendanceAnomalies
    ),
  };

  const nextSettings = {
    ...currentSettings,
    attendance: nextAttendanceSettings,
    security: nextSecuritySettings,
    notifications: nextNotificationSettings,
  };

  await organisation.update({
    settings: nextSettings,
  });

  const updatedOrg = await getOrganisationOrThrow(orgId);
  const highRiskChanged =
    currentSettings.attendance.requireGeofence !== nextAttendanceSettings.requireGeofence ||
    currentSettings.attendance.requireFaceRecognition !== nextAttendanceSettings.requireFaceRecognition ||
    currentSettings.attendance.allowRemoteCheckIn !== nextAttendanceSettings.allowRemoteCheckIn ||
    currentSettings.attendance.kioskModeEnabled !== nextAttendanceSettings.kioskModeEnabled ||
    currentSettings.security.orgConfigChangeAlertEnabled !== nextSecuritySettings.orgConfigChangeAlertEnabled;

  if (highRiskChanged) {
    await notifyOrgRoles(orgId, ['admin'], {
      type: 'org_config_changed',
      title: 'Organisation security settings changed',
      body: 'High-impact attendance or security configuration was updated.',
      actionUrl: '/settings?tab=attendance',
      data: {
        priority: 'high',
        status: 'completed',
      },
    });
  }

  return {
    oldValue: previousValue,
    newValue: {
      org: buildOrgProfile(updatedOrg, actorProfile),
      attendanceSettings: buildAttendanceSettings(updatedOrg),
      securitySettings: buildSecuritySettings(updatedOrg),
      notificationSettings: buildNotificationSettings(updatedOrg),
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

async function removeOrgLogo(orgId) {
  const organisation = await getOrganisationOrThrow(orgId);
  const currentSettings = normalizeOrgSettings(organisation.settings);
  const previousValue = buildOrgProfile(organisation);

  if (currentSettings.profile.logoPublicId) {
    await deleteOrgLogo(currentSettings.profile.logoPublicId);
  }

  const nextSettings = {
    ...currentSettings,
    profile: {
      ...currentSettings.profile,
      logo: null,
      logoPublicId: null,
    },
  };

  await organisation.update({ settings: nextSettings });

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
  getSettingsHealth,
  uploadOrgLogo,
  removeOrgLogo,
  updateOrgProfile,
  updateOrgSettings,
};
