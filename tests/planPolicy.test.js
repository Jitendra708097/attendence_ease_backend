const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertFeatureAllowed,
  calculateMonthlyAmount,
  isFeatureAllowed,
} = require('../src/modules/plan/plan.service');

test('per employee plan billing multiplies active employee count', () => {
  const amount = calculateMonthlyAmount(
    { billing_type: 'per_employee', price_per_employee: 100 },
    42
  );

  assert.equal(amount, 4200);
});

test('flat plan billing uses monthly price', () => {
  const amount = calculateMonthlyAmount(
    { billing_type: 'flat', monthly_price: 5000, price_per_employee: 100 },
    42
  );

  assert.equal(amount, 5000);
});

test('custom and free plans do not auto-generate monthly invoice amount', () => {
  assert.equal(calculateMonthlyAmount({ billing_type: 'custom', monthly_price: 9999 }, 10), 0);
  assert.equal(calculateMonthlyAmount({ billing_type: 'free', price_per_employee: 999 }, 10), 0);
});

test('boolean feature gates allow enabled features only', () => {
  assert.equal(isFeatureAllowed({ leave_management: true }, 'leave_management'), true);
  assert.equal(isFeatureAllowed({ leave_management: false }, 'leave_management'), false);
});

test('report feature gates respect basic, full, advanced order', () => {
  assert.equal(isFeatureAllowed({ reports: 'basic' }, 'reports', 'basic'), true);
  assert.equal(isFeatureAllowed({ reports: 'basic' }, 'reports', 'full'), false);
  assert.equal(isFeatureAllowed({ reports: 'full' }, 'reports', 'basic'), true);
  assert.equal(isFeatureAllowed({ reports: 'advanced' }, 'reports', 'full'), true);
});

test('feature gate throws a production-safe plan error when disabled', () => {
  assert.throws(
    () => assertFeatureAllowed({ integrations: false }, 'integrations'),
    (error) => error.code === 'PLAN_FEATURE_DISABLED' && error.statusCode === 403
  );
});
