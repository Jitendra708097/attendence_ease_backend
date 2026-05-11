const { offlineSync } = require('../index');
const attendanceService = require('../../modules/attendance/attendance.service');

let workerRegistered = false;

async function processOfflineSync(job) {
  const { orgId = null, empId = null, records = [] } = job.data || {};

  if (!orgId || !empId || !Array.isArray(records) || records.length === 0) {
    return {
      synced: 0,
      orgId,
      empId,
      syncedAt: new Date().toISOString(),
      skipped: true,
      reason: 'invalid_payload',
    };
  }

  return attendanceService.syncOffline({
    orgId,
    empId,
    body: { records },
    req: {
      employee: { id: empId, orgId, role: 'employee' },
      ip: null,
      headers: {},
    },
  });
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
