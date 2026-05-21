const test = require('node:test');
const assert = require('node:assert/strict');
const { computeAttendanceStatus } = require('../src/modules/attendance/attendance.statusEngine');

const shift = {
  start_time: '09:00:00',
  end_time: '18:00:00',
  break_minutes: 60,
  half_day_after_minutes: 240,
  absent_after_minutes: 120,
  overtime_after_minutes: 480,
  min_overtime_minutes: 30,
  grace_minutes_checkin: 15,
};

test('approved full-day leave marks attendance as on_leave', () => {
  const result = computeAttendanceStatus(
    { date: '2026-05-21', total_worked_minutes: 0 },
    shift,
    { type: 'full_day' },
    'Asia/Kolkata'
  );

  assert.equal(result.status, 'on_leave');
  assert.equal(result.isLate, false);
});

test('approved half-day leave marks attendance as half_day', () => {
  const result = computeAttendanceStatus(
    { date: '2026-05-21', total_worked_minutes: 0 },
    shift,
    { type: 'half_day', period: 'morning' },
    'Asia/Kolkata'
  );

  assert.equal(result.status, 'half_day');
  assert.equal(result.isOvertime, false);
});

test('without leave, insufficient worked time becomes half_day_early', () => {
  const result = computeAttendanceStatus(
    { date: '2026-05-21', total_worked_minutes: 220 },
    shift,
    null,
    'Asia/Kolkata'
  );

  assert.equal(result.status, 'half_day_early');
});
