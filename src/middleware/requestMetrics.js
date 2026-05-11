const { recordRequestMetric } = require('../utils/requestMetrics');

function requestMetrics(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    recordRequestMetric({
      route: req.route?.path || req.path,
      method: req.method,
      statusCode: res.statusCode,
      durationMs,
    });
  });

  next();
}

module.exports = requestMetrics;
