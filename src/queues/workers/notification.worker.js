const notificationService = require('../../modules/notification/notification.service');
const { notification } = require('../index');

let workerRegistered = false;

async function processDirectNotification(job) {
  return notificationService.processSendPushJob(job.data);
}

async function processShiftReminder(job) {
  return notificationService.processShiftReminderJob(job.data);
}

async function processCheckoutReminder(job) {
  return notificationService.processCheckoutReminderJob(job.data);
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

  notification.process('send_push', 5, processDirectNotification);
  notification.process('shift_reminder', 5, processShiftReminder);
  notification.process('checkout_reminder', 5, processCheckoutReminder);
  notification.process('send_welcome_email', 3, processWelcomeEmail);
  notification.process('send_billing_alert_email', 3, processBillingAlertEmail);

  notification.resume(true).catch((error) => {
    console.error('[queue:notification] Resume failed:', error.message);
  });

  notification.on('failed', (job, error) => {
    console.error('[queue:notification] Job failed:', {
      jobId: job && job.id ? job.id : null,
      name: job && job.name ? job.name : null,
      message: error.message,
    });
  });

  notification.on('completed', (job) => {
    console.log('[queue:notification] Job completed:', {
      jobId: job && job.id ? job.id : null,
      name: job && job.name ? job.name : null,
    });
  });

  notification.on('error', (error) => {
    console.error('[queue:notification] Redis/queue error:', error.message);
  });

  console.log('[queue:notification] Worker registered');

  workerRegistered = true;
  return notification;
}

module.exports = {
  registerNotificationWorker,
};
