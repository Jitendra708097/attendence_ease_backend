const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const roleGuard = require('../../middleware/roleGuard');
const departmentController = require('./department.controller');

const router = express.Router();

router.use(authenticate, orgGuard, roleGuard('admin', 'manager', 'superadmin'));

router.get('/', asyncHandler(departmentController.listDepartments));
router.post('/', asyncHandler(departmentController.createDepartment));
router.get('/:id', asyncHandler(departmentController.getDepartment));
router.put('/:id', asyncHandler(departmentController.updateDepartment));
router.delete('/:id', asyncHandler(departmentController.deleteDepartment));

module.exports = router;
