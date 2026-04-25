const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const roleGuard = require('../../middleware/roleGuard');
const branchController = require('./branch.controller');

const router = express.Router();

router.use(authenticate, orgGuard, roleGuard('admin', 'manager', 'superadmin'));

router.get('/', asyncHandler(branchController.listBranches));
router.post('/', asyncHandler(branchController.createBranch));
router.get('/current/geofence', asyncHandler(branchController.getCurrentBranchGeofence));
router.get('/:id/geofence', asyncHandler(branchController.getGeofence));
router.put('/:id/geofence', asyncHandler(branchController.updateGeofence));
router.get('/:id', asyncHandler(branchController.getBranch));
router.put('/:id', asyncHandler(branchController.updateBranch));
router.delete('/:id', asyncHandler(branchController.deleteBranch));

module.exports = router;
