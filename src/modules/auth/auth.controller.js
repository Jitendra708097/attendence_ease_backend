const { ok, fail } = require('../../utils/response');
const { log } = require('../../utils/auditLog');
const {
  clearAuthCookies,
  getAccessTokenFromRequest,
  getRefreshTokenFromRequest,
  setAuthCookies,
} = require('../../utils/authCookies');
const { blacklistToken } = require('../../utils/jwtBlacklist');
const authService = require('./auth.service');
const {
  validateLoginPayload,
  validateRefreshPayload,
  validateChangePasswordPayload,
  validateForgotPasswordPayload,
  validateResetPasswordPayload,
} = require('./auth.validators');

async function login(req, res) {
  const details = validateLoginPayload(req.body);

  if (details.length > 0) {
    return fail(res, 'AUTH_005', 'Invalid login payload', details, 422);
  }

  try {
    const data = await authService.login(req.body);
    setAuthCookies(res, data);
    return ok(res, data, 'Login successful');
  } catch (error) {
    try {
      await log(
        null,
        'auth.login_failed',
        { type: 'auth', id: String(req.body?.email || '').trim().toLowerCase() || null },
        null,
        { email: String(req.body?.email || '').trim().toLowerCase() || null, code: error.code || 'AUTH_001' },
        req
      );
    } catch (_) {
      // Audit write failure must not change the login failure response.
    }
    return fail(res, error.code || 'AUTH_001', error.message, [], error.statusCode || 401);
  }
}

async function refresh(req, res) {
  const refreshToken = getRefreshTokenFromRequest(req);
  const details = validateRefreshPayload({ refreshToken });

  if (details.length > 0) {
    return fail(res, 'AUTH_006', 'Invalid refresh payload', details, 422);
  }

  try {
    const data = await authService.refresh(refreshToken);
    setAuthCookies(res, data);
    return ok(res, data, 'Token refreshed');
  } catch (error) {
    return fail(res, error.code || 'AUTH_002', error.message, [], error.statusCode || 401);
  }
}

async function logout(req, res) {
  try {
    await authService.logout({
      refreshToken: getRefreshTokenFromRequest(req),
      employeeId: req.employee.id,
    });
    await blacklistToken(getAccessTokenFromRequest(req));
    clearAuthCookies(res);
    await log(req.employee, 'auth.logout', { type: 'auth', id: req.employee.id }, null, null, req);
    return ok(res, { success: true }, 'Logout successful');
  } catch (error) {
    return fail(res, error.code || 'AUTH_008', error.message, [], error.statusCode || 400);
  }
}

async function changePassword(req, res) {
  const details = validateChangePasswordPayload(req.body);

  if (details.length > 0) {
    return fail(res, 'AUTH_009', 'Invalid password payload', details, 422);
  }

  try {
    const data = await authService.changePassword({
      employeeId: req.employee.id,
      orgId: req.org_id,
      currentPassword: req.body.currentPassword,
      newPassword: req.body.newPassword,
    });

    await log(req.employee, 'auth.change_password', { type: 'employee', id: req.employee.id }, null, null, req);

    return ok(res, data, 'Password updated');
  } catch (error) {
    return fail(res, error.code || 'AUTH_010', error.message, [], error.statusCode || 400);
  }
}

async function forgotPassword(req, res) {
  const details = validateForgotPasswordPayload(req.body);
  console.log("detail: ",details);

  if (details.length > 0) {
    return fail(res, 'AUTH_012', 'Invalid forgot password payload', details, 422);
  }

  try {
    const data = await authService.forgotPassword({
      email: req.body.email,
    });

    return ok(res, data, 'If the account exists, an OTP has been sent');
  } catch (error) {
    return fail(res, error.code || 'AUTH_015', error.message, [], error.statusCode || 400);
  }
}

async function resetPassword(req, res) {
  const details = validateResetPasswordPayload(req.body);
  console.log("reset: ",details);
  if (details.length > 0) {
    return fail(res, 'AUTH_013', 'Invalid reset password payload', details, 422);
  }

  try {
    const data = await authService.resetPassword({
      email: req.body.email,
      otp: req.body.otp,
      newPassword: req.body.newPassword,
    });

    return ok(res, data, 'Password reset successful');
  } catch (error) {
    return fail(res, error.code || 'AUTH_014', error.message, [], error.statusCode || 400);
  }
}

async function exchangeImpersonationCode(req, res) {
  try {
    const data = await authService.exchangeImpersonationCode({
      code: req.body.code,
    });

    return ok(res, data, 'Impersonation handoff exchanged');
  } catch (error) {
    return fail(res, error.code || 'AUTH_019', error.message, [], error.statusCode || 401);
  }
}

async function exitImpersonationSession(req, res) {
  try {
    const data = await authService.exitImpersonationSession({
      employee: req.employee,
    });

    return ok(res, data, 'Impersonation session exited');
  } catch (error) {
    return fail(res, error.code || 'AUTH_022', error.message, [], error.statusCode || 400);
  }
}

module.exports = {
  login,
  refresh,
  logout,
  changePassword,
  forgotPassword,
  resetPassword,
  exchangeImpersonationCode,
  exitImpersonationSession,
};
