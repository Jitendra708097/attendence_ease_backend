const { reportGeneration } = require('../../queues');
const { registerReportGenerationWorker } = require('../../queues/workers/reportGeneration.worker');

registerReportGenerationWorker();

function createError(code, message, statusCode, details = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

async function queueReport({ orgId, requestedBy, body = {} }) {
  const reportType = String(body.reportType || body.type || 'attendance').trim();
  const filters = body.filters && typeof body.filters === 'object' ? body.filters : {};
  const job = await reportGeneration.add(
    'generate_report',
    {
      orgId,
      requestedBy,
      reportType,
      filters,
    },
    {
      jobId: `report_${orgId}_${requestedBy}_${Date.now()}`,
      removeOnComplete: false,
      removeOnFail: false,
    }
  );

  return {
    queued: true,
    jobId: job.id,
    reportType,
  };
}

async function getRawReportJob(jobId, orgId = null) {
  const job = await reportGeneration.getJob(jobId);

  if (!job) {
    throw createError('HTTP_404', 'Report job not found', 404);
  }

  if (orgId && job.data?.orgId !== orgId) {
    throw createError('HTTP_404', 'Report job not found', 404);
  }

  return job;
}

function sanitizeResult(result) {
  if (!result) {
    return null;
  }

  const { file, ...safeResult } = result;
  return {
    ...safeResult,
    file: file
      ? {
          filename: file.filename,
          mimeType: file.mimeType,
          ready: Boolean(file.base64),
        }
      : null,
  };
}

async function getReportJob(jobId, orgId = null) {
  const job = await getRawReportJob(jobId, orgId);

  const state = await job.getState();
  const progress = await job.progress();

  return {
    id: job.id,
    state,
    status: state,
    progress,
    data: job.data,
    result: sanitizeResult(job.returnvalue),
    failedReason: job.failedReason || null,
    createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
    processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  };
}

async function downloadReportJob(jobId, orgId = null) {
  const rawJob = await getRawReportJob(jobId, orgId);
  const state = await rawJob.getState();

  if (state !== 'completed') {
    throw createError('REPORT_003', 'Report file is not ready yet', 409);
  }

  const file = rawJob.returnvalue?.file;

  if (!file || !file.base64) {
    throw createError('REPORT_003', 'Report file is not ready yet', 409);
  }

  const mimeType = file.mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  return {
    filename: file.filename || `${rawJob.data.reportType || 'report'}-${rawJob.id}.xlsx`,
    mimeType,
    url: `data:${mimeType};base64,${file.base64}`,
  };
}

async function removeReportJob(jobId, orgId = null, options = {}) {
  const rawJob = await getRawReportJob(jobId, orgId);
  const state = await rawJob.getState();

  if (state === 'active') {
    throw createError(
      'REPORT_004',
      options.cancel ? 'Report is already processing and cannot be cancelled safely' : 'Active report cannot be removed',
      409
    );
  }

  await rawJob.remove();

  return {
    removed: true,
    cancelled: Boolean(options.cancel),
    jobId,
    previousStatus: state,
  };
}

async function cancelReportJob(jobId, orgId = null) {
  return removeReportJob(jobId, orgId, { cancel: true });
}

async function listReportJobs(orgId = null) {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    reportGeneration.getWaiting(0, 24),
    reportGeneration.getActive(0, 24),
    reportGeneration.getCompleted(0, 24),
    reportGeneration.getFailed(0, 24),
    reportGeneration.getDelayed(0, 24),
  ]);

  const rows = [...active, ...waiting, ...delayed, ...failed, ...completed]
    .filter((job) => !orgId || job.data?.orgId === orgId)
    .slice(0, 50);
  const jobs = await Promise.all(rows.map((job) => getReportJob(job.id, orgId)));

  return { jobs };
}

module.exports = {
  queueReport,
  getReportJob,
  downloadReportJob,
  cancelReportJob,
  removeReportJob,
  listReportJobs,
};
