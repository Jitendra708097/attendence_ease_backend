const { ok, fail } = require('../../utils/response');
const attendanceService = require('./attendance.service');

async function challenge(req, res) {
  try {
    const data = await attendanceService.requestChallenge(req.org_id, req.employee.id);
    return ok(res, data, 'Challenge generated');
  } catch (error) {
    return fail(res, error.code || 'ATT_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function checkIn(req, res) {
  try {
    const data = await attendanceService.checkIn({
      orgId: req.org_id,
      empId: req.employee.id,
      body: req.body,
      req,
    });
    return ok(res, data, 'Check-in successful');
  } catch (error) {
    return fail(res, error.code || 'ATT_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function checkOut(req, res) {
  try {
    const data = await attendanceService.checkOut({
      orgId: req.org_id,
      empId: req.employee.id,
      body: req.body,
      req,
    });
    return ok(res, data, 'Check-out successful');
  } catch (error) {
    return fail(res, error.code || 'ATT_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function undoCheckout(req, res) {
  try {
    const data = await attendanceService.undoCheckout({
      orgId: req.org_id,
      empId: req.employee.id,
      req,
    });
    return ok(res, data, 'Checkout undone');
  } catch (error) {
    return fail(res, error.code || 'ATT_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function today(req, res) {
  try {
    const data = await attendanceService.getTodayState(req.org_id, req.employee.id);
    return ok(res, data, 'Attendance status fetched');
  } catch (error) {
    return fail(res, error.code || 'ATT_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function list(req, res) {
  try {
    const data = await attendanceService.listAttendance(req.org_id, req.query);
    return ok(res, data, 'Attendance list fetched');
  } catch (error) {
    return fail(res, error.code || 'ATT_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function history(req, res) {
  try {
    const data = await attendanceService.getAttendanceHistory(req.org_id, req.employee.id, req.query);
    return ok(res, data, 'Attendance history fetched');
  } catch (error) {
    return fail(res, error.code || 'ATT_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function getById(req, res) {
  try {
    const data = await attendanceService.getAttendanceById(req.org_id, req.params.id);
    return ok(res, data, 'Attendance detail fetched');
  } catch (error) {
    return fail(res, error.code || 'HTTP_404', error.message, error.details || [], error.statusCode || 400);
  }
}

async function manual(req, res) {
  try {
    const data = await attendanceService.manualMark({
      orgId: req.org_id,
      id: req.params.id,
      body: req.body,
      req,
    });
    return ok(res, data, 'Attendance updated manually');
  } catch (error) {
    return fail(res, error.code || 'ATT_012', error.message, error.details || [], error.statusCode || 400);
  }
}

async function live(req, res) {
  try {
    const data = await attendanceService.getLiveBoard(req.org_id, req.query);
    return ok(res, data, 'Live attendance feed fetched');
  } catch (error) {
    return fail(res, error.code || 'ATT_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function statsToday(req, res) {
  try {
    const data = await attendanceService.getTodayStats(req.org_id);
    return ok(res, data, 'Attendance stats fetched');
  } catch (error) {
    return fail(res, error.code || 'ATT_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function trend(req, res) {
  try {
    const data = await attendanceService.getTrendStats(req.org_id, req.query);
    return ok(res, data, 'Attendance trend fetched');
  } catch (error) {
    return fail(res, error.code || 'ATT_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function topLate(req, res) {
  try {
    const data = await attendanceService.getTopLateEmployees(req.org_id, req.query);
    return ok(res, data, 'Top late employees fetched');
  } catch (error) {
    return fail(res, error.code || 'ATT_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function activity(req, res) {
  try {
    const data = await attendanceService.getRecentActivity(req.org_id, req.query);
    return ok(res, data, 'Recent activity fetched');
  } catch (error) {
    return fail(res, error.code || 'ATT_001', error.message, error.details || [], error.statusCode || 400);
  }
}

module.exports = {
  challenge,
  checkIn,
  checkOut,
  undoCheckout,
  today,
  list,
  history,
  getById,
  manual,
  live,
  statsToday,
  trend,
  topLate,
  activity,
};
