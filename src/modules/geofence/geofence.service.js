const EDGE_TOLERANCE = 1e-9;

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePoint(point) {
  if (!point || typeof point !== 'object') {
    return null;
  }

  const lat = toFiniteNumber(point.lat);
  const lng = toFiniteNumber(point.lng);

  if (lat == null || lng == null) {
    return null;
  }

  return { lat, lng };
}

function normalizePolygon(polygon = []) {
  if (!Array.isArray(polygon)) {
    return [];
  }

  const ring = Array.isArray(polygon[0]) ? polygon[0] : polygon;
  const normalized = ring.map(normalizePoint).filter(Boolean);

  if (normalized.length >= 2) {
    const first = normalized[0];
    const last = normalized[normalized.length - 1];

    if (
      Math.abs(first.lat - last.lat) <= EDGE_TOLERANCE &&
      Math.abs(first.lng - last.lng) <= EDGE_TOLERANCE
    ) {
      normalized.pop();
    }
  }

  return normalized;
}

function isPointOnSegment(point, start, end) {
  const crossProduct =
    (point.lat - start.lat) * (end.lng - start.lng) -
    (point.lng - start.lng) * (end.lat - start.lat);

  if (Math.abs(crossProduct) > EDGE_TOLERANCE) {
    return false;
  }

  const dotProduct =
    (point.lng - start.lng) * (end.lng - start.lng) +
    (point.lat - start.lat) * (end.lat - start.lat);

  if (dotProduct < -EDGE_TOLERANCE) {
    return false;
  }

  const squaredLength =
    (end.lng - start.lng) * (end.lng - start.lng) +
    (end.lat - start.lat) * (end.lat - start.lat);

  return dotProduct <= squaredLength + EDGE_TOLERANCE;
}

/**
 * Ray Casting algorithm
 * @param {{lat: number, lng: number}} point
 * @param {Array<{lat: number, lng: number}> | Array<Array<{lat: number, lng: number}>>} polygon
 * @returns {boolean}
 */
function isInsidePolygon(point, polygon = []) {
  const normalizedPoint = normalizePoint(point);
  const normalizedPolygon = normalizePolygon(polygon);

  if (!normalizedPoint || normalizedPolygon.length < 3) {
    return false;
  }

  let inside = false;

  for (let i = 0, j = normalizedPolygon.length - 1; i < normalizedPolygon.length; j = i++) {
    const current = normalizedPolygon[i];
    const previous = normalizedPolygon[j];

    if (isPointOnSegment(normalizedPoint, previous, current)) {
      return true;
    }

    const intersects =
      current.lat > normalizedPoint.lat !== previous.lat > normalizedPoint.lat &&
      normalizedPoint.lng <
        ((previous.lng - current.lng) * (normalizedPoint.lat - current.lat)) /
          ((previous.lat - current.lat) || Number.EPSILON) +
          current.lng;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function metersPerDegreeLng(lat) {
  return 111320 * Math.cos((Number(lat) * Math.PI) / 180);
}

function pointToSegmentDistanceMeters(point, start, end) {
  const latScale = 111320;
  const lngScale = metersPerDegreeLng(point.lat || start.lat || end.lat || 0) || 1;

  const px = point.lng * lngScale;
  const py = point.lat * latScale;
  const ax = start.lng * lngScale;
  const ay = start.lat * latScale;
  const bx = end.lng * lngScale;
  const by = end.lat * latScale;
  const dx = bx - ax;
  const dy = by - ay;

  if (dx === 0 && dy === 0) {
    return Math.hypot(px - ax, py - ay);
  }

  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  const closestX = ax + t * dx;
  const closestY = ay + t * dy;

  return Math.hypot(px - closestX, py - closestY);
}

function distanceToPolygonMeters(point, polygon = []) {
  const normalizedPoint = normalizePoint(point);
  const normalizedPolygon = normalizePolygon(polygon);

  if (!normalizedPoint || normalizedPolygon.length < 3) {
    return Infinity;
  }

  if (isInsidePolygon(normalizedPoint, normalizedPolygon)) {
    return 0;
  }

  let minDistance = Infinity;
  for (let i = 0, j = normalizedPolygon.length - 1; i < normalizedPolygon.length; j = i++) {
    minDistance = Math.min(
      minDistance,
      pointToSegmentDistanceMeters(normalizedPoint, normalizedPolygon[j], normalizedPolygon[i])
    );
  }

  return minDistance;
}

/**
 * Main entry - polygon-only geofence check.
 * @param {{lat: number, lng: number}} employeeGPS
 * @param {{geo_fence_polygons?: Array<{lat: number, lng: number}>}} branch
 * @returns {boolean}
 */
function checkGeofence(employeeGPS, branch) {
  const polygon = normalizePolygon(branch.geo_fence_polygons);
  return polygon.length >= 3 ? isInsidePolygon(employeeGPS, polygon) : false;
}

module.exports = {
  isInsidePolygon,
  distanceToPolygonMeters,
  checkGeofence,
};
