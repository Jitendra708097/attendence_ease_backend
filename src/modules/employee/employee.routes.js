const express = require('express');
const multer = require('multer');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const roleGuard = require('../../middleware/roleGuard');
const employeeController = require('./employee.controller');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.use(authenticate, orgGuard, roleGuard('admin', 'manager', 'superadmin'));

router.get('/', asyncHandler(employeeController.listEmployees));
router.post('/bulk-upload', upload.single('file'), asyncHandler(employeeController.bulkUpload));
router.get('/:id/attendance-summary', asyncHandler(employeeController.attendanceSummary));
router.get('/:id', asyncHandler(employeeController.getEmployee));
router.post('/', asyncHandler(employeeController.createEmployee));
router.put('/:id', asyncHandler(employeeController.updateEmployee));
router.delete('/:id', asyncHandler(employeeController.deleteEmployee));

module.exports = router;
