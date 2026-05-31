const { ok, fail } = require('../../utils/response');
const { log } = require('../../utils/auditLog');
const feedbackService = require('./feedback.service');

async function submit(req, res) {
  try {
    const data = await feedbackService.submitFeedback({
      orgId: req.org_id,
      empId: req.employee.id,
      payload: req.body,
    });

    await log(req.employee, 'feedback.submit', { type: 'user_feedback', id: data.id }, null, data, req);
    return ok(res, data, 'Feedback submitted', 201);
  } catch (error) {
    return fail(res, error.code || 'FDB_002', error.message, error.details || [], error.statusCode || 400);
  }
}

module.exports = {
  submit,
};
