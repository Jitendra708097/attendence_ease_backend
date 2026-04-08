const queues = require('./index');
const { registerAutoAbsentWorker } = require('./workers/autoAbsent.worker');
const { registerCheckoutGraceWorker } = require('./workers/checkoutGrace.worker');
const { registerFaceEnrollmentWorker } = require('./workers/faceEnrollment.worker');
const { registerNotificationWorker } = require('./workers/notification.worker');
const { registerOfflineSyncWorker } = require('./workers/offlineSync.worker');
const { registerReportGenerationWorker } = require('./workers/reportGeneration.worker');
const { registerDailyScheduler } = require('./schedulers/daily.scheduler');
const { closeQueues } = require('./index');

function registerQueues() {
  registerAutoAbsentWorker();
  registerCheckoutGraceWorker();
  registerFaceEnrollmentWorker();
  registerNotificationWorker();
  registerReportGenerationWorker();
  registerOfflineSyncWorker();
  registerDailyScheduler();

  return queues;
}

module.exports = {
  registerQueues,
  closeQueues,
};
