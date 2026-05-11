const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const roleGuard = require('../../middleware/roleGuard');
const branchController = require('./branch.controller');

const router = express.Router();

router.use(authenticate, orgGuard);

router.get('/current/geofence', asyncHandler(branchController.getCurrentBranchGeofence));

router.use(roleGuard('admin', 'manager', 'superadmin'));

router.get('/', asyncHandler(branchController.listBranches));
router.post('/', asyncHandler(branchController.createBranch));
router.get('/:id/employees', asyncHandler(branchController.listBranchEmployees));
router.get('/:id/stats/today', asyncHandler(branchController.getBranchTodayStats));
router.get('/:id/geofence', asyncHandler(branchController.getGeofence));
router.post('/:id/geofence/test', asyncHandler(branchController.testGeofence));
router.put('/:id/geofence', asyncHandler(branchController.updateGeofence));
router.get('/:id', asyncHandler(branchController.getBranch));
router.put('/:id', asyncHandler(branchController.updateBranch));
router.delete('/:id', asyncHandler(branchController.deleteBranch));

module.exports = router;
