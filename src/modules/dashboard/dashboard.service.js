const { Op } = require('sequelize');
const { Attendance, AttendanceSession, AuditLog, Branch, Department, DeviceException, Employee, LeaveRequest, Organisation, PaymentRecord, Regularisation, Shift } = require('../../models');

function getDatePartsInTimezone(value, timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(value).reduce((accumulator, part) => {
    if (part.type !== 'literal') {
      accumulator[part.type] = part.value;
    }
    return accumulator;
  }, {});

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function formatDateParts(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function getDateStringInTimezone(value, timezone) {
  return formatDateParts(getDatePartsInTimezone(value, timezone));
}

function getDateRangeDays(days, timezone) {
  const dates = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const value = new Date();
    value.setUTCDate(value.getUTCDate() - offset);
    dates.push(getDateStringInTimezone(value, timezone));
  }
  return dates;
}

function getStartOfToday(timezone) {
  const today = getDatePartsInTimezone(new Date(), timezone);
  return new Date(Date.UTC(today.year, today.month - 1, today.day, 0, 0, 0, 0));
}

function isValidGeofence(polygons) {
  return Array.isArray(polygons) && polygons.length >= 3;
}

function percent(value, total) {
  if (!total) return 0;
  return Math.round((Number(value || 0) / Number(total)) * 100);
}

function isEmployeeFaceEnrolled(employee) {
  return Boolean(employee.face_embedding_id);
}

function incrementStatus(target, attendance) {
  const status = attendance.status || 'not_marked';
  target[status] = (target[status] || 0) + 1;
  if (attendance.is_late) target.late = (target.late || 0) + 1;
  if (attendance.first_check_in) target.checkedIn = (target.checkedIn || 0) + 1;
  if (attendance.last_check_out) target.checkedOut = (target.checkedOut || 0) + 1;
  if (attendance.is_manual) target.manual = (target.manual || 0) + 1;
  if (attendance.is_anomaly) target.anomalies = (target.anomalies || 0) + 1;
}

function buildStatusCounts(rows, activeEmployeeCount, openSessionEmployeeIds) {
  const counts = rows.reduce(
    (accumulator, attendance) => {
      incrementStatus(accumulator, attendance);
      return accumulator;
    },
    {
      present: 0,
      pending: 0,
      absent: 0,
      half_day: 0,
      half_day_early: 0,
      on_leave: 0,
      holiday: 0,
      weekend: 0,
      incomplete: 0,
      not_marked: 0,
      regularisation_pending: 0,
      late: 0,
      checkedIn: 0,
      checkedOut: 0,
      manual: 0,
      anomalies: 0,
    }
  );

  const markedEmployeeIds = new Set(rows.map((attendance) => attendance.emp_id));
  const notMarked = Math.max(activeEmployeeCount - markedEmployeeIds.size, 0);

  return {
    employeeCount: activeEmployeeCount,
    checkedInCount: counts.checkedIn,
    checkedOutCount: counts.checkedOut,
    stillCheckedInCount: openSessionEmployeeIds.size,
    presentCount: counts.present,
    absentCount: counts.absent + notMarked,
    recordedAbsentCount: counts.absent,
    notMarkedCount: notMarked,
    pendingCount: counts.pending,
    leaveCount: counts.on_leave,
    lateCount: counts.late,
    halfDayCount: counts.half_day + counts.half_day_early,
    incompleteCount: counts.incomplete,
    manualOverrideCount: counts.manual,
    anomalyCount: counts.anomalies,
  };
}

function getSettings(organisation) {
  const settings = organisation?.settings && typeof organisation.settings === 'object' ? organisation.settings : {};
  return {
    attendance: settings.attendance && typeof settings.attendance === 'object' ? settings.attendance : {},
    notifications: settings.notifications && typeof settings.notifications === 'object' ? settings.notifications : {},
  };
}

function buildHealth({ organisation, activeEmployees, branches, shifts }) {
  const settings = getSettings(organisation);
  const faceEnrolledCount = activeEmployees.filter(isEmployeeFaceEnrolled).length;
  const branchesMissingGeofence = branches.filter((branch) => !branch.is_remote && !isValidGeofence(branch.geo_fence_polygons));
  const employeesWithoutFace = activeEmployees.length - faceEnrolledCount;
  const employeesWithoutBranch = activeEmployees.filter((employee) => !employee.branch_id).length;
  const employeesWithoutShift = activeEmployees.filter((employee) => !employee.shift_id).length;
  const notificationValues = Object.values(settings.notifications);
  const enabledNotifications = notificationValues.filter(Boolean).length;

  return {
    faceEnrollmentCoverage: percent(faceEnrolledCount, activeEmployees.length),
    faceEnrolledCount,
    employeesWithoutFace,
    geofenceCoverage: percent(branches.length - branchesMissingGeofence.length, branches.length),
    branchesMissingGeofence: branchesMissingGeofence.length,
    employeesWithoutBranch,
    employeesWithoutShift,
    shiftCount: shifts.length,
    kioskModeEnabled: Boolean(settings.attendance.kioskModeEnabled),
    kioskRequiresOfficeGeofence: settings.attendance.kioskRequiresOfficeGeofence !== false,
    notificationsEnabledCount: enabledNotifications,
    notificationChannelCount: notificationValues.length,
    checks: [
      {
        key: 'face_enrollment',
        status: employeesWithoutFace > 0 ? 'warning' : 'ok',
        title: 'Face enrollment',
        message: employeesWithoutFace > 0
          ? `${employeesWithoutFace} active employees do not have a registered face.`
          : 'All active employees have registered faces.',
        actionUrl: '/employees?face=missing',
      },
      {
        key: 'geofence',
        status: branchesMissingGeofence.length > 0 ? 'warning' : 'ok',
        title: 'Branch geofence',
        message: branchesMissingGeofence.length > 0
          ? `${branchesMissingGeofence.length} office branches need a valid geofence.`
          : 'All office branches have geofence coverage.',
        actionUrl: '/branches',
      },
      {
        key: 'shift_assignment',
        status: employeesWithoutShift > 0 ? 'warning' : 'ok',
        title: 'Shift assignment',
        message: employeesWithoutShift > 0
          ? `${employeesWithoutShift} active employees are missing a shift.`
          : 'All active employees are assigned to shifts.',
        actionUrl: '/employees',
      },
      {
        key: 'kiosk_mode',
        status: settings.attendance.kioskModeEnabled ? 'ok' : 'info',
        title: 'Kiosk mode',
        message: settings.attendance.kioskModeEnabled
          ? 'Kiosk attendance is enabled for the organisation.'
          : 'Kiosk mode is currently disabled in settings.',
        actionUrl: '/settings?tab=attendance',
      },
    ],
  };
}

function buildBreakdown({ activeEmployees, attendanceRows, branches, departments }) {
  const employeeById = new Map(activeEmployees.map((employee) => [String(employee.id), employee]));
  const branchItems = branches.map((branch) => ({
    id: branch.id,
    name: branch.name,
    employeeCount: activeEmployees.filter((employee) => String(employee.branch_id) === String(branch.id)).length,
    present: 0,
    absent: 0,
    late: 0,
    notMarked: 0,
  }));
  const departmentItems = departments.map((department) => ({
    id: department.id,
    name: department.name,
    employeeCount: activeEmployees.filter((employee) => String(employee.department_id) === String(department.id)).length,
    present: 0,
    absent: 0,
    late: 0,
    notMarked: 0,
  }));

  const branchById = new Map(branchItems.map((branch) => [String(branch.id), branch]));
  const departmentById = new Map(departmentItems.map((department) => [String(department.id), department]));
  const markedByBranch = new Map();
  const markedByDepartment = new Map();

  attendanceRows.forEach((attendance) => {
    const branch = branchById.get(String(attendance.branch_id));
    const employee = employeeById.get(String(attendance.emp_id));
    const department = employee?.department_id ? departmentById.get(String(employee.department_id)) : null;

    if (branch) {
      markedByBranch.set(String(branch.id), (markedByBranch.get(String(branch.id)) || 0) + 1);
      if (attendance.status === 'present') branch.present += 1;
      if (attendance.status === 'absent') branch.absent += 1;
      if (attendance.is_late) branch.late += 1;
    }

    if (department) {
      markedByDepartment.set(String(department.id), (markedByDepartment.get(String(department.id)) || 0) + 1);
      if (attendance.status === 'present') department.present += 1;
      if (attendance.status === 'absent') department.absent += 1;
      if (attendance.is_late) department.late += 1;
    }
  });

  branchItems.forEach((branch) => {
    branch.notMarked = Math.max(branch.employeeCount - (markedByBranch.get(String(branch.id)) || 0), 0);
    branch.absent += branch.notMarked;
  });
  departmentItems.forEach((department) => {
    department.notMarked = Math.max(department.employeeCount - (markedByDepartment.get(String(department.id)) || 0), 0);
    department.absent += department.notMarked;
  });

  return {
    branches: branchItems
      .filter((branch) => branch.employeeCount > 0)
      .sort((left, right) => right.employeeCount - left.employeeCount)
      .slice(0, 6),
    departments: departmentItems
      .filter((department) => department.employeeCount > 0)
      .sort((left, right) => right.employeeCount - left.employeeCount)
      .slice(0, 6),
  };
}

function buildActivity(rows) {
  const labels = {
    'attendance.check_in': 'Checked in',
    'attendance.check_out': 'Checked out',
    'attendance.manual_mark': 'Manual attendance updated',
    'leave.approved': 'Leave approved',
    'leave.rejected': 'Leave rejected',
    'device_exception.approved': 'Device exception approved',
    'org.settings.update': 'Organisation settings changed',
  };

  return rows.map((row) => ({
    id: String(row.id),
    action: row.action,
    label: labels[row.action] || String(row.action || 'Activity').replace(/[._]/g, ' '),
    entityType: row.entity_type,
    entityId: row.entity_id,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    createdAt: row.created_at,
  }));
}

async function buildBillingSummary(orgId) {
  const latestPayment = await PaymentRecord.findOne({
    where: { org_id: orgId },
    order: [['created_at', 'DESC']],
  });

  return {
    latestInvoiceId: latestPayment?.invoice_id || null,
    latestStatus: latestPayment?.status || null,
    latestAmount: latestPayment ? Number(latestPayment.amount_paise || 0) / 100 : 0,
    lastPaidAt: latestPayment?.created_at || null,
    hasOverdueInvoice: false,
  };
}

async function getAdminSummary(orgId) {
  const organisation = await Organisation.findOne({ where: { id: orgId } });
  if (!organisation) {
    const error = new Error('Organisation not found');
    error.statusCode = 404;
    error.code = 'HTTP_404';
    throw error;
  }

  const timezone = organisation.timezone || 'Asia/Kolkata';
  const today = getDateStringInTimezone(new Date(), timezone);
  const trendDates = getDateRangeDays(30, timezone);
  const startOfToday = getStartOfToday(timezone);

  const [
    activeEmployees,
    branches,
    departments,
    shifts,
    todayAttendanceRows,
    trendRows,
    pendingLeaves,
    pendingRegularisations,
    pendingDeviceExceptions,
    recentAuditRows,
    billing,
  ] = await Promise.all([
    Employee.findAll({
      where: { org_id: orgId, is_active: true, role: { [Op.ne]: 'superadmin' } },
      attributes: [
        'id',
        'name',
        'branch_id',
        'department_id',
        'shift_id',
        'is_face_enrolled',
        'face_embedding_id',
      ],
    }),
    Branch.findAll({ where: { org_id: orgId }, attributes: ['id', 'name', 'geo_fence_polygons', 'is_remote'] }),
    Department.findAll({ where: { org_id: orgId }, attributes: ['id', 'name'] }),
    Shift.findAll({ where: { org_id: orgId }, attributes: ['id', 'name'] }),
    Attendance.findAll({
      where: { org_id: orgId, date: today },
      include: [
        {
          model: Employee,
          as: 'employee',
          attributes: [],
          required: true,
          where: { is_active: true, role: { [Op.ne]: 'superadmin' } },
        },
      ],
      attributes: [
        'id',
        'emp_id',
        'branch_id',
        'status',
        'first_check_in',
        'last_check_out',
        'is_late',
        'is_manual',
        'is_anomaly',
      ],
    }),
    Attendance.findAll({
      where: {
        org_id: orgId,
        date: { [Op.between]: [trendDates[0], trendDates[trendDates.length - 1]] },
      },
      include: [
        {
          model: Employee,
          as: 'employee',
          attributes: [],
          required: true,
          where: { is_active: true, role: { [Op.ne]: 'superadmin' } },
        },
      ],
      attributes: ['date', 'status', 'is_late'],
      order: [['date', 'ASC']],
    }),
    LeaveRequest.count({ where: { org_id: orgId, status: 'pending' } }),
    Regularisation.count({ where: { org_id: orgId, status: { [Op.in]: ['pending', 'manager_approved'] } } }),
    DeviceException.count({ where: { org_id: orgId, status: 'pending' } }),
    AuditLog.findAll({
      where: { org_id: orgId, created_at: { [Op.gte]: startOfToday } },
      order: [['created_at', 'DESC']],
      limit: 10,
    }),
    buildBillingSummary(orgId),
  ]);

  const attendanceIds = todayAttendanceRows.map((attendance) => attendance.id);
  const openSessions = attendanceIds.length > 0
    ? await AttendanceSession.findAll({
        where: { attendance_id: { [Op.in]: attendanceIds }, status: 'open' },
        attributes: ['emp_id'],
      })
    : [];
  const openSessionEmployeeIds = new Set(openSessions.map((session) => String(session.emp_id)));

  const todayStats = buildStatusCounts(todayAttendanceRows, activeEmployees.length, openSessionEmployeeIds);
  const trend = trendDates.map((date) => {
    const dayRows = trendRows.filter((row) => row.date === date);
    return {
      date,
      present: dayRows.filter((row) => row.status === 'present').length,
      absent: dayRows.filter((row) => row.status === 'absent').length,
      leave: dayRows.filter((row) => row.status === 'on_leave').length,
      late: dayRows.filter((row) => row.is_late).length,
    };
  });

  const lateByEmployee = todayAttendanceRows
    .filter((row) => row.is_late)
    .reduce((accumulator, attendance) => {
      const key = String(attendance.emp_id);
      const employee = activeEmployees.find((item) => String(item.id) === key);
      if (!accumulator[key]) {
        accumulator[key] = { empId: attendance.emp_id, name: employee?.name || 'Unknown', count: 0 };
      }
      accumulator[key].count += 1;
      return accumulator;
    }, {});

  return {
    organisation: {
      id: organisation.id,
      name: organisation.name,
      timezone,
      plan: organisation.plan,
    },
    today,
    todayStats,
    pending: {
      leaves: pendingLeaves,
      regularisations: pendingRegularisations,
      deviceExceptions: pendingDeviceExceptions,
      total: pendingLeaves + pendingRegularisations + pendingDeviceExceptions,
    },
    health: buildHealth({ organisation, activeEmployees, branches, shifts }),
    breakdown: buildBreakdown({ activeEmployees, attendanceRows: todayAttendanceRows, branches, departments }),
    trend,
    topLateEmployees: Object.values(lateByEmployee).sort((left, right) => right.count - left.count).slice(0, 5),
    recentActivity: buildActivity(recentAuditRows),
    billing,
  };
}

module.exports = { getAdminSummary };
