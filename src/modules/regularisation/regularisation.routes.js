const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const roleGuard = require('../../middleware/roleGuard');
const regularisationController = require('./regularisation.controller');

const router = express.Router();

router.use(authenticate, orgGuard);

router.post('/', asyncHandler(regularisationController.create));
router.get('/pending', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(regularisationController.pending));
router.put('/:id/manager-approve', roleGuard('manager', 'admin', 'superadmin'), asyncHandler(regularisationController.managerApprove));
router.put('/:id/approve', roleGuard('admin', 'superadmin'), asyncHandler(regularisationController.approve));
router.put('/:id/reject', roleGuard('manager', 'admin', 'superadmin'), asyncHandler(regularisationController.reject));

module.exports = router;
