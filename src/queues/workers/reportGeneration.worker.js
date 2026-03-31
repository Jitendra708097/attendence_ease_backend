const { reportGeneration } = require('../index');

let workerRegistered = false;

async function processReportGeneration(job) {
  const { reportType = 'generic', requestedBy = null, filters = {} } = job.data || {};

  return {
    status: 'queued',
    reportType,
    requestedBy,
    filters,
    generatedAt: new Date().toISOString(),
  };
}

function registerReportGenerationWorker() {
  if (workerRegistered) {
    return reportGeneration;
  }

  reportGeneration.process('generate_report', processReportGeneration);
  reportGeneration.on('failed', (job, error) => {
    console.error('[queue:report-generation] Job failed:', {
      jobId: job && job.id ? job.id : null,
      message: error.message,
    });
  });

  workerRegistered = true;
  return reportGeneration;
}

module.exports = {
  registerReportGenerationWorker,
};
