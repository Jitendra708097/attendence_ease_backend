const { Op } = require('sequelize');
const { Attendance, Employee, Holiday, LeaveRequest, Organisation, Shift } = require('../../models');
const { autoAbsent } = require('../index');
const { scheduleDailyJobs } = require('../schedulers/daily.scheduler');

let workerRegistered = false;

function getWeekdayNumber(dateString) {
  const value = new Date(`${dateString}T00:00:00.000Z`).getUTCDay();
  return value === 0 ? 7 : value;
}

async function getApprovedLeaveEmployeeIds(orgId, dateString) {
  const leaves = await LeaveRequest.findAll({
    where: {
      org_id: orgId,
      status: 'approved',
      from_date: {
        [Op.lte]: dateString,
      },
      to_date: {
        [Op.gte]: dateString,
      },
    },
    attributes: ['emp_id'],
  });

  return new Set(leaves.map((leave) => leave.emp_id));
}

async function getHolidayBranchIds(orgId, dateString) {
  const holidays = await Holiday.findAll({
    where: {
      org_id: orgId,
      date: dateString,
    },
    attributes: ['branch_id'],
  });

  return {
    orgWide: holidays.some((holiday) => !holiday.branch_id),
    branchIds: new Set(holidays.filter((holiday) => holiday.branch_id).map((holiday) => holiday.branch_id)),
  };
}

async function processAutoAbsent(job) {
  const { orgId, shiftId, dateString } = job.data;

  if (!orgId || !shiftId || !dateString) {
    return {
      created: 0,
      reason: 'invalid_payload',
    };
  }

  const shift = await Shift.findOne({
    where: {
      id: shiftId,
      org_id: orgId,
    },
  });

  if (!shift) {
    return {
      created: 0,
      reason: 'shift_not_found',
    };
  }

  const weekday = getWeekdayNumber(dateString);
  const workDays = Array.isArray(shift.work_days) ? shift.work_days : [];
  if (workDays.length > 0 && !workDays.includes(weekday)) {
    return {
      created: 0,
      reason: 'non_working_day',
    };
  }

  const employees = await Employee.findAll({
    where: {
      org_id: orgId,
      shift_id: shiftId,
      is_active: true,
    },
    attributes: ['id', 'branch_id'],
  });

  if (employees.length === 0) {
    return {
      created: 0,
      reason: 'no_employees',
    };
  }

  const existingRows = await Attendance.findAll({
    where: {
      org_id: orgId,
      shift_id: shiftId,
      date: dateString,
    },
    attributes: ['emp_id'],
  });

  const existingEmpIds = new Set(existingRows.map((row) => row.emp_id));
  const leaveEmpIds = await getApprovedLeaveEmployeeIds(orgId, dateString);
  const holidayInfo = await getHolidayBranchIds(orgId, dateString);

  const candidates = employees.filter((employee) => {
    if (existingEmpIds.has(employee.id)) {
      return false;
    }

    if (leaveEmpIds.has(employee.id)) {
      return false;
    }

    if (holidayInfo.orgWide) {
      return false;
    }

    if (employee.branch_id && holidayInfo.branchIds.has(employee.branch_id)) {
      return false;
    }

    return true;
  });

  if (candidates.length === 0) {
    return {
      created: 0,
    };
  }

  await Attendance.bulkCreate(
    candidates.map((employee) => ({
      org_id: orgId,
      emp_id: employee.id,
      shift_id: shiftId,
      date: dateString,
      status: 'absent',
      session_count: 0,
      total_worked_minutes: 0,
      is_finalised: true,
    })),
    {
      ignoreDuplicates: true,
    }
  );

  return {
    created: candidates.length,
  };
}

async function processDailyScheduleJob() {
  return scheduleDailyJobs(new Date());
}

async function warmStartDailySchedule() {
  const activeOrganisations = await Organisation.count({
    where: {
      is_active: true,
    },
  });

  if (activeOrganisations === 0) {
    return [];
  }

  return scheduleDailyJobs(new Date());
}

function registerAutoAbsentWorker() {
  if (workerRegistered) {
    return autoAbsent;
  }

  autoAbsent.process('auto_absent', processAutoAbsent);
  autoAbsent.process('daily_schedule_org_shifts', processDailyScheduleJob);
  autoAbsent.on('failed', (job, error) => {
    console.error('[queue:auto-absent] Job failed:', {
      jobId: job && job.id ? job.id : null,
      name: job && job.name ? job.name : null,
      message: error.message,
    });
  });

  warmStartDailySchedule().catch((error) => {
    console.error('[queue:auto-absent] Warm start scheduling failed:', error.message);
  });

  workerRegistered = true;
  return autoAbsent;
}

module.exports = {
  registerAutoAbsentWorker,
};
