const { Op } = require('sequelize');
const { Employee, RefreshToken, Organisation } = require('../../models');
const { compareValue, hashValue, signAccessToken, signRefreshToken, verifyRefreshToken } = require('../../utils/auth');

function buildEmployeeProfile(employee) {
  const requiresPasswordChange = typeof employee.password_changed === 'boolean' ? !employee.password_changed : false;
  const faceEnrolled = Boolean(employee.face_embedding_id || employee.face_embedding_local);

  return {
    id: employee.id,
    name: employee.name,
    email: employee.email,
    role: employee.role,
    orgId: employee.org_id,
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

  const employee = await Employee.findOne({
    where: {
      id: payload.id,
      ...(payload.orgId ? { org_id: payload.orgId } : {}),
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
  };

  await employee.update(updatePayload);

  return buildEmployeeProfile(employee);
}

module.exports = {
  login,
  refresh,
  logout,
  changePassword,
};
