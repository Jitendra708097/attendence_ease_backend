const express = require('express');
const multer = require('multer');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const roleGuard = require('../../middleware/roleGuard');
const employeeController = require('./employee.controller');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });
const adminGuard = roleGuard('admin', 'manager', 'superadmin');

router.use(authenticate, orgGuard);

router.get('/device-exceptions/mine', asyncHandler(employeeController.listOwnDeviceExceptions));
router.get('/device-exceptions', adminGuard, asyncHandler(employeeController.listDeviceExceptions));
router.post('/device-exceptions', adminGuard, asyncHandler(employeeController.createDeviceException));
router.put('/device-exceptions/:id/approve', adminGuard, asyncHandler(employeeController.approveDeviceException));
router.put('/device-exceptions/:id/reject', adminGuard, asyncHandler(employeeController.rejectDeviceException));

router.get('/', adminGuard, asyncHandler(employeeController.listEmployees));
router.delete('/', adminGuard, asyncHandler(employeeController.deleteEmployees));
router.post('/bulk-upload', adminGuard, upload.single('file'), asyncHandler(employeeController.bulkUpload));
router.get('/:id/attendance-summary', adminGuard, asyncHandler(employeeController.attendanceSummary));
router.get('/:id', adminGuard, asyncHandler(employeeController.getEmployee));
router.post('/', adminGuard, asyncHandler(employeeController.createEmployee));
router.put('/:id', adminGuard, asyncHandler(employeeController.updateEmployee));
router.delete('/:id', adminGuard, asyncHandler(employeeController.deleteEmployee));

module.exports = router;
