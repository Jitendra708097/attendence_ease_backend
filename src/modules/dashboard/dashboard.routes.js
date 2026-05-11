const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const roleGuard = require('../../middleware/roleGuard');
const dashboardController = require('./dashboard.controller');

const router = express.Router();

router.use(authenticate, orgGuard);

router.get(
  '/admin-summary',
  roleGuard('admin', 'manager', 'superadmin'),
  asyncHandler(dashboardController.adminSummary)
);

module.exports = router;
