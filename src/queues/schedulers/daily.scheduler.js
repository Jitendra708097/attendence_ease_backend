'use strict';

const { redisClient } = require('../../config/redis');
const { Organisation, Shift } = require('../../models');
const { autoAbsent } = require('../index');
const { scheduleShiftJobsForDate } = require('./shift.scheduler');

const SCHEDULE_LOCK_KEY = 'daily_schedule_lock';
const LOCK_TTL_SECONDS = 60;

function getLocalDateString(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getLocalWeekdayNumber(date, timezone) {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  }).format(date);
  return { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[weekday] || null;
}

async function scheduleDailyJobs(runDate = new Date()) {
  const acquired = await redisClient.set(SCHEDULE_LOCK_KEY, '1', 'EX', LOCK_TTL_SECONDS, 'NX');

  if (!acquired) {
    console.log('[scheduler:daily] Skipping duplicate run');
    return [];
  }

  try {
    const organisations = await Organisation.findAll({
      where: { is_active: true },
      attributes: ['id', 'timezone'],
      include: [
        {
          model: Shift,
          as: 'shifts',
          attributes: [
            'id', 'name', 'start_time', 'end_time', 'crosses_midnight',
            'work_days', 'absent_after_minutes',
          ],
          required: false,
        },
      ],
    });

    const allResults = await Promise.all(
      organisations.map(async (organisation) => {
        const timezone = organisation.timezone || 'UTC';
        const dateString = getLocalDateString(runDate, timezone);
        const weekday = getLocalWeekdayNumber(runDate, timezone);

        const eligibleShifts = (organisation.shifts || []).filter((shift) => {
          const workDays = Array.isArray(shift.work_days) ? shift.work_days : [];
          return workDays.length === 0 || !weekday || workDays.includes(weekday);
        });

        const shiftResults = await Promise.all(
          eligibleShifts.map(async (shift) => {
            const scheduled = await scheduleShiftJobsForDate({ organisation, shift, dateString });
            return { orgId: organisation.id, shiftId: shift.id, dateString, scheduled };
          })
        );

        return shiftResults;
      })
    );

    return allResults.flat();
  } finally {
    await redisClient.del(SCHEDULE_LOCK_KEY);
  }
}

let schedulerRegistered = false;

function registerDailyScheduler() {
  if (schedulerRegistered) return autoAbsent;
  schedulerRegistered = true;

  autoAbsent.add(
    'daily_schedule_org_shifts',
    {},
    {
      jobId: 'daily_schedule_org_shifts',
      repeat: { cron: '0 0 * * *', tz: 'UTC' },
    }
  ).catch((error) => {
    console.error('[scheduler:daily] Failed to register repeatable job:', error.message);
  });

  return autoAbsent;
}

module.exports = { scheduleDailyJobs, registerDailyScheduler };