function validateLoginPayload(body = {}) {
  const details = [];

  if (!body.email) {
    details.push({ field: 'email', message: 'Email is required' });
  }

  if (!body.password) {
    details.push({ field: 'password', message: 'Password is required' });
  }

  return details;
}

function validateRefreshPayload(body = {}) {
  const details = [];

  if (!body.refreshToken) {
    details.push({ field: 'refreshToken', message: 'Refresh token is required' });
  }

  return details;
}

function validateChangePasswordPayload(body = {}) {
  const details = [];

  if (!body.currentPassword) {
    details.push({ field: 'currentPassword', message: 'Current password is required' });
  }

  if (!body.newPassword || String(body.newPassword).length < 8) {
    details.push({ field: 'newPassword', message: 'New password must be at least 8 characters' });
  }

  return details;
}

function validateForgotPasswordPayload(body = {}) {
  const details = [];

  if (!body.email) {
    details.push({ field: 'email', message: 'Email is required' });
  }

  return details;
}

function validateResetPasswordPayload(body = {}) {
  const details = [];

  if (!body.email) {
    details.push({ field: 'email', message: 'Email is required' });
  }

  if (!body.otp || !/^\d{6}$/.test(String(body.otp).trim())) {
    details.push({ field: 'otp', message: 'OTP must be a 6-digit code' });
  }

  if (!body.newPassword || String(body.newPassword).length < 8) {
    details.push({ field: 'newPassword', message: 'New password must be at least 8 characters' });
  }

  return details;
}

module.exports = {
  validateLoginPayload,
  validateRefreshPayload,
  validateChangePasswordPayload,
  validateForgotPasswordPayload,
  validateResetPasswordPayload,
};
