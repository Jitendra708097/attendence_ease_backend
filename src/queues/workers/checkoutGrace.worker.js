const { Attendance, AttendanceSession } = require('../../models');
const { redisClient } = require('../../config/redis');
const { checkoutGrace } = require('../index');

function getUndoKey(orgId, empId, sessionId) {
  return `attendance_undo:${orgId}:${empId}:${sessionId}`;
}

let workerRegistered = false;

async function expireCheckoutGrace(job) {
  const { orgId, empId, attendanceId, sessionId } = job.data;

  if (!orgId || !empId || !attendanceId || !sessionId) {
    return {
      expired: false,
      reason: 'invalid_payload',
    };
  }

  const session = await AttendanceSession.findOne({
    where: {
      id: sessionId,
      attendance_id: attendanceId,
      org_id: orgId,
    },
  });

  if (!session || !session.check_out_time) {
    return {
      expired: false,
      reason: 'session_not_completed',
    };
  }

  await redisClient.del(getUndoKey(orgId, empId, sessionId));

  const openSession = await AttendanceSession.findOne({
    where: {
      attendance_id: attendanceId,
      org_id: orgId,
      status: 'open',
    },
  });

  if (!openSession) {
    const attendance = await Attendance.findOne({
      where: {
        id: attendanceId,
        org_id: orgId,
      },
    });

    if (attendance) {
      await attendance.update({
        is_finalised: true,
      });
    }
  }

  return {
    expired: true,
    attendanceId,
    sessionId,
  };
}

function registerCheckoutGraceWorker() {
  if (workerRegistered) {
    return checkoutGrace;
  }

  checkoutGrace.process('checkout_grace_expiry', expireCheckoutGrace);
  checkoutGrace.on('failed', (job, error) => {
    console.error('[queue:checkout-grace] Job failed:', {
      jobId: job && job.id ? job.id : null,
      message: error.message,
    });
  });

  workerRegistered = true;
  return checkoutGrace;
}

module.exports = {
  registerCheckoutGraceWorker,
};
