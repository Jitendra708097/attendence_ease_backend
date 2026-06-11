const DEVICE_EXCEPTION_STATUSES = ['pending', 'approved', 'used', 'expired', 'rejected'];

function isEmployeeDeviceExceptionFlowEnabled(settings = {}) {
  return settings?.attendance?.allowEmployeeDeviceExceptionFlow !== false;
}

module.exports = {
  DEVICE_EXCEPTION_STATUSES,
  isEmployeeDeviceExceptionFlowEnabled,
};
