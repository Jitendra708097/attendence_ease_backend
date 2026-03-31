const { offlineSync } = require('../index');

let workerRegistered = false;

async function processOfflineSync(job) {
  const { orgId = null, empId = null, records = [] } = job.data || {};

  return {
    synced: Array.isArray(records) ? records.length : 0,
    orgId,
    empId,
    syncedAt: new Date().toISOString(),
  };
}

function registerOfflineSyncWorker() {
  if (workerRegistered) {
    return offlineSync;
  }

  offlineSync.process('offline_sync', processOfflineSync);
  offlineSync.on('failed', (job, error) => {
    console.error('[queue:offline-sync] Job failed:', {
      jobId: job && job.id ? job.id : null,
      message: error.message,
    });
  });

  workerRegistered = true;
  return offlineSync;
}

module.exports = {
  registerOfflineSyncWorker,
};
