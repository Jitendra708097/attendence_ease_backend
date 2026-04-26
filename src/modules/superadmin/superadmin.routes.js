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
router.get('/organisations/export', asyncHandler(superadminController.exportOrgs));
router.post('/organisations', asyncHandler(superadminController.createOrg));
router.get('/organisations/search', asyncHandler(superadminController.listOrgs));
router.get('/orgs/:orgId', asyncHandler(superadminController.getOrg));
router.get('/organisations/:orgId', asyncHandler(superadminController.getOrg));
router.get('/organisations/:orgId/employees', asyncHandler(superadminController.getOrgEmployees));
router.get('/organisations/:orgId/attendance/today', asyncHandler(superadminController.getOrgAttendance));
router.get('/organisations/:orgId/billing', asyncHandler(superadminController.getOrgBilling));
router.post('/organisations/:orgId/billing/alerts', asyncHandler(superadminController.sendBillingAlert));
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
router.get('/analytics/growth', asyncHandler(superadminController.analyticsGrowth));
router.get('/analytics/usage', asyncHandler(superadminController.analyticsUsage));
router.get('/analytics/retention', asyncHandler(superadminController.analyticsRetention));
router.get('/analytics/mrr', asyncHandler(superadminController.mrr));
router.get('/analytics/orgs/growth', asyncHandler(superadminController.growth));
router.get('/analytics/alerts', asyncHandler(superadminController.alerts));
router.get('/analytics/signups/recent', asyncHandler(superadminController.recentSignups));

router.get('/billing/summary', asyncHandler(superadminController.revenueSummary));
router.get('/billing/mrr', asyncHandler(superadminController.billingMrrHistory));
router.get('/billing/plans', asyncHandler(superadminController.billingPlanBreakdown));
router.get('/billing/churn', asyncHandler(superadminController.billingChurn));
router.get('/billing/invoices', asyncHandler(superadminController.billingInvoices));
router.get('/billing/top-orgs', asyncHandler(superadminController.billingTopOrgs));

router.get('/feature-flags', asyncHandler(superadminController.getFeatureFlags));
router.put('/feature-flags/:key/global', asyncHandler(superadminController.setGlobalFeatureFlag));
router.put('/feature-flags/:key/orgs/:orgId', asyncHandler(superadminController.setOrgFeatureFlagOverride));
router.delete('/feature-flags/:key/orgs/:orgId', asyncHandler(superadminController.removeOrgFeatureFlagOverride));
router.get('/feature-flags/:key/orgs', asyncHandler(superadminController.getFeatureFlagOrgs));

router.get('/health', asyncHandler(superadminController.health));
router.get('/health/queues', asyncHandler(superadminController.queues));
router.get('/health/queues/:name', asyncHandler(superadminController.queueByName));
router.get('/health/queues/failed', asyncHandler(superadminController.failedJobs));
router.post('/health/queues/:queue/retry/:jobId', asyncHandler(superadminController.retryQueueJob));
router.post('/health/queues/:queue/retry-all', asyncHandler(superadminController.retryAllQueueJobs));
router.get('/health/metrics', asyncHandler(superadminController.metrics));
router.get('/health/database', asyncHandler(superadminController.databaseStatus));

router.get('/audit-logs', asyncHandler(superadminController.auditLogs));

module.exports = router;
