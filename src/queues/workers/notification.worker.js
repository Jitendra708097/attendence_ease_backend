const notificationService = require('../../modules/notification/notification.service');
const { notification } = require('../index');

let workerRegistered = false;

async function processDirectNotification(job) {
  return notificationService.processSendPushJob(job.data);
}

async function processShiftReminder(job) {
  return notificationService.processShiftReminderJob(job.data);
}

async function processWelcomeEmail(job) {
  return notificationService.processSendWelcomeEmailJob(job.data);
}

async function processBillingAlertEmail(job) {
  return notificationService.processSendBillingAlertEmailJob(job.data);
}

function registerNotificationWorker() {
  if (workerRegistered) {
    return notification;
  }

  notification.process('send_push', processDirectNotification);
  notification.process('shift_reminder', processShiftReminder);
  notification.process('send_welcome_email', processWelcomeEmail);
  notification.process('send_billing_alert_email', processBillingAlertEmail);
  notification.on('failed', (job, error) => {
    console.error('[queue:notification] Job failed:', {
      jobId: job && job.id ? job.id : null,
      name: job && job.name ? job.name : null,
      message: error.message,
    });
  });

  workerRegistered = true;
  return notification;
}

module.exports = {
  registerNotificationWorker,
};
