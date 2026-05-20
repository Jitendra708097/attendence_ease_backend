const express = require('express');
const multer = require('multer');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const roleGuard = require('../../middleware/roleGuard');
const blockImpersonatedWrites = require('../../middleware/blockImpersonatedWrites');
const employeeController = require('./employee.controller');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });
const adminGuard = roleGuard('admin', 'manager', 'superadmin');

router.use(authenticate, orgGuard);

router.get('/device-exceptions/mine', asyncHandler(employeeController.listOwnDeviceExceptions));
router.post('/device-exceptions/request', blockImpersonatedWrites, asyncHandler(employeeController.requestOwnDeviceException));
router.get('/me/notification-preferences', asyncHandler(employeeController.getNotificationPreferences));
router.patch('/me/notification-preferences', asyncHandler(employeeController.updateNotificationPreferences));
router.get('/device-exceptions', adminGuard, asyncHandler(employeeController.listDeviceExceptions));
router.post('/device-exceptions', adminGuard, asyncHandler(employeeController.createDeviceException));
router.put('/device-exceptions/:id/approve', adminGuard, asyncHandler(employeeController.approveDeviceException));
router.put('/device-exceptions/:id/reject', adminGuard, asyncHandler(employeeController.rejectDeviceException));

router.get('/', adminGuard, asyncHandler(employeeController.listEmployees));
router.delete('/', adminGuard, blockImpersonatedWrites, asyncHandler(employeeController.deleteEmployees));
router.post('/bulk-upload', adminGuard, blockImpersonatedWrites, upload.single('file'), asyncHandler(employeeController.bulkUpload));
router.get('/:id/attendance-summary', adminGuard, asyncHandler(employeeController.attendanceSummary));
router.get('/:id', adminGuard, asyncHandler(employeeController.getEmployee));
router.post('/', adminGuard, blockImpersonatedWrites, asyncHandler(employeeController.createEmployee));
router.post('/:id/invite/resend', adminGuard, blockImpersonatedWrites, asyncHandler(employeeController.resendInvite));
router.put('/:id', adminGuard, blockImpersonatedWrites, asyncHandler(employeeController.updateEmployee));
router.delete('/:id', adminGuard, blockImpersonatedWrites, asyncHandler(employeeController.deleteEmployee));

module.exports = router;
