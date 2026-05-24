const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const roleGuard = require('../../middleware/roleGuard');
const blockImpersonatedWrites = require('../../middleware/blockImpersonatedWrites');
const designationController = require('./designation.controller');

const router = express.Router();

router.use(authenticate, orgGuard);

router.get('/', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(designationController.listDesignations));
router.post('/', roleGuard('admin', 'superadmin'), blockImpersonatedWrites, asyncHandler(designationController.createDesignation));
router.delete('/:id', roleGuard('admin', 'superadmin'), blockImpersonatedWrites, asyncHandler(designationController.deleteDesignation));

module.exports = router;
