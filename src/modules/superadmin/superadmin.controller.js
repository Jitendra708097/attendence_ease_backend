const { ok, fail } = require('../../utils/response');
const { log } = require('../../utils/auditLog');
const superadminService = require('./superadmin.service');

async function login(req, res) {
  try {
    const data = await superadminService.login(req.body);
    return ok(res, data, 'Superadmin login successful');
  } catch (error) {
    return fail(res, error.code || 'AUTH_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function refresh(req, res) {
  try {
    const data = await superadminService.refresh(req.body.refreshToken);
    return ok(res, data, 'Token refreshed');
  } catch (error) {
    return fail(res, error.code || 'AUTH_002', error.message, error.details || [], error.statusCode || 400);
  }
}

async function logout(req, res) {
  try {
    const data = await superadminService.logout({
      employeeId: req.employee.id,
      refreshToken: req.body.refreshToken,
    });
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

async function suspendOrg(req, res) {
  try {
    const data = await superadminService.suspendOrg({ orgId: req.params.orgId });
    await log(req.employee, 'ORG_SUSPENDED', { type: 'organisation', id: req.params.orgId }, data.oldValue, data.newValue, req);
    return ok(res, data.newValue, 'Organisation suspended');
  } catch (error) {
    return fail(res, error.code || 'SA_005', error.message, error.details || [], error.statusCode || 400);
  }
}

async function activateOrg(req, res) {
  try {
    const data = await superadminService.activateOrg({ orgId: req.params.orgId });
    await log(req.employee, 'ORG_ACTIVATED', { type: 'organisation', id: req.params.orgId }, data.oldValue, data.newValue, req);
    return ok(res, data.newValue, 'Organisation activated');
  } catch (error) {
    return fail(res, error.code || 'SA_006', error.message, error.details || [], error.statusCode || 400);
  }
}

async function changePlan(req, res) {
  try {
    const data = await superadminService.changePlan({
      orgId: req.params.orgId,
      plan: req.body.plan,
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
    });
    await log(req.employee, 'TRIAL_EXTENDED', { type: 'organisation', id: req.params.orgId }, data.oldValue, data.newValue, req);
    return ok(res, data.newValue, 'Organisation trial extended');
  } catch (error) {
    return fail(res, error.code || 'SA_008', error.message, error.details || [], error.statusCode || 400);
  }
}

async function stats(req, res) {
  try {
    const data = await superadminService.getStats();
    return ok(res, data.stats, 'Platform stats fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_009', error.message, error.details || [], error.statusCode || 400);
  }
}

async function dashboard(req, res) {
  try {
    const data = await superadminService.getStats();
    return ok(res, data.stats, 'Dashboard stats fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_009', error.message, error.details || [], error.statusCode || 400);
  }
}

async function mrr(req, res) {
  try {
    const data = await superadminService.getStats();
    return ok(res, data.mrrTrend, 'MRR trend fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_010', error.message, error.details || [], error.statusCode || 400);
  }
}

async function growth(req, res) {
  try {
    const data = await superadminService.getStats();
    return ok(res, data.orgGrowth, 'Organisation growth fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_011', error.message, error.details || [], error.statusCode || 400);
  }
}

async function alerts(req, res) {
  try {
    const data = await superadminService.getStats();
    return ok(res, data.alerts, 'Alerts fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_012', error.message, error.details || [], error.statusCode || 400);
  }
}

async function recentSignups(req, res) {
  try {
    const data = await superadminService.getStats();
    return ok(res, data.recentSignups, 'Recent signups fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_013', error.message, error.details || [], error.statusCode || 400);
  }
}

async function health(req, res) {
  try {
    const data = await superadminService.getStats();
    return ok(res, data.health, 'Platform health fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_014', error.message, error.details || [], error.statusCode || 400);
  }
}

async function queues(req, res) {
  try {
    const data = await superadminService.getStats();
    return ok(res, data.health.queues, 'Queue health fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_015', error.message, error.details || [], error.statusCode || 400);
  }
}

async function failedJobs(req, res) {
  try {
    const data = await superadminService.getStats();
    return ok(res, { jobs: data.health.failedJobs }, 'Failed jobs fetched');
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
    });
    await log(req.employee, 'IMPERSONATION_START', { type: 'impersonation_session', id: data.id }, null, data, req);
    return ok(res, data, 'Impersonation session started');
  } catch (error) {
    return fail(res, error.code || 'SA_018', error.message, error.details || [], error.statusCode || 400);
  }
}

async function endImpersonation(req, res) {
  try {
    const data = await superadminService.endImpersonation({
      superAdminId: req.employee.id,
      sessionId: req.params.sessionId || req.body.sessionId || null,
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

async function auditLogs(req, res) {
  try {
    const data = await superadminService.getAuditLogs(req.query);
    return ok(res, data, 'Audit logs fetched');
  } catch (error) {
    return fail(res, error.code || 'SA_022', error.message, error.details || [], error.statusCode || 400);
  }
}

module.exports = {
  login,
  refresh,
  logout,
  me,
  createOrg,
  listOrgs,
  getOrg,
  getOrgEmployees,
  getOrgAttendance,
  getOrgBilling,
  suspendOrg,
  activateOrg,
  changePlan,
  extendTrial,
  stats,
  dashboard,
  mrr,
  growth,
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
  auditLogs,
};
