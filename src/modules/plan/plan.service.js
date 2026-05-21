const { Op } = require('sequelize');
const {
  Branch,
  Employee,
  Organisation,
  PlanDefinition,
  sequelize,
} = require('../../models');

const PLAN_CODES = ['trial', 'standard', 'enterprise'];

const DEFAULT_PLAN_DEFINITIONS = [
  {
    code: 'trial',
    name: 'Trial',
    description: 'Free trial for new organisations to validate attendance workflows.',
    billing_type: 'free',
    monthly_price: 0,
    yearly_price: 0,
    price_per_employee: 0,
    trial_days: 15,
    employee_limit: 10,
    branch_limit: 1,
    manager_limit: 2,
    storage_limit_mb: 1024,
    attendance_retention_days: 90,
    features: {
      mobile_attendance: true,
      web_attendance: true,
      face_verification: true,
      geofence: true,
      leave_management: true,
      regularisation: true,
      reports: 'basic',
      multi_branch: false,
      audit_logs: false,
      integrations: false,
      priority_support: false,
    },
    is_active: true,
    is_public: true,
    sort_order: 10,
  },
  {
    code: 'standard',
    name: 'Standard',
    description: 'Production attendance plan for growing teams with leave, reports, and multi-branch support.',
    billing_type: 'per_employee',
    monthly_price: 0,
    yearly_price: 0,
    price_per_employee: 100,
    trial_days: 0,
    employee_limit: null,
    branch_limit: 10,
    manager_limit: null,
    storage_limit_mb: 10240,
    attendance_retention_days: 730,
    features: {
      mobile_attendance: true,
      web_attendance: true,
      face_verification: true,
      geofence: true,
      leave_management: true,
      regularisation: true,
      reports: 'full',
      multi_branch: true,
      audit_logs: true,
      integrations: false,
      priority_support: false,
    },
    is_active: true,
    is_public: true,
    sort_order: 20,
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    description: 'Custom enterprise plan for high scale, advanced controls, integrations, and support.',
    billing_type: 'custom',
    monthly_price: 0,
    yearly_price: 0,
    price_per_employee: 0,
    trial_days: 0,
    employee_limit: null,
    branch_limit: null,
    manager_limit: null,
    storage_limit_mb: null,
    attendance_retention_days: null,
    features: {
      mobile_attendance: true,
      web_attendance: true,
      face_verification: true,
      geofence: true,
      leave_management: true,
      regularisation: true,
      reports: 'advanced',
      multi_branch: true,
      audit_logs: true,
      integrations: true,
      priority_support: true,
      custom_retention: true,
    },
    is_active: true,
    is_public: true,
    sort_order: 30,
  },
];

function toNumber(value) {
  if (value == null || value === '') return 0;
  return Number(value);
}

function nullableInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : null;
}

function mapPlanDefinition(plan, usage = {}) {
  if (!plan) return null;
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    billingType: plan.billing_type,
    monthlyPrice: toNumber(plan.monthly_price),
    yearlyPrice: toNumber(plan.yearly_price),
    pricePerEmployee: toNumber(plan.price_per_employee),
    trialDays: Number(plan.trial_days || 0),
    employeeLimit: plan.employee_limit,
    branchLimit: plan.branch_limit,
    managerLimit: plan.manager_limit,
    storageLimitMb: plan.storage_limit_mb,
    attendanceRetentionDays: plan.attendance_retention_days,
    features: plan.features || {},
    isActive: Boolean(plan.is_active),
    isPublic: Boolean(plan.is_public),
    sortOrder: Number(plan.sort_order || 0),
    metadata: plan.metadata || {},
    usage,
    createdAt: plan.created_at || plan.createdAt,
    updatedAt: plan.updated_at || plan.updatedAt,
  };
}

function planSnapshot(plan) {
  const mapped = mapPlanDefinition(plan);
  if (!mapped) return null;
  return {
    code: mapped.code,
    name: mapped.name,
    billingType: mapped.billingType,
    monthlyPrice: mapped.monthlyPrice,
    yearlyPrice: mapped.yearlyPrice,
    pricePerEmployee: mapped.pricePerEmployee,
    trialDays: mapped.trialDays,
    employeeLimit: mapped.employeeLimit,
    branchLimit: mapped.branchLimit,
    managerLimit: mapped.managerLimit,
    storageLimitMb: mapped.storageLimitMb,
    attendanceRetentionDays: mapped.attendanceRetentionDays,
    features: mapped.features,
  };
}

async function ensureDefaultPlans(transaction) {
  const existing = await PlanDefinition.findAll({
    where: { code: { [Op.in]: PLAN_CODES } },
    transaction,
  });
  const existingCodes = new Set(existing.map((plan) => plan.code));
  const missing = DEFAULT_PLAN_DEFINITIONS.filter((plan) => !existingCodes.has(plan.code));

  if (missing.length) {
    await PlanDefinition.bulkCreate(missing, { transaction });
  }
}

async function getPlanByCode(code, options = {}) {
  await ensureDefaultPlans(options.transaction);
  const normalized = String(code || '').trim().toLowerCase();
  if (!PLAN_CODES.includes(normalized)) {
    return null;
  }

  return PlanDefinition.findOne({
    where: { code: normalized, is_active: true },
    transaction: options.transaction,
  });
}

async function listPlanDefinitions({ includeInactive = false, includeUsage = false } = {}) {
  await ensureDefaultPlans();
  const plans = await PlanDefinition.findAll({
    where: includeInactive ? {} : { is_active: true },
    order: [['sort_order', 'ASC'], ['name', 'ASC']],
  });

  if (!includeUsage) {
    return plans.map((plan) => mapPlanDefinition(plan));
  }

  const rows = await Organisation.findAll({
    attributes: [
      'plan',
      [sequelize.fn('COUNT', sequelize.col('id')), 'orgCount'],
    ],
    where: { deleted_at: null },
    group: ['plan'],
    raw: true,
  });
  const usageByPlan = rows.reduce((acc, row) => {
    acc[row.plan] = { orgCount: Number(row.orgCount || 0) };
    return acc;
  }, {});

  return plans.map((plan) => mapPlanDefinition(plan, usageByPlan[plan.code] || { orgCount: 0 }));
}

function normalizePlanPayload(payload = {}, codeFromPath = null) {
  const code = String(codeFromPath || payload.code || '').trim().toLowerCase();
  if (!PLAN_CODES.includes(code)) {
    const error = new Error('Plan must be trial, standard, or enterprise');
    error.code = 'PLAN_001';
    error.statusCode = 422;
    error.details = [{ field: 'code', message: 'Unsupported plan code' }];
    throw error;
  }

  const billingType = payload.billingType || payload.billing_type || 'per_employee';
  if (!['free', 'per_employee', 'flat', 'custom'].includes(billingType)) {
    const error = new Error('Invalid billing type');
    error.code = 'PLAN_002';
    error.statusCode = 422;
    error.details = [{ field: 'billingType', message: 'Billing type is invalid' }];
    throw error;
  }

  return {
    code,
    name: String(payload.name || code).trim(),
    description: payload.description || null,
    billing_type: billingType,
    monthly_price: toNumber(payload.monthlyPrice ?? payload.monthly_price),
    yearly_price: toNumber(payload.yearlyPrice ?? payload.yearly_price),
    price_per_employee: toNumber(payload.pricePerEmployee ?? payload.price_per_employee),
    trial_days: nullableInt(payload.trialDays ?? payload.trial_days) || 0,
    employee_limit: nullableInt(payload.employeeLimit ?? payload.employee_limit),
    branch_limit: nullableInt(payload.branchLimit ?? payload.branch_limit),
    manager_limit: nullableInt(payload.managerLimit ?? payload.manager_limit),
    storage_limit_mb: nullableInt(payload.storageLimitMb ?? payload.storage_limit_mb),
    attendance_retention_days: nullableInt(payload.attendanceRetentionDays ?? payload.attendance_retention_days),
    features: payload.features && typeof payload.features === 'object' ? payload.features : {},
    is_active: typeof payload.isActive === 'boolean' ? payload.isActive : true,
    is_public: typeof payload.isPublic === 'boolean' ? payload.isPublic : true,
    sort_order: nullableInt(payload.sortOrder ?? payload.sort_order) || 0,
    metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
  };
}

async function upsertPlanDefinition(payload, codeFromPath = null) {
  await ensureDefaultPlans();
  const values = normalizePlanPayload(payload, codeFromPath);
  const existing = await PlanDefinition.findOne({ where: { code: values.code } });

  if (existing) {
    await existing.update(values);
    return mapPlanDefinition(existing);
  }

  const created = await PlanDefinition.create(values);
  return mapPlanDefinition(created);
}

async function getOrgPlan(organisationOrOrgId, options = {}) {
  let organisation = organisationOrOrgId;
  if (!organisation || typeof organisationOrOrgId === 'string') {
    organisation = await Organisation.findOne({
      where: { id: organisationOrOrgId },
      transaction: options.transaction,
    });
  }

  if (!organisation) {
    return null;
  }

  let plan = null;
  if (organisation.plan_definition_id) {
    plan = await PlanDefinition.findOne({
      where: { id: organisation.plan_definition_id },
      transaction: options.transaction,
    });
  }

  if (!plan) {
    plan = await getPlanByCode(organisation.plan || 'trial', options);
  }

  return plan;
}

function calculateMonthlyAmount(plan, employeeCount = 0) {
  if (!plan) return 0;
  const billingType = plan.billing_type;
  if (billingType === 'per_employee') {
    return toNumber(plan.price_per_employee) * Number(employeeCount || 0);
  }
  if (billingType === 'flat') {
    return toNumber(plan.monthly_price);
  }
  return 0;
}

async function getBillingForOrganisation(organisation, employeeCount = 0) {
  const plan = await getOrgPlan(organisation);
  const mapped = mapPlanDefinition(plan);
  return {
    plan,
    mapped,
    monthlyAmount: calculateMonthlyAmount(plan, employeeCount),
    unitPrice: plan?.billing_type === 'per_employee' ? toNumber(plan.price_per_employee) : toNumber(plan?.monthly_price),
  };
}

function throwLimitError(resource, limit) {
  const error = new Error(`Your current plan allows only ${limit} ${resource}. Upgrade the organisation plan to continue.`);
  error.code = 'PLAN_LIMIT_REACHED';
  error.statusCode = 403;
  error.details = [{ field: resource, message: `${resource} limit reached` }];
  throw error;
}

const REPORT_LEVELS = ['none', 'basic', 'full', 'advanced'];

function isFeatureAllowed(features = {}, featureKey, expected = true) {
  if (!featureKey) return true;
  const value = features?.[featureKey];

  if (featureKey === 'reports') {
    const currentLevel = REPORT_LEVELS.indexOf(value || 'none');
    const expectedLevel = REPORT_LEVELS.indexOf(expected || 'basic');
    return currentLevel >= expectedLevel && currentLevel >= 0;
  }

  if (typeof expected === 'boolean') {
    return Boolean(value) === expected;
  }

  return value === expected;
}

function assertFeatureAllowed(features, featureKey, expected = true) {
  if (isFeatureAllowed(features, featureKey, expected)) return;

  const error = new Error('This feature is not available on the current organisation plan.');
  error.code = 'PLAN_FEATURE_DISABLED';
  error.statusCode = 403;
  error.details = [{ field: featureKey, message: `Feature ${featureKey} is not enabled for this plan` }];
  throw error;
}

async function assertOrgFeature(orgId, featureKey, expected = true) {
  const plan = await getOrgPlan(orgId);
  assertFeatureAllowed(plan?.features || {}, featureKey, expected);
}

async function assertEmployeeLimit(orgId, increment = 1) {
  const organisation = await Organisation.findOne({ where: { id: orgId } });
  const plan = await getOrgPlan(organisation);
  const limit = plan?.employee_limit;
  if (!limit) return;

  const count = await Employee.count({
    where: {
      org_id: orgId,
      role: { [Op.ne]: 'superadmin' },
    },
  });

  if (count + Number(increment || 1) > limit) {
    throwLimitError('employees', limit);
  }
}

async function assertManagerLimit(orgId, increment = 1) {
  const organisation = await Organisation.findOne({ where: { id: orgId } });
  const plan = await getOrgPlan(organisation);
  const limit = plan?.manager_limit;
  if (!limit) return;

  const count = await Employee.count({
    where: {
      org_id: orgId,
      role: 'manager',
    },
  });

  if (count + Number(increment || 1) > limit) {
    throwLimitError('managers', limit);
  }
}

async function assertBranchLimit(orgId, increment = 1) {
  const organisation = await Organisation.findOne({ where: { id: orgId } });
  const plan = await getOrgPlan(organisation);
  const limit = plan?.branch_limit;
  if (!limit) return;

  const count = await Branch.count({ where: { org_id: orgId } });
  if (count + Number(increment || 1) > limit) {
    throwLimitError('branches', limit);
  }
}

module.exports = {
  DEFAULT_PLAN_DEFINITIONS,
  PLAN_CODES,
  assertBranchLimit,
  assertEmployeeLimit,
  assertFeatureAllowed,
  assertOrgFeature,
  assertManagerLimit,
  calculateMonthlyAmount,
  ensureDefaultPlans,
  getBillingForOrganisation,
  getOrgPlan,
  getPlanByCode,
  isFeatureAllowed,
  listPlanDefinitions,
  mapPlanDefinition,
  planSnapshot,
  upsertPlanDefinition,
};
