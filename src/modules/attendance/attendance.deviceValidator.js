const { Op } = require('sequelize');
const { DeviceException } = require('../../models');

function createError(code, message, statusCode, details = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

async function validateDevice({ orgId, employee, deviceId, useDeviceException, exceptionId }) {
  if (employee.registered_device_id && employee.registered_device_id === deviceId) {
    return;
  }

  if (!employee.registered_device_id && deviceId) {
    await employee.update({ registered_device_id: deviceId });
    return;
  }

  if (useDeviceException && exceptionId) {
    const [approvedUpdatedCount] = await DeviceException.update(
      { status: 'used' },
      {
        where: {
          id: exceptionId,
          org_id: orgId,
          emp_id: employee.id,
          temp_device_id: deviceId,
          status: 'approved',
          expires_at: { [Op.gt]: new Date() },
        },
      }
    );

    if (approvedUpdatedCount) {
      return;
    }

    throw createError('AUTH_009', 'Device exception is invalid, expired, or already used', 401);
  }

  throw createError('AUTH_009', 'This device is not registered for the employee', 401);
}

module.exports = {
  validateDevice,
};
