const { notification, autoAbsent } = require('../index');

function partsToUtcEpoch(parts) {
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
}

function getFormatter(timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function getDatePartsInTimezone(date, timezone) {
  return getFormatter(timezone)
    .formatToParts(date)
    .reduce((accumulator, part) => {
      if (part.type !== 'literal') {
        accumulator[part.type] = part.value;
      }
      return accumulator;
    }, {});
}

function localDateTimeToUtc(dateString, timeString, timezone) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  const timeValue = String(timeString || '00:00:00');
  const [hour, minute, second] = timeValue.split(':').map((value) => Number(value || 0));
  const targetParts = { year, month, day, hour, minute, second };
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);

  for (let index = 0; index < 3; index += 1) {
    const localParts = getDatePartsInTimezone(new Date(guess), timezone);
    const diff = partsToUtcEpoch(targetParts) - partsToUtcEpoch(localParts);
    guess += diff;
  }

  return new Date(guess);
}

function addDays(dateString, days) {
  const base = new Date(`${dateString}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

async function scheduleShiftJobsForDate({ organisation, shift, dateString }) {
  const timezone = organisation.timezone || 'UTC';
  const shiftStartAt = localDateTimeToUtc(dateString, shift.start_time, timezone);
  const shiftEndDate = shift.crosses_midnight ? addDays(dateString, 1) : dateString;
  const shiftEndAt = localDateTimeToUtc(shiftEndDate, shift.end_time, timezone);

  const autoAbsentAt = new Date(
    shiftStartAt.getTime() + Number(shift.absent_after_minutes || 0) * 60 * 1000
  );
  const checkInReminderAt = new Date(shiftStartAt.getTime() - 15 * 60 * 1000);
  const checkOutReminderAt = new Date(shiftEndAt.getTime() - 30 * 60 * 1000);

  const scheduled = [];
  const now = Date.now();

  if (autoAbsentAt.getTime() > now) {
    await autoAbsent.add(
      'auto_absent',
      {
        orgId: organisation.id,
        shiftId: shift.id,
        dateString,
      },
      {
        jobId: `auto_absent_${shift.id}_${dateString}`,
        delay: autoAbsentAt.getTime() - now,
      }
    );

    scheduled.push({
      type: 'auto_absent',
      runAt: autoAbsentAt.toISOString(),
    });
  }

  if (checkInReminderAt.getTime() > now) {
    await notification.add(
      'shift_reminder',
      {
        orgId: organisation.id,
        shiftId: shift.id,
        reminderType: 'shift_checkin_reminder',
        type: 'shift_checkin_reminder',
        title: `Upcoming shift: ${shift.name}`,
        body: 'Your check-in window opens in 15 minutes.',
        actionUrl: '/attendance',
      },
      {
        jobId: `shift_checkin_reminder_${shift.id}_${dateString}`,
        delay: checkInReminderAt.getTime() - now,
      }
    );

    scheduled.push({
      type: 'checkin_reminder',
      runAt: checkInReminderAt.toISOString(),
    });
  }

  if (checkOutReminderAt.getTime() > now) {
    await notification.add(
      'shift_reminder',
      {
        orgId: organisation.id,
        shiftId: shift.id,
        reminderType: 'shift_checkout_reminder',
        type: 'shift_checkout_reminder',
        title: `Shift ending soon: ${shift.name}`,
        body: 'Your shift ends in 30 minutes. Remember to check out on time.',
        actionUrl: '/attendance',
      },
      {
        jobId: `shift_checkout_reminder_${shift.id}_${dateString}`,
        delay: checkOutReminderAt.getTime() - now,
      }
    );

    scheduled.push({
      type: 'checkout_reminder',
      runAt: checkOutReminderAt.toISOString(),
    });
  }

  return scheduled;
}

module.exports = {
  localDateTimeToUtc,
  scheduleShiftJobsForDate,
};
