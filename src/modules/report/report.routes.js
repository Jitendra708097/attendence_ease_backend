const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const roleGuard = require('../../middleware/roleGuard');
const reportController = require('./report.controller');

const router = express.Router();

router.use(authenticate, orgGuard, roleGuard('admin', 'manager', 'superadmin'));

router.get('/jobs', asyncHandler(reportController.list));
router.post('/jobs', asyncHandler(reportController.create));
router.post('/generate', asyncHandler(reportController.create));
router.post('/jobs/:jobId/cancel', asyncHandler(reportController.cancel));
router.get('/jobs/:jobId', asyncHandler(reportController.get));
router.get('/jobs/:jobId/download', asyncHandler(reportController.get));
router.delete('/jobs/:jobId', asyncHandler(reportController.remove));

module.exports = router;
