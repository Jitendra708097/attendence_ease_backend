const { Organisation, Shift } = require('../../models');
const { autoAbsent } = require('../index');
const { scheduleShiftJobsForDate } = require('./shift.scheduler');

function getLocalDateString(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = formatter.formatToParts(date).reduce((accumulator, part) => {
    if (part.type !== 'literal') {
      accumulator[part.type] = part.value;
    }
    return accumulator;
  }, {});

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getLocalWeekdayNumber(date, timezone) {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  }).format(date);

  const map = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };

  return map[weekday] || null;
}

async function scheduleDailyJobs(runDate = new Date()) {
  const organisations = await Organisation.findAll({
    where: {
      is_active: true,
    },
    attributes: ['id', 'timezone'],
  });

  const results = [];

  for (const organisation of organisations) {
    const timezone = organisation.timezone || 'UTC';
    const dateString = getLocalDateString(runDate, timezone);
    const weekday = getLocalWeekdayNumber(runDate, timezone);

    const shifts = await Shift.findAll({
      where: {
        org_id: organisation.id,
      },
    });

    for (const shift of shifts) {
      const workDays = Array.isArray(shift.work_days) ? shift.work_days : [];

      if (workDays.length > 0 && weekday && !workDays.includes(weekday)) {
        continue;
      }

      const scheduled = await scheduleShiftJobsForDate({
        organisation,
        shift,
        dateString,
      });

      results.push({
        orgId: organisation.id,
        shiftId: shift.id,
        dateString,
        scheduled,
      });
    }
  }

  return results;
}

let schedulerRegistered = false;

function registerDailyScheduler() {
  if (schedulerRegistered) {
    return autoAbsent;
  }

  schedulerRegistered = true;

  autoAbsent.add(
    'daily_schedule_org_shifts',
    {},
    {
      jobId: 'daily_schedule_org_shifts',
      repeat: {
        cron: '0 0 * * *',
        tz: 'UTC',
      },
    }
  ).catch((error) => {
    console.error('[scheduler:daily] Failed to register repeatable job:', error.message);
  });

  return autoAbsent;
}

module.exports = {
  scheduleDailyJobs,
  registerDailyScheduler,
};
