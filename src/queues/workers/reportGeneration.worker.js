const XLSX = require('xlsx');
const { Op } = require('sequelize');
const { reportGeneration } = require('../index');
const { Attendance, AttendanceSession, Branch, Department, Employee, LeaveRequest } = require('../../models');
const { sendPush } = require('../../modules/notification/notification.service');

let workerRegistered = false;

function getTodayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function getMonthStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

function normalizeDate(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }

  return parsed.toISOString().slice(0, 10);
}

function normalizeFilters(filters = {}) {
  const dateFrom = normalizeDate(filters.dateFrom || filters.fromDate || filters.startDate, getMonthStart());
  const dateTo = normalizeDate(filters.dateTo || filters.toDate || filters.endDate, getTodayDateString());

  return {
    dateFrom: dateFrom <= dateTo ? dateFrom : dateTo,
    dateTo: dateFrom <= dateTo ? dateTo : dateFrom,
    branchId: filters.branchId || filters.branch || null,
    departmentId: filters.departmentId || filters.department || null,
    employeeId: filters.employeeId || filters.empId || null,
    status: filters.status || null,
  };
}

function getDateRange(dateFrom, dateTo) {
  const dates = [];
  const cursor = new Date(`${dateFrom}T00:00:00.000Z`);
  const end = new Date(`${dateTo}T00:00:00.000Z`);

  while (cursor <= end && dates.length <= 370) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
}

function formatDateTime(value) {
  return value ? new Date(value).toISOString() : '';
}

function minutesToHours(minutes) {
  return Number((Number(minutes || 0) / 60).toFixed(2));
}

function valueOrBlank(value) {
  return value == null ? '' : value;
}

function buildEmployeeWhere(orgId, filters) {
  const where = {
    org_id: orgId,
    is_active: true,
    role: {
      [Op.in]: ['admin', 'manager', 'employee'],
    },
  };

  if (filters.branchId) {
    where.branch_id = filters.branchId;
  }
  if (filters.departmentId) {
    where.department_id = filters.departmentId;
  }
  if (filters.employeeId) {
    where.id = filters.employeeId;
  }

  return where;
}

async function getEmployeeScope(orgId, filters) {
  const employees = await Employee.findAll({
    where: buildEmployeeWhere(orgId, filters),
    include: [
      { model: Branch, as: 'branch', attributes: ['id', 'name'], required: false },
      { model: Department, as: 'department', attributes: ['id', 'name'], required: false },
    ],
    order: [['name', 'ASC']],
  });

  return {
    employees,
    employeeIds: employees.map((employee) => employee.id),
    employeeById: employees.reduce((accumulator, employee) => {
      accumulator[employee.id] = employee;
      return accumulator;
    }, {}),
  };
}

async function getAttendanceRows(orgId, filters, employeeIds) {
  if (employeeIds.length === 0) {
    return [];
  }

  const where = {
    org_id: orgId,
    emp_id: { [Op.in]: employeeIds },
    date: { [Op.between]: [filters.dateFrom, filters.dateTo] },
  };

  if (filters.status && filters.status !== 'not_marked') {
    where.status = filters.status;
  }

  return Attendance.findAll({
    where,
    include: [
      {
        model: Employee,
        as: 'employee',
        attributes: ['id', 'name', 'emp_code', 'email', 'branch_id', 'department_id'],
        required: false,
      },
      {
        model: AttendanceSession,
        as: 'sessions',
        required: false,
      },
    ],
    order: [
      ['date', 'ASC'],
      [{ model: Employee, as: 'employee' }, 'name', 'ASC'],
    ],
  });
}

function getEmployeeMeta(employee) {
  return {
    employeeName: employee?.name || 'Unknown',
    employeeCode: employee?.emp_code || '',
    email: employee?.email || '',
    branchName: employee?.branch?.name || '',
    departmentName: employee?.department?.name || '',
  };
}

function attendanceToRow(attendance, employeeById) {
  const employee = employeeById[attendance.emp_id] || attendance.employee;
  const meta = getEmployeeMeta(employee);
  const sessions = Array.isArray(attendance.sessions) ? attendance.sessions : [];
  const firstSession = sessions[0] || null;
  const lastSession = sessions.length > 0 ? sessions[sessions.length - 1] : null;

  return {
    Date: attendance.date,
    'Employee Code': meta.employeeCode,
    Employee: meta.employeeName,
    Email: meta.email,
    Branch: meta.branchName,
    Department: meta.departmentName,
    Status: attendance.status,
    'First Check In': formatDateTime(attendance.first_check_in || firstSession?.check_in_time),
    'Last Check Out': formatDateTime(attendance.last_check_out || lastSession?.check_out_time),
    Sessions: Number(attendance.session_count || sessions.length || 0),
    'Worked Minutes': Number(attendance.total_worked_minutes || 0),
    'Worked Hours': minutesToHours(attendance.total_worked_minutes),
    Late: attendance.is_late ? 'Yes' : 'No',
    'Late By Minutes': Number(attendance.late_by_minutes || 0),
    Overtime: attendance.is_overtime ? 'Yes' : 'No',
    'Overtime Minutes': Number(attendance.overtime_minutes || 0),
    'Face Score': valueOrBlank(attendance.face_match_score),
    Source: attendance.source || 'self',
    Anomaly: attendance.is_anomaly ? 'Yes' : 'No',
    Manual: attendance.is_manual ? 'Yes' : 'No',
  };
}

function buildSummaryRows({ employees, attendanceRows, dateRange }) {
  const summaryByEmployee = employees.reduce((accumulator, employee) => {
    accumulator[employee.id] = {
      ...getEmployeeMeta(employee),
      totalDays: dateRange.length,
      present: 0,
      absent: 0,
      halfDay: 0,
      onLeave: 0,
      late: 0,
      overtime: 0,
      workedMinutes: 0,
    };
    return accumulator;
  }, {});
  const attendanceByEmployeeDate = new Map();

  attendanceRows.forEach((attendance) => {
    attendanceByEmployeeDate.set(`${attendance.emp_id}:${attendance.date}`, attendance);
  });

  employees.forEach((employee) => {
    dateRange.forEach((date) => {
      const attendance = attendanceByEmployeeDate.get(`${employee.id}:${date}`);
      const summary = summaryByEmployee[employee.id];

      if (!summary) {
        return;
      }

      if (!attendance) {
        summary.absent += 1;
        return;
      }

      if (attendance.status === 'present' || attendance.status === 'pending') summary.present += 1;
      if (attendance.status === 'absent' || attendance.status === 'not_marked') summary.absent += 1;
      if (attendance.status === 'half_day' || attendance.status === 'half_day_early') summary.halfDay += 1;
      if (attendance.status === 'on_leave') summary.onLeave += 1;
      if (attendance.is_late) summary.late += 1;
      if (attendance.is_overtime) summary.overtime += 1;
      summary.workedMinutes += Number(attendance.total_worked_minutes || 0);
    });
  });

  return Object.values(summaryByEmployee).map((summary) => ({
    'Employee Code': summary.employeeCode,
    Employee: summary.employeeName,
    Email: summary.email,
    Branch: summary.branchName,
    Department: summary.departmentName,
    'Calendar Days': summary.totalDays,
    Present: summary.present,
    Absent: summary.absent,
    'Half Days': summary.halfDay,
    'On Leave': summary.onLeave,
    Late: summary.late,
    Overtime: summary.overtime,
    'Worked Minutes': summary.workedMinutes,
    'Worked Hours': minutesToHours(summary.workedMinutes),
  }));
}

function buildAbsentRows({ employees, attendanceRows, dateRange }) {
  const attendanceByEmployeeDate = new Map();
  attendanceRows.forEach((attendance) => {
    attendanceByEmployeeDate.set(`${attendance.emp_id}:${attendance.date}`, attendance);
  });

  const rows = [];
  employees.forEach((employee) => {
    const meta = getEmployeeMeta(employee);
    dateRange.forEach((date) => {
      const attendance = attendanceByEmployeeDate.get(`${employee.id}:${date}`);
      if (!attendance || ['absent', 'not_marked', 'incomplete'].includes(attendance.status)) {
        rows.push({
          Date: date,
          'Employee Code': meta.employeeCode,
          Employee: meta.employeeName,
          Email: meta.email,
          Branch: meta.branchName,
          Department: meta.departmentName,
          Status: attendance?.status || 'not_marked',
          Reason: attendance ? 'Recorded attendance status' : 'No attendance record',
        });
      }
    });
  });

  return rows;
}

function buildNotMarkedRows({ employees, attendanceRows, dateRange }) {
  return buildAbsentRows({ employees, attendanceRows, dateRange }).filter((row) => row.Status === 'not_marked');
}

async function getLeaveRows(orgId, filters, employeeIds, employeeById) {
  if (employeeIds.length === 0) {
    return [];
  }

  const leaves = await LeaveRequest.findAll({
    where: {
      org_id: orgId,
      emp_id: { [Op.in]: employeeIds },
      from_date: { [Op.lte]: filters.dateTo },
      to_date: { [Op.gte]: filters.dateFrom },
    },
    include: [{ model: Employee, as: 'employee', required: false }],
    order: [['from_date', 'ASC']],
  });

  return leaves.map((leave) => {
    const employee = employeeById[leave.emp_id] || leave.employee;
    const meta = getEmployeeMeta(employee);

    return {
      'Employee Code': meta.employeeCode,
      Employee: meta.employeeName,
      Email: meta.email,
      Branch: meta.branchName,
      Department: meta.departmentName,
      'Leave Type': leave.leave_type,
      From: leave.from_date,
      To: leave.to_date,
      Days: valueOrBlank(leave.days_count),
      'Half Day': leave.is_half_day ? 'Yes' : 'No',
      Period: leave.half_day_period || '',
      Status: leave.status,
      Reason: leave.reason || '',
      'Approved At': formatDateTime(leave.approved_at),
    };
  });
}

function buildPayrollRows(summaryRows) {
  return summaryRows.map((row) => ({
    'Employee Code': row['Employee Code'],
    Employee: row.Employee,
    Branch: row.Branch,
    Department: row.Department,
    'Payable Days': row.Present + row['Half Days'] * 0.5 + row['On Leave'],
    Present: row.Present,
    Absent: row.Absent,
    'Half Days': row['Half Days'],
    'Paid Leave Days': row['On Leave'],
    'Worked Hours': row['Worked Hours'],
    'Late Count': row.Late,
    'Overtime Count': row.Overtime,
  }));
}

const EXCEL_COLUMN_LIMITS = {
  Email: 34,
  Employee: 28,
  Branch: 26,
  Department: 26,
  Reason: 48,
  Message: 48,
  'First Check In': 24,
  'Last Check Out': 24,
  'Approved At': 24,
};

const NUMERIC_FORMATS = {
  Sessions: '0',
  'Worked Minutes': '0',
  'Worked Hours': '0.00',
  'Late By Minutes': '0',
  'Overtime Minutes': '0',
  'Face Score': '0.000',
  'Calendar Days': '0',
  Present: '0',
  Absent: '0',
  'Half Days': '0.0',
  'On Leave': '0',
  Late: '0',
  Overtime: '0',
  Days: '0.0',
  'Payable Days': '0.0',
  'Paid Leave Days': '0.0',
  'Late Count': '0',
  'Overtime Count': '0',
};

function getCellAddress(rowIndex, columnIndex) {
  return XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
}

function getDisplayLength(value) {
  if (value == null) {
    return 0;
  }

  return String(value)
    .split(/\r?\n/)
    .reduce((max, part) => Math.max(max, part.length), 0);
}

function calculateColumnWidths(headers, rows) {
  return headers.map((header) => {
    const maxContentLength = rows.reduce(
      (max, row) => Math.max(max, getDisplayLength(row[header])),
      getDisplayLength(header)
    );
    const maxWidth = EXCEL_COLUMN_LIMITS[header] || 22;
    return {
      wch: Math.min(Math.max(maxContentLength + 3, 12), maxWidth),
    };
  });
}

function styleWorksheet(worksheet, rows) {
  const range = XLSX.utils.decode_range(worksheet['!ref']);
  const headers = [];

  for (let column = range.s.c; column <= range.e.c; column += 1) {
    const address = getCellAddress(0, column);
    const cell = worksheet[address];
    const header = cell ? String(cell.v || '') : '';
    headers.push(header);

    if (cell) {
      cell.s = {
        font: { bold: true, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: '0F766E' } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      };
    }
  }

  for (let row = 1; row <= range.e.r; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const address = getCellAddress(row, column);
      const cell = worksheet[address];
      if (!cell) {
        continue;
      }

      const header = headers[column];
      cell.s = {
        alignment: {
          vertical: 'top',
          wrapText: ['Email', 'Reason', 'Message'].includes(header),
        },
      };

      if (NUMERIC_FORMATS[header] && typeof cell.v === 'number') {
        cell.z = NUMERIC_FORMATS[header];
      }
    }
  }

  worksheet['!cols'] = calculateColumnWidths(headers, rows);
  worksheet['!rows'] = [
    { hpt: 24 },
    ...rows.map(() => ({ hpt: 20 })),
  ];
  worksheet['!autofilter'] = { ref: XLSX.utils.encode_range(range) };
  worksheet['!freeze'] = { xSplit: 0, ySplit: 1 };
}

function createWorkbook(sheets) {
  const workbook = XLSX.utils.book_new();
  workbook.Props = {
    Title: 'AttendEase Report',
    Subject: 'Attendance and workforce report',
    Author: 'AttendEase',
    Company: 'AttendEase',
    CreatedDate: new Date(),
  };

  sheets.forEach(({ name, rows }) => {
    const safeRows = rows.length > 0 ? rows : [{ Message: 'No records found for selected filters' }];
    const worksheet = XLSX.utils.json_to_sheet(safeRows);
    styleWorksheet(worksheet, safeRows);
    XLSX.utils.book_append_sheet(workbook, worksheet, name.slice(0, 31));
  });

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
}

async function buildReport({ orgId, reportType, filters }) {
  const normalizedFilters = normalizeFilters(filters);
  const dateRange = getDateRange(normalizedFilters.dateFrom, normalizedFilters.dateTo);
  const { employees, employeeIds, employeeById } = await getEmployeeScope(orgId, normalizedFilters);
  const attendanceRows = await getAttendanceRows(orgId, normalizedFilters, employeeIds);
  const attendanceExportRows = normalizedFilters.status === 'not_marked'
    ? buildNotMarkedRows({ employees, attendanceRows, dateRange })
    : attendanceRows.map((attendance) => attendanceToRow(attendance, employeeById));
  const summaryRows = buildSummaryRows({ employees, attendanceRows, dateRange });

  const reportKey = String(reportType || 'attendance').toLowerCase();
  const sheets = [];

  if (['attendance', 'daily', 'employee'].includes(reportKey)) {
    sheets.push({ name: 'Attendance', rows: attendanceExportRows });
  } else if (['monthly_summary', 'summary'].includes(reportKey)) {
    sheets.push({ name: 'Monthly Summary', rows: summaryRows });
  } else if (reportKey === 'late') {
    sheets.push({ name: 'Late Coming', rows: attendanceExportRows.filter((row) => row.Late === 'Yes') });
  } else if (reportKey === 'absent') {
    sheets.push({ name: 'Absent', rows: buildAbsentRows({ employees, attendanceRows, dateRange }) });
  } else if (reportKey === 'leave') {
    sheets.push({ name: 'Leaves', rows: await getLeaveRows(orgId, normalizedFilters, employeeIds, employeeById) });
  } else if (reportKey === 'overtime') {
    sheets.push({ name: 'Overtime', rows: attendanceExportRows.filter((row) => row.Overtime === 'Yes') });
  } else if (reportKey === 'payroll') {
    sheets.push({ name: 'Payroll Export', rows: buildPayrollRows(summaryRows) });
  } else {
    sheets.push({ name: 'Attendance', rows: attendanceExportRows });
    sheets.push({ name: 'Summary', rows: summaryRows });
  }

  const workbookBuffer = createWorkbook(sheets);
  const filename = `${reportKey}-${normalizedFilters.dateFrom}-to-${normalizedFilters.dateTo}.xlsx`;

  return {
    status: 'completed',
    reportType: reportKey,
    filters: normalizedFilters,
    generatedAt: new Date().toISOString(),
    rowCount: sheets.reduce((total, sheet) => total + sheet.rows.length, 0),
    file: {
      filename,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      base64: workbookBuffer.toString('base64'),
    },
  };
}

async function processReportGeneration(job) {
  const { orgId, requestedBy, reportType = 'attendance', filters = {} } = job.data || {};

  if (!orgId) {
    throw new Error('Report generation requires orgId');
  }

  await job.progress(10);
  const report = await buildReport({ orgId, reportType, filters });
  await job.progress(100);

  if (requestedBy) {
    await sendPush([requestedBy], {
      type: 'report_generated',
      title: 'Report ready',
      body: `${report.reportType} report is ready to download.`,
      actionUrl: '/reports',
      data: {
        report_id: job.id,
        requestId: job.id,
        priority: 'low',
        status: 'completed',
      },
    });
  }

  return report;
}

function registerReportGenerationWorker() {
  if (workerRegistered) {
    return reportGeneration;
  }

  reportGeneration.process('generate_report', processReportGeneration);
  reportGeneration.on('failed', async (job, error) => {
    console.error('[queue:report-generation] Job failed:', {
      jobId: job && job.id ? job.id : null,
      message: error.message,
    });

    const requestedBy = job?.data?.requestedBy;
    if (requestedBy) {
      await sendPush([requestedBy], {
        type: 'report_failed',
        title: 'Report generation failed',
        body: error.message || 'Report generation failed. Please try again.',
        actionUrl: '/reports',
        data: {
          report_id: job.id,
          requestId: job.id,
          priority: 'normal',
          status: 'failed',
        },
      });
    }
  });

  workerRegistered = true;
  return reportGeneration;
}

module.exports = {
  registerReportGenerationWorker,
};
