const { ok, fail } = require('../../utils/response');
const reportService = require('./report.service');

async function create(req, res) {
  try {
    return ok(
      res,
      await reportService.queueReport({ orgId: req.org_id, requestedBy: req.employee.id, body: req.body }),
      'Report generation queued',
      202
    );
  } catch (error) {
    return fail(res, error.code || 'REPORT_001', error.message, error.details || [], error.statusCode || 400);
  }
}

async function list(req, res) {
  try {
    return ok(res, await reportService.listReportJobs(req.org_id), 'Report jobs fetched');
  } catch (error) {
    return fail(res, error.code || 'REPORT_002', error.message, error.details || [], error.statusCode || 400);
  }
}

async function get(req, res) {
  try {
    const isDownload = req.path.endsWith('/download');
    return ok(
      res,
      isDownload
        ? await reportService.downloadReportJob(req.params.jobId, req.org_id)
        : await reportService.getReportJob(req.params.jobId, req.org_id),
      isDownload ? 'Report download prepared' : 'Report job fetched'
    );
  } catch (error) {
    return fail(res, error.code || 'HTTP_404', error.message, error.details || [], error.statusCode || 404);
  }
}

async function cancel(req, res) {
  try {
    return ok(
      res,
      await reportService.cancelReportJob(req.params.jobId, req.org_id),
      'Report job cancelled'
    );
  } catch (error) {
    return fail(res, error.code || 'REPORT_004', error.message, error.details || [], error.statusCode || 400);
  }
}

async function remove(req, res) {
  try {
    return ok(
      res,
      await reportService.removeReportJob(req.params.jobId, req.org_id),
      'Report job removed'
    );
  } catch (error) {
    return fail(res, error.code || 'REPORT_005', error.message, error.details || [], error.statusCode || 400);
  }
}

module.exports = { create, list, get, cancel, remove };
