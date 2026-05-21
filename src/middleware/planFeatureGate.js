const { fail } = require('../utils/response');
const planService = require('../modules/plan/plan.service');

function planFeatureGate(featureKey, expected = true) {
  return async (req, res, next) => {
    try {
      const orgId = req.org_id || req.employee?.orgId;
      if (!orgId) {
        return fail(res, 'PLAN_003', 'Organisation context is required for plan feature checks', [], 400);
      }

      await planService.assertOrgFeature(orgId, featureKey, expected);
      return next();
    } catch (error) {
      return fail(
        res,
        error.code || 'PLAN_FEATURE_DISABLED',
        error.message,
        error.details || [],
        error.statusCode || 403
      );
    }
  };
}

module.exports = planFeatureGate;
