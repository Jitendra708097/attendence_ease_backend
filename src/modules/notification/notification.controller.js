const { ok, fail } = require('../../utils/response');
const notificationService = require('./notification.service');

async function list(req, res) {
  try {
    const data = await notificationService.listNotifications({
      orgId: req.org_id,
      employeeId: req.employee.id,
      query: req.query,
    });

    return ok(res, data, 'Notifications fetched');
  } catch (error) {
    return fail(res, error.code || 'NOTIF_003', error.message, error.details || [], error.statusCode || 400);
  }
}

async function read(req, res) {
  try {
    const data = await notificationService.markAsRead({
      orgId: req.org_id,
      employeeId: req.employee.id,
      ids: req.body.ids,
      req,
    });

    return ok(res, data, 'Notifications marked as read');
  } catch (error) {
    return fail(res, error.code || 'NOTIF_004', error.message, error.details || [], error.statusCode || 400);
  }
}

async function readAll(req, res) {
  try {
    const data = await notificationService.markAllAsRead({
      orgId: req.org_id,
      employeeId: req.employee.id,
      req,
    });

    return ok(res, data, 'All notifications marked as read');
  } catch (error) {
    return fail(res, error.code || 'NOTIF_005', error.message, error.details || [], error.statusCode || 400);
  }
}

async function unreadCount(req, res) {
  try {
    const data = await notificationService.getUnreadCount({
      orgId: req.org_id,
      employeeId: req.employee.id,
    });

    return ok(res, data, 'Unread count fetched');
  } catch (error) {
    return fail(res, error.code || 'NOTIF_006', error.message, error.details || [], error.statusCode || 400);
  }
}

async function registerToken(req, res) {
  try {
    const data = await notificationService.registerToken({
      orgId: req.org_id,
      employeeId: req.employee.id,
      body: req.body,
      req,
    });

    return ok(res, data, 'Notification token registered');
  } catch (error) {
    return fail(res, error.code || 'NOTIF_001', error.message, error.details || [], error.statusCode || 400);
  }
}

module.exports = {
  list,
  read,
  readAll,
  unreadCount,
  registerToken,
};
