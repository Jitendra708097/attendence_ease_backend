const crypto = require('crypto');
const { Op } = require('sequelize');
const { Branch, Department, Employee, RefreshToken, Organisation, Shift } = require('../../models');
const { compareValue, hashValue, signAccessToken, signRefreshToken, verifyRefreshToken } = require('../../utils/auth');
const { isEmailConfigured, sendPasswordResetOtpEmail } = require('../notification/email.service');

const PASSWORD_RESET_OTP_EXPIRY_MINUTES = 10;
const PASSWORD_RESET_RESEND_COOLDOWN_MS = 60 * 1000;

function buildEmployeeProfile(employee) {
  const requiresPasswordChange = typeof employee.password_changed === 'boolean' ? !employee.password_changed : false;
  const faceEnrolled = Boolean(employee.face_embedding_id || employee.face_embedding_local);

  return {
    id: employee.id,
    name: employee.name,
    email: employee.email,
    phone: employee.phone || null,
    role: employee.role,
    orgId: employee.org_id,
    employeeCode: employee.emp_code || null,
    department: employee.department?.name || null,
    shiftName: employee.shift?.name || null,
    branchName: employee.branch?.name || null,
    joinedAt: employee.created_at || null,
    requiresPasswordChange,
    isFirstLogin: requiresPasswordChange,
    faceEnrolled,
  };
}

function getRefreshExpiryDate() {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
}

async function issueTokenPair(employee, meta = {}) {
  const payload = {
    id: employee.id,
    orgId: employee.org_id,
    role: employee.role,
  };

  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);
  const tokenHash = await hashValue(refreshToken);

  await RefreshToken.create({
    emp_id: employee.id,
    token_hash: tokenHash,
    device_id: meta.deviceId || null,
    status: 'active',
    expires_at: getRefreshExpiryDate(),
  });

  return {
    accessToken,
    refreshToken,
  };
}

async function login({ email, password, deviceId }) {
  const employee = await Employee.findOne({
    attributes: [
      'id',
      'org_id',
      'name',
      'email',
      'phone',
      'role',
      'emp_code',
      'password_hash',
      'password_changed',
      'face_embedding_id',
      'face_embedding_local',
      'created_at',
      'is_active',
      'deleted_at',
    ],
    where: {
      email: String(email).trim().toLowerCase(),
      is_active: true,
      deleted_at: null,
    },
    include: [
      {
        model: Organisation,
        as: 'organisation',
        attributes: ['id', 'name', 'slug'],
      },
      {
        model: Branch,
        as: 'branch',
        attributes: ['id', 'name'],
        required: false,
      },
      {
        model: Department,
        as: 'department',
        attributes: ['id', 'name'],
        required: false,
      },
      {
        model: Shift,
        as: 'shift',
        attributes: ['id', 'name'],
        required: false,
      },
    ],
  });

  if (!employee || !employee.password_hash) {
    const error = new Error('Invalid credentials');
    error.code = 'AUTH_001';
    error.statusCode = 401;
    throw error;
  }
  const isPasswordValid = await compareValue(password, employee.password_hash);
  if (!isPasswordValid) {
    const error = new Error('Invalid credentials');
    error.code = 'AUTH_001';
    error.statusCode = 401;
    throw error;
  }

  const tokens = await issueTokenPair(employee, { deviceId });

  return {
    ...tokens,
    employee: buildEmployeeProfile(employee),
  };
}

async function refresh(refreshToken) {
  const payload = verifyRefreshToken(refreshToken);

  // ✅ FIX: Require orgId for multi-tenant isolation
  if (!payload.id || !payload.orgId) {
    const error = new Error('Invalid refresh token');
    error.code = 'AUTH_002';
    error.statusCode = 401;
    throw error;
  }

  const employee = await Employee.findOne({
    where: {
      id: payload.id,
      org_id: payload.orgId, // ✅ Always enforce org_id
    },
  });

  if (!employee) {
    const error = new Error('Invalid refresh token');
    error.code = 'AUTH_002';
    error.statusCode = 401;
    throw error;
  }

  const tokens = await RefreshToken.findAll({
    where: {
      emp_id: employee.id,
      status: {
        [Op.in]: ['active', 'used'],
      },
    },
    order: [['created_at', 'DESC']],
  });

  let matchedToken = null;

  for (const tokenRecord of tokens) {
    const isMatch = await compareValue(refreshToken, tokenRecord.token_hash);

    if (isMatch) {
      matchedToken = tokenRecord;
      break;
    }
  }

  if (!matchedToken) {
    const error = new Error('Invalid refresh token');
    error.code = 'AUTH_002';
    error.statusCode = 401;
    throw error;
  }

  if (matchedToken.status === 'used') {
    await RefreshToken.update(
      { status: 'revoked' },
      {
        where: {
          emp_id: employee.id,
        },
      }
    );

    const error = new Error('Refresh token reuse detected');
    error.code = 'AUTH_007';
    error.statusCode = 401;
    throw error;
  }

  await matchedToken.update({ status: 'used' });

  return issueTokenPair(employee, {
    deviceId: matchedToken.device_id,
  });
}

async function logout({ refreshToken, employeeId }) {
  const tokens = await RefreshToken.findAll({
    where: {
      emp_id: employeeId,
      status: 'active',
    },
  });

  for (const tokenRecord of tokens) {
    const isMatch = refreshToken ? await compareValue(refreshToken, tokenRecord.token_hash) : false;

    if (!refreshToken || isMatch) {
      await tokenRecord.update({ status: 'revoked' });
    }
  }

  return true;
}

async function changePassword({ employeeId, orgId, currentPassword, newPassword }) {
  const employee = await Employee.findOne({
    where: {
      id: employeeId,
      org_id: orgId,
    },
  });

  if (!employee) {
    const error = new Error('Employee not found');
    error.code = 'HTTP_404';
    error.statusCode = 404;
    throw error;
  }

  const isCurrentPasswordValid = await compareValue(currentPassword, employee.password_hash);

  if (!isCurrentPasswordValid) {
    const error = new Error('Current password is incorrect');
    error.code = 'AUTH_004';
    error.statusCode = 400;
    throw error;
  }

  const nextPasswordHash = await hashValue(newPassword);

  const updatePayload = {
    password_hash: nextPasswordHash,
    password_changed: true,
    temp_password: null,
  };

  await employee.update(updatePayload);

  return buildEmployeeProfile(employee);
}

function getPasswordResetExpiryDate() {
  return new Date(Date.now() + PASSWORD_RESET_OTP_EXPIRY_MINUTES * 60 * 1000);
}

function generateOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

async function forgotPassword({ email }) {
  if (!isEmailConfigured()) {
    const error = new Error('Password reset email is not configured');
    error.code = 'AUTH_015';
    error.statusCode = 503;
    throw error;
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const employee = await Employee.findOne({
    where: {
      email: normalizedEmail,
      is_active: true,
      deleted_at: null,
    },
    include: [
      {
        model: Organisation,
        as: 'organisation',
        attributes: ['id', 'name'],
        required: false,
      },
    ],
  });

  const genericResponse = {
    emailSent: true,
    expiresInMinutes: PASSWORD_RESET_OTP_EXPIRY_MINUTES,
  };

  if (!employee) {
    return genericResponse;
  }

  const now = Date.now();
  const requestedAt = employee.password_reset_requested_at ? new Date(employee.password_reset_requested_at).getTime() : 0;

  if (requestedAt && now - requestedAt < PASSWORD_RESET_RESEND_COOLDOWN_MS) {
    const error = new Error('Please wait before requesting another OTP');
    error.code = 'AUTH_018';
    error.statusCode = 429;
    throw error;
  }

  const otp = generateOtp();
  const passwordResetOtpHash = await hashValue(otp);
  const passwordResetExpiresAt = getPasswordResetExpiryDate();

  await employee.update({
    password_reset_otp_hash: passwordResetOtpHash,
    password_reset_expires_at: passwordResetExpiresAt,
    password_reset_requested_at: new Date(now),
  });

  try {
    await sendPasswordResetOtpEmail({
      to: employee.email,
      organisationName: employee.organisation?.name || 'AttendEase',
      employeeName: employee.name || 'Employee',
      otp,
      expiresInMinutes: PASSWORD_RESET_OTP_EXPIRY_MINUTES,
    });
  } catch (error) {
    await employee.update({
      password_reset_otp_hash: null,
      password_reset_expires_at: null,
      password_reset_requested_at: null,
    });

    const sendError = new Error('Failed to send password reset OTP');
    sendError.code = 'AUTH_015';
    sendError.statusCode = 503;
    throw sendError;
  }

  return genericResponse;
}

async function resetPassword({ email, otp, newPassword }) {
  const normalizedEmail = String(email).trim().toLowerCase();
  const employee = await Employee.findOne({
    where: {
      email: normalizedEmail,
      is_active: true,
      deleted_at: null,
    },
  });

  if (!employee || !employee.password_reset_otp_hash) {
    const error = new Error('Invalid or expired OTP');
    error.code = 'AUTH_014';
    error.statusCode = 400;
    throw error;
  }

  if (!employee.password_reset_expires_at || new Date(employee.password_reset_expires_at) < new Date()) {
    await employee.update({
      password_reset_otp_hash: null,
      password_reset_expires_at: null,
      password_reset_requested_at: null,
    });

    const error = new Error('OTP has expired. Please request a new one');
    error.code = 'AUTH_014';
    error.statusCode = 400;
    throw error;
  }

  const isOtpValid = await compareValue(String(otp).trim(), employee.password_reset_otp_hash);

  if (!isOtpValid) {
    const error = new Error('Invalid or expired OTP');
    error.code = 'AUTH_014';
    error.statusCode = 400;
    throw error;
  }

  const nextPasswordHash = await hashValue(newPassword);

  await employee.update({
    password_hash: nextPasswordHash,
    password_changed: true,
    temp_password: null,
    password_reset_otp_hash: null,
    password_reset_expires_at: null,
    password_reset_requested_at: null,
  });

  await RefreshToken.update(
    { status: 'revoked' },
    {
      where: {
        emp_id: employee.id,
        status: {
          [Op.in]: ['active', 'used'],
        },
      },
    }
  );

  return {
    email: employee.email,
    passwordReset: true,
  };
}

module.exports = {
  login,
  refresh,
  logout,
  changePassword,
  forgotPassword,
  resetPassword,
};
