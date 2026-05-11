const WINDOW_MS = 15 * 60 * 1000;
const MAX_SAMPLES = 5000;

const samples = [];

function recordRequestMetric({ route, method, statusCode, durationMs }) {
  const now = Date.now();
  samples.push({
    time: now,
    route: route || 'unknown',
    method,
    statusCode: Number(statusCode || 0),
    durationMs: Number(durationMs || 0),
  });

  const cutoff = now - WINDOW_MS;
  while (samples.length > 0 && (samples[0].time < cutoff || samples.length > MAX_SAMPLES)) {
    samples.shift();
  }
}

function percentile(values, pct) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return Math.round(sorted[index]);
}

function bucketByMinute(rows) {
  const buckets = new Map();

  rows.forEach((row) => {
    const date = new Date(row.time);
    const key = date.toISOString().slice(11, 16);
    const bucket = buckets.get(key) || {
      time: key,
      durations: [],
      total: 0,
      errors: 0,
    };
    bucket.durations.push(row.durationMs);
    bucket.total += 1;
    if (row.statusCode >= 500) {
      bucket.errors += 1;
    }
    buckets.set(key, bucket);
  });

  return Array.from(buckets.values()).slice(-60);
}

function getRequestMetricsSnapshot() {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const recent = samples.filter((sample) => sample.time >= cutoff);
  const durations = recent.map((sample) => sample.durationMs);
  const errorCount = recent.filter((sample) => sample.statusCode >= 500).length;
  const errorRate = recent.length > 0 ? Number(((errorCount / recent.length) * 100).toFixed(2)) : 0;
  const buckets = bucketByMinute(recent);
  const routeBuckets = recent.reduce((acc, sample) => {
    const key = `${sample.method || 'GET'} ${sample.route || 'unknown'}`;
    const bucket = acc.get(key) || {
      route: sample.route || 'unknown',
      method: sample.method || 'GET',
      durations: [],
      total: 0,
      errors: 0,
    };
    bucket.durations.push(sample.durationMs);
    bucket.total += 1;
    if (sample.statusCode >= 500) {
      bucket.errors += 1;
    }
    acc.set(key, bucket);
    return acc;
  }, new Map());
  const slowEndpoints = Array.from(routeBuckets.values())
    .map((bucket) => ({
      route: bucket.route,
      method: bucket.method,
      count: bucket.total,
      p95: percentile(bucket.durations, 95),
      errorRate: bucket.total > 0 ? Number(((bucket.errors / bucket.total) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.p95 - a.p95)
    .slice(0, 10);

  return {
    totalRequests: recent.length,
    errorCount,
    errorRate,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    responseTime: buckets.map((bucket) => ({
      time: bucket.time,
      p95: percentile(bucket.durations, 95),
    })),
    errorRateSeries: buckets.map((bucket) => ({
      time: bucket.time,
      rate: bucket.total > 0 ? Number(((bucket.errors / bucket.total) * 100).toFixed(2)) : 0,
    })),
    requestSeries: buckets.map((bucket) => ({
      time: bucket.time,
      count: bucket.total,
    })),
    slowEndpoints,
  };
}

module.exports = {
  getRequestMetricsSnapshot,
  recordRequestMetric,
};
