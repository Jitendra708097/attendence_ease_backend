const { AuditLog } = require('../models');

async function log(actor, action, entity, oldVal, newVal, req) {
  await AuditLog.create({
    org_id: actor?.orgId || null,
    actor_id: actor?.id || null,
    actor_role: actor?.role || null,
    action,
    entity_type: entity?.type || null,
    entity_id: entity?.id || null,
    old_value: oldVal || null,
    new_value: newVal || null,
    ip_address: req.ip,
    user_agent: req.headers['user-agent'],
    impersonated_by: req.employee?.impersonatedBy || null,
  });
}

module.exports = {
  log,
};
