const { ok, fail } = require('../../utils/response');
const { log } = require('../../utils/auditLog');
const {
  clearSuperadminAuthCookies,
  getAccessTokenFromRequest,
  getRefreshTokenFromRequest,
  setSuperadminAuthCookies,
} = require('../../utils/authCookies');
const { blacklistToken } = require('../../utils/jwtBlacklist');
const superadminService = require('./superadmin.service');
const feedbackService = require('../feedback/feedback.service');

async function login(req, res) {
  try {
    const data = await superadminService.login(req.body);
    setSuperadminAuthCookies(res, data);
    return ok(res, data, 'Superadmin login successful');
  } catch (error) {
    try {
      await log(
        null,
        'superadmin.login_failed',
        { type: 'superadmin_auth', id: String(req.body?.email || '').trim().toLowerCase() || null },
        null,
        { email: String(req.body?.email || '').trim().toLowerCase() || null, code: error.code || 'AUTH_001' },
        req
      );
    } catch (_) {
      // Audit write failure must not change the login failure response.
    }
    return fail(res, error.code || 'AUTH_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function refresh(req, res) {
  try {
    const data = await superadminService.refresh(getRefreshTokenFromRequest(req));
    setSuperadminAuthCookies(res, data);
    return ok(res, data, 'Token refreshed');
  } catch (error) {
    return fail(res, error.code || 'AUTH_002', error.message, error.details || [], error.statusCode || 400);
  }
}

async function logout(req, res) {
  try {
    const data = await superadminService.logout({
      employeeId: req.employee.id,
      refreshToken: getRefreshTokenFromRequest(req),
    });
    await blacklistToken(getAccessTokenFromRequest(req));
    clearSuperadminAuthCookies(res);
    return ok(res, data, 'Logged out');
  } catch (error) {
    return fail(res, error.code || 'AUTH_006', error.message, error.details || [], error.statusCode || 400);
  }
}

async function me(req, res) {
  try {
    const data = await superadminService.getMe(req.employee.id);
    return ok(res, data, 'Profile fetched');
  } catch (error) {
    return fail(res, error.code || 'HTTP_404', error.message, error.details || [], error.statusCode || 400);
  }
}

async function listOrgs(req, res) {
  try {
    const data = await superadminService.listOrgs(req.query);
    return ok(res, data, 'Organisations fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function previewOrgSlug(req, res) {
  try {
    const data = await superadminService.getOrgSlugPreview(req.query.name || req.query.q || '');
    return ok(res, data, 'Organisation slug preview fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_047', error.message, error.details || [], error.statusCode || 400);
  }
}

async function exportOrgs(req, res) {
  try {
    const result = await superadminService.exportOrganisations(req.query);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    return res.status(200).send(result.body);
  } catch (error) {
    return fail(res, error.code || 'SA_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function createOrg(req, res) {
  try {
    const data = await superadminService.createOrg(req.body);
    await log(req.employee, 'ORG_CREATED', { type: 'organisation', id: data.id }, null, data, req);
    return ok(res, data, 'Organisation created', 201);
  } catch (error) {
    return fail(res, error.code || 'SA_023', error.message, error.details || [], error.statusCode || 400);
  }
}

async function getOrg(req, res) {
  try {
    const data = await superadminService.getOrgDetail(req.params.orgId);
    return ok(res, data, 'Organisation fetched');
  } catch (error) {
    return fail(res, error.code || 'HTTP_404', error.message, error.details || [], error.statusCode || 400);
  }
}

async function getOrgEmployees(req, res) {
  try {
    const data = await superadminService.getOrgEmployees(req.params.orgId, req.query);
    return ok(res, data, 'Organisation employees fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_002', error.message, error.details || [], error.statusCode || 400);
  }
}

async function getOrgAttendance(req, res) {
  try {
    const data = await superadminService.getOrgAttendanceToday(req.params.orgId);
    return ok(res, data, 'Organisation attendance fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_003', error.message, error.details || [], error.statusCode || 400);
  }
}

async function getOrgBilling(req, res) {
  try {
    const data = await superadminService.getOrgBilling(req.params.orgId);
    return ok(res, data, 'Organisation billing fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_004', error.message, error.details || [], error.statusCode || 400);
  }
}

async function getOrgPlanHistory(req, res) {
  try {
    const data = await superadminService.getOrgPlanHistory(req.params.orgId, req.query);
    return ok(res, data, 'Organisation plan history fetched');
  } catch (error) {
    return fail(res, error.code || 'PLAN_004', error.message, error.details || [], error.statusCode || 400);
  }
}

async function sendBillingAlert(req, res) {
  try {
    const data = await superadminService.sendBillingAlert({
      orgId: req.params.orgId,
      alertType: req.body.alertType,
      customMessage: req.body.customMessage,
    });
    await log(req.employee, 'ORG_BILLING_ALERT_SENT', { type: 'organisation', id: req.params.orgId }, null, data, req);
    return ok(res, data, 'Billing alert email queued');
  } catch (error) {
    return fail(res, error.code || 'SA_026', error.message, error.details || [], error.statusCode || 400);
  }
}

async function resendOrgInvite(req, res) {
  try {
    const data = await superadminService.resendOrgAdminInvite({
      orgId: req.params.orgId,
    });
    await log(req.employee, 'ORG_INVITE_RESENT', { type: 'organisation', id: req.params.orgId }, null, data, req);
    return ok(res, data, data.queued
      ? 'Organisation admin invite email queued for delivery'
      : 'Organisation admin invite could not be queued');
  } catch (error) {
    return fail(res, error.code || 'SA_042', error.message, error.details || [], error.statusCode || 400);
  }
}

async function updateOrgProfile(req, res) {
  try {
    const data = await superadminService.updateOrgProfile({
      orgId: req.params.orgId,
      payload: req.body,
      actorId: req.employee.id,
    });
    await log(req.employee, 'ORG_PROFILE_UPDATED', { type: 'organisation', id: req.params.orgId }, data.oldValue, data.newValue, req);
    return ok(res, data.newValue, 'Organisation profile updated');
  } catch (error) {
    return fail(res, error.code || 'SA_044', error.message, error.details || [], error.statusCode || 400);
  }
}

async function suspendOrg(req, res) {
  try {
    const data = await superadminService.suspendOrg({
      orgId: req.params.orgId,
      reason: req.body.reason,
      actorId: req.employee.id,
    });
    await log(req.employee, 'ORG_SUSPENDED', { type: 'organisation', id: req.params.orgId }, data.oldValue, data.newValue, req);
    return ok(res, data.newValue, 'Organisation suspended');
  } catch (error) {
    return fail(res, error.code || 'SA_005', error.message, error.details || [], error.statusCode || 400);
  }
}

async function activateOrg(req, res) {
  try {
    const data = await superadminService.activateOrg({
      orgId: req.params.orgId,
      reason: req.body.reason,
      actorId: req.employee.id,
    });
    await log(req.employee, 'ORG_ACTIVATED', { type: 'organisation', id: req.params.orgId }, data.oldValue, data.newValue, req);
    return ok(res, data.newValue, 'Organisation activated');
  } catch (error) {
    return fail(res, error.code || 'SA_006', error.message, error.details || [], error.statusCode || 400);
  }
}

async function cancelOrg(req, res) {
  try {
    const data = await superadminService.cancelOrg({
      orgId: req.params.orgId,
      reason: req.body.reason,
      actorId: req.employee.id,
    });
    await log(req.employee, 'ORG_CANCELLED', { type: 'organisation', id: req.params.orgId }, data.oldValue, data.newValue, req);
    return ok(res, data.newValue, 'Organisation cancelled');
  } catch (error) {
    return fail(res, error.code || 'SA_047', error.message, error.details || [], error.statusCode || 400);
  }
}

async function addOrgNote(req, res) {
  try {
    const data = await superadminService.addOrgNote({
      orgId: req.params.orgId,
      note: req.body.note,
      actorId: req.employee.id,
      actorName: req.employee.name,
    });
    await log(req.employee, 'ORG_NOTE_ADDED', { type: 'organisation', id: req.params.orgId }, data.oldValue, data.note, req);
    return ok(res, data.newValue, 'Organisation note added');
  } catch (error) {
    return fail(res, error.code || 'SA_047', error.message, error.details || [], error.statusCode || 400);
  }
}

async function transferOrgOwner(req, res) {
  try {
    const data = await superadminService.transferOrgOwner({
      orgId: req.params.orgId,
      employeeId: req.body.employeeId,
      reason: req.body.reason,
      actorId: req.employee.id,
    });
    await log(req.employee, 'ORG_OWNER_TRANSFERRED', { type: 'organisation', id: req.params.orgId }, data.oldValue, data.newValue, req);
    return ok(res, data.newValue, 'Organisation owner transferred');
  } catch (error) {
    return fail(res, error.code || 'SA_048', error.message, error.details || [], error.statusCode || 400);
  }
}

async function changePlan(req, res) {
  try {
    const data = await superadminService.changePlan({
      orgId: req.params.orgId,
      plan: req.body.plan,
      reason: req.body.reason,
      effectiveDate: req.body.effectiveDate,
      actorId: req.employee.id,
    });
    await log(req.employee, 'PLAN_CHANGED', { type: 'organisation', id: req.params.orgId }, data.oldValue, data.newValue, req);
    return ok(res, data.newValue, 'Organisation plan updated');
  } catch (error) {
    return fail(res, error.code || 'SA_007', error.message, error.details || [], error.statusCode || 400);
  }
}

async function extendTrial(req, res) {
  try {
    const data = await superadminService.extendTrial({
      orgId: req.params.orgId,
      extendByDays: req.body.extendByDays,
      reason: req.body.reason,
      actorId: req.employee.id,
    });
    await log(req.employee, 'TRIAL_EXTENDED', { type: 'organisation', id: req.params.orgId }, data.oldValue, data.newValue, req);
    return ok(res, data.newValue, 'Organisation trial extended');
  } catch (error) {
    return fail(res, error.code || 'SA_008', error.message, error.details || [], error.statusCode || 400);
  }
}

async function stats(req, res) {
  try {
    const data = await superadminService.getStats(req.query);
    return ok(res, data.stats, 'Platform stats fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_009', error.message, error.details || [], error.statusCode || 400);
  }
}

async function dashboard(req, res) {
  try {
    const data = await superadminService.getStats(req.query);
    return ok(res, data.stats, 'Dashboard stats fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_009', error.message, error.details || [], error.statusCode || 400);
  }
}

async function mrr(req, res) {
  try {
    const data = await superadminService.getStats(req.query);
    return ok(res, data.mrrTrend, 'MRR trend fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_010', error.message, error.details || [], error.statusCode || 400);
  }
}

async function growth(req, res) {
  try {
    const data = await superadminService.getStats(req.query);
    return ok(res, data.orgGrowth, 'Organisation growth fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_011', error.message, error.details || [], error.statusCode || 400);
  }
}

async function alerts(req, res) {
  try {
    const data = await superadminService.getStats(req.query);
    return ok(res, data.alerts, 'Alerts fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_012', error.message, error.details || [], error.statusCode || 400);
  }
}

async function recentSignups(req, res) {
  try {
    const data = await superadminService.getStats({ ...req.query, recentSignupsLimit: req.query.limit });
    return ok(res, data.recentSignups, 'Recent signups fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_013', error.message, error.details || [], error.statusCode || 400);
  }
}

async function analyticsGrowth(req, res) {
  try {
    const data = await superadminService.getAnalyticsGrowth(req.query);
    return ok(res, data, 'Growth analytics fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_029', error.message, error.details || [], error.statusCode || 400);
  }
}

async function analyticsUsage(req, res) {
  try {
    const data = await superadminService.getAnalyticsUsage(req.query);
    return ok(res, data, 'Usage analytics fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_030', error.message, error.details || [], error.statusCode || 400);
  }
}

async function analyticsRetention(req, res) {
  try {
    const data = await superadminService.getAnalyticsRetention(req.query);
    return ok(res, data, 'Retention analytics fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_031', error.message, error.details || [], error.statusCode || 400);
  }
}

async function revenueSummary(req, res) {
  try {
    const data = await superadminService.getRevenueSummary();
    return ok(res, data, 'Revenue summary fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_032', error.message, error.details || [], error.statusCode || 400);
  }
}

async function billingMrrHistory(req, res) {
  try {
    const data = await superadminService.getBillingMrrHistory(req.query);
    return ok(res, data, 'Billing MRR history fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_033', error.message, error.details || [], error.statusCode || 400);
  }
}

async function billingPlanBreakdown(req, res) {
  try {
    const data = await superadminService.getBillingPlanBreakdown();
    return ok(res, data, 'Billing plan breakdown fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_034', error.message, error.details || [], error.statusCode || 400);
  }
}

async function billingChurn(req, res) {
  try {
    const data = await superadminService.getBillingChurnedOrgs(req.query);
    return ok(res, data, 'Billing churn fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_035', error.message, error.details || [], error.statusCode || 400);
  }
}

async function billingInvoices(req, res) {
  try {
    const data = await superadminService.getBillingInvoices(req.query);
    return ok(res, data, 'Billing invoices fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_036', error.message, error.details || [], error.statusCode || 400);
  }
}

async function exportBillingInvoices(req, res) {
  try {
    const result = await superadminService.exportBillingInvoices(req.query);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    return res.status(200).send(result.body);
  } catch (error) {
    return fail(res, error.code || 'SA_036', error.message, error.details || [], error.statusCode || 400);
  }
}

async function billingTopOrgs(req, res) {
  try {
    const data = await superadminService.getBillingTopOrgs(req.query);
    return ok(res, data, 'Top billing organisations fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_037', error.message, error.details || [], error.statusCode || 400);
  }
}

async function health(req, res) {
  try {
    const data = await superadminService.getStats(req.query);
    return ok(res, data.health, 'Platform health fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_014', error.message, error.details || [], error.statusCode || 400);
  }
}

async function queues(req, res) {
  try {
    const data = await superadminService.getStats(req.query);
    return ok(res, data.health.queues, 'Queue health fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_015', error.message, error.details || [], error.statusCode || 400);
  }
}

async function failedJobs(req, res) {
  try {
    const data = await superadminService.getQueueSnapshot({ includeFailedJobs: true });
    return ok(res, { jobs: data.failedJobs }, 'Failed jobs fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_016', error.message, error.details || [], error.statusCode || 400);
  }
}

async function metrics(req, res) {
  try {
    const data = await superadminService.getStats();
    return ok(res, data.health.metrics, 'API metrics fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_017', error.message, error.details || [], error.statusCode || 400);
  }
}

async function startImpersonation(req, res) {
  try {
    const data = await superadminService.startImpersonation({
      superAdminId: req.employee.id,
      orgId: req.params.orgId || req.body.orgId,
      adminId: req.body.adminId || req.body.targetEmpId,
      reason: req.body.reason,
      forceEndExisting: Boolean(req.body.forceEndExisting),
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
    });
    await log(req.employee, 'IMPERSONATION_START', { type: 'impersonation_session', id: data.id }, null, data, req);
    return ok(res, data, 'Impersonation session started');
  } catch (error) {
    return fail(res, error.code || 'SA_018', error.message, error.details || [], error.statusCode || 400);
  }
}

async function endImpersonation(req, res) {
  try {
    const body = req.body || {};
    const data = await superadminService.endImpersonation({
      superAdminId: req.employee.id,
      sessionId: req.params.sessionId || body.sessionId || null,
      endReason: body.endReason || 'manual_end',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
    });
    await log(req.employee, 'IMPERSONATION_END', { type: 'impersonation_session', id: data.id }, null, data, req);
    return ok(res, data, 'Impersonation session ended');
  } catch (error) {
    return fail(res, error.code || 'SA_019', error.message, error.details || [], error.statusCode || 400);
  }
}

async function activeImpersonation(req, res) {
  try {
    const data = await superadminService.getActiveImpersonation(req.employee.id);
    return ok(res, data, 'Active impersonation fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_020', error.message, error.details || [], error.statusCode || 400);
  }
}

async function impersonationHistory(req, res) {
  try {
    const data = await superadminService.getImpersonationHistory(req.employee.id, req.query);
    return ok(res, data, 'Impersonation history fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_021', error.message, error.details || [], error.statusCode || 400);
  }
}

async function impersonationDetail(req, res) {
  try {
    const data = await superadminService.getImpersonationDetail(req.employee.id, req.params.sessionId);
    return ok(res, data, 'Impersonation session detail fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_021', error.message, error.details || [], error.statusCode || 400);
  }
}

async function auditLogs(req, res) {
  try {
    const data = await superadminService.getAuditLogs(req.query);
    return ok(res, data, 'Audit logs fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_022', error.message, error.details || [], error.statusCode || 400);
  }
}

async function auditLogSummary(req, res) {
  try {
    const data = await superadminService.getAuditLogSummary(req.query);
    return ok(res, data, 'Audit log summary fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_022', error.message, error.details || [], error.statusCode || 400);
  }
}

async function auditLogById(req, res) {
  try {
    const data = await superadminService.getAuditLogById(req.params.id);
    return ok(res, data, 'Audit log fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_022', error.message, error.details || [], error.statusCode || 400);
  }
}

async function exportAuditLogs(req, res) {
  try {
    const result = await superadminService.exportAuditLogs(req.query);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    return res.status(200).send(result.body);
  } catch (error) {
    return fail(res, error.code || 'SA_022', error.message, error.details || [], error.statusCode || 400);
  }
}

async function getFeatureFlags(req, res) {
  try {
    const data = await superadminService.getAllFeatureFlags();
    return ok(res, data, 'Feature flags fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_028', error.message, error.details || [], error.statusCode || 400);
  }
}

async function setGlobalFeatureFlag(req, res) {
  try {
    const data = await superadminService.setFeatureFlagGlobal({
      flagKey: req.params.key,
      enabled: req.body.enabled,
    });
    await log(req.employee, 'FEATURE_FLAG_CHANGED', { type: 'feature_flag', id: req.params.key }, null, data, req);
    return ok(res, data, 'Global feature flag updated');
  } catch (error) {
    return fail(res, error.code || 'SA_028', error.message, error.details || [], error.statusCode || 400);
  }
}

async function setOrgFeatureFlagOverride(req, res) {
  try {
    const data = await superadminService.setFeatureFlagOrgOverride({
      flagKey: req.params.key,
      orgId: req.params.orgId,
      enabled: req.body.enabled,
    });
    await log(req.employee, 'FEATURE_FLAG_CHANGED', { type: 'feature_flag_override', id: `${req.params.key}:${req.params.orgId}` }, null, data, req);
    return ok(res, data, 'Organisation feature flag override updated');
  } catch (error) {
    return fail(res, error.code || 'SA_028', error.message, error.details || [], error.statusCode || 400);
  }
}

async function removeOrgFeatureFlagOverride(req, res) {
  try {
    const data = await superadminService.removeFeatureFlagOrgOverride({
      flagKey: req.params.key,
      orgId: req.params.orgId,
    });
    await log(req.employee, 'FEATURE_FLAG_CHANGED', { type: 'feature_flag_override', id: `${req.params.key}:${req.params.orgId}` }, null, data, req);
    return ok(res, data, 'Organisation feature flag override removed');
  } catch (error) {
    return fail(res, error.code || 'SA_028', error.message, error.details || [], error.statusCode || 400);
  }
}

async function getFeatureFlagOrgs(req, res) {
  try {
    const data = await superadminService.getFeatureFlagOrgs(req.params.key);
    return ok(res, data, 'Feature flag organisations fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_028', error.message, error.details || [], error.statusCode || 400);
  }
}

async function feedback(req, res) {
  try {
    const data = await feedbackService.listFeedback(req.query);
    return ok(res, data, 'Feedback fetched');
  } catch (error) {
    return fail(res, error.code || 'FDB_003', error.message, error.details || [], error.statusCode || 400);
  }
}

async function feedbackSummary(req, res) {
  try {
    const data = await feedbackService.getFeedbackSummary(req.query);
    return ok(res, data, 'Feedback summary fetched');
  } catch (error) {
    return fail(res, error.code || 'FDB_004', error.message, error.details || [], error.statusCode || 400);
  }
}

async function listPlans(req, res) {
  try {
    const data = await superadminService.listPlans();
    return ok(res, data, 'Plans fetched');
  } catch (error) {
    return fail(res, error.code || 'PLAN_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function upsertPlan(req, res) {
  try {
    const data = await superadminService.upsertPlan(req.body, req.params.code);
    await log(req.employee, 'PLAN_DEFINITION_UPDATED', { type: 'plan', id: data.plan.code }, null, data.plan, req);
    return ok(res, data, 'Plan saved');
  } catch (error) {
    return fail(res, error.code || 'PLAN_002', error.message, error.details || [], error.statusCode || 400);
  }
}

async function queueByName(req, res) {
  try {
    const data = await superadminService.getQueueStatusByName(req.params.name);
    return ok(res, data, 'Queue status fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_038', error.message, error.details || [], error.statusCode || 400);
  }
}

async function databaseStatus(req, res) {
  try {
    const data = await superadminService.getDatabaseHealthStatus();
    return ok(res, data, 'Database status fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_039', error.message, error.details || [], error.statusCode || 400);
  }
}

async function retryQueueJob(req, res) {
  try {
    const data = await superadminService.retryQueueJob(req.params.queue, req.params.jobId);
    await log(req.employee, 'HEALTH_QUEUE_JOB_RETRIED', { type: 'queue_job', id: `${req.params.queue}:${req.params.jobId}` }, null, data, req);
    return ok(res, data, 'Queue job retried');
  } catch (error) {
    return fail(res, error.code || 'SA_040', error.message, error.details || [], error.statusCode || 400);
  }
}

async function retryAllQueueJobs(req, res) {
  try {
    const data = await superadminService.retryAllFailedJobs(req.params.queue);
    await log(req.employee, 'HEALTH_QUEUE_RETRY_ALL', { type: 'queue', id: req.params.queue }, null, data, req);
    return ok(res, data, 'All failed queue jobs retried');
  } catch (error) {
    return fail(res, error.code || 'SA_041', error.message, error.details || [], error.statusCode || 400);
  }
}

module.exports = {
  login,
  refresh,
  logout,
  me,
  exportOrgs,
  createOrg,
  listOrgs,
  previewOrgSlug,
  getOrg,
  getOrgEmployees,
  getOrgAttendance,
  getOrgBilling,
  getOrgPlanHistory,
  sendBillingAlert,
  resendOrgInvite,
  updateOrgProfile,
  suspendOrg,
  activateOrg,
  cancelOrg,
  addOrgNote,
  transferOrgOwner,
  changePlan,
  extendTrial,
  stats,
  dashboard,
  mrr,
  growth,
  analyticsGrowth,
  analyticsUsage,
  analyticsRetention,
  revenueSummary,
  billingMrrHistory,
  billingPlanBreakdown,
  billingChurn,
  billingInvoices,
  exportBillingInvoices,
  billingTopOrgs,
  alerts,
  recentSignups,
  health,
  queues,
  failedJobs,
  metrics,
  startImpersonation,
  endImpersonation,
  activeImpersonation,
  impersonationHistory,
  impersonationDetail,
  auditLogs,
  auditLogSummary,
  auditLogById,
  exportAuditLogs,
  feedback,
  feedbackSummary,
  getFeatureFlags,
  setGlobalFeatureFlag,
  setOrgFeatureFlagOverride,
  removeOrgFeatureFlagOverride,
  getFeatureFlagOrgs,
  listPlans,
  upsertPlan,
  queueByName,
  databaseStatus,
  retryQueueJob,
  retryAllQueueJobs,
};
