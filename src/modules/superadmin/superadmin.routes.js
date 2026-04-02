const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const superadminController = require('./superadmin.controller');
const requireSuperadmin = require('./superadmin.middleware');

const router = express.Router();

router.post('/auth/login', asyncHandler(superadminController.login));
router.post('/auth/refresh', asyncHandler(superadminController.refresh));

router.use(authenticate, requireSuperadmin);

router.post('/auth/logout', asyncHandler(superadminController.logout));
router.get('/auth/me', asyncHandler(superadminController.me));

router.get('/orgs', asyncHandler(superadminController.listOrgs));
router.get('/organisations', asyncHandler(superadminController.listOrgs));
router.post('/organisations', asyncHandler(superadminController.createOrg));
router.get('/organisations/search', asyncHandler(superadminController.listOrgs));
router.get('/orgs/:orgId', asyncHandler(superadminController.getOrg));
router.get('/organisations/:orgId', asyncHandler(superadminController.getOrg));
router.get('/organisations/:orgId/employees', asyncHandler(superadminController.getOrgEmployees));
router.get('/organisations/:orgId/attendance/today', asyncHandler(superadminController.getOrgAttendance));
router.get('/organisations/:orgId/billing', asyncHandler(superadminController.getOrgBilling));
router.get('/organisations/:orgId/audit-logs', asyncHandler(superadminController.auditLogs));
router.put('/orgs/:orgId/suspend', asyncHandler(superadminController.suspendOrg));
router.put('/organisations/:orgId/suspend', asyncHandler(superadminController.suspendOrg));
router.put('/organisations/:orgId/activate', asyncHandler(superadminController.activateOrg));
router.put('/orgs/:orgId/plan', asyncHandler(superadminController.changePlan));
router.put('/organisations/:orgId/plan', asyncHandler(superadminController.changePlan));
router.put('/organisations/:orgId/trial', asyncHandler(superadminController.extendTrial));

router.post('/impersonate/:orgId', asyncHandler(superadminController.startImpersonation));
router.delete('/impersonate', asyncHandler(superadminController.endImpersonation));
router.post('/impersonation/start', asyncHandler(superadminController.startImpersonation));
router.post('/impersonation/:sessionId/end', asyncHandler(superadminController.endImpersonation));
router.get('/impersonation/active', asyncHandler(superadminController.activeImpersonation));
router.get('/impersonation/history', asyncHandler(superadminController.impersonationHistory));

router.get('/stats', asyncHandler(superadminController.stats));
router.get('/analytics/dashboard', asyncHandler(superadminController.dashboard));
router.get('/analytics/mrr', asyncHandler(superadminController.mrr));
router.get('/analytics/orgs/growth', asyncHandler(superadminController.growth));
router.get('/analytics/alerts', asyncHandler(superadminController.alerts));
router.get('/analytics/signups/recent', asyncHandler(superadminController.recentSignups));

router.get('/health', asyncHandler(superadminController.health));
router.get('/health/queues', asyncHandler(superadminController.queues));
router.get('/health/queues/failed', asyncHandler(superadminController.failedJobs));
router.get('/health/metrics', asyncHandler(superadminController.metrics));

router.get('/audit-logs', asyncHandler(superadminController.auditLogs));

module.exports = router;
