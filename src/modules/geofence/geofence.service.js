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

/**
 * Haversine fallback for circular radius
 * @param {{lat: number, lng: number}} point
 * @param {{lat: number, lng: number}} center
 * @param {number} radiusMeters
 * @returns {boolean}
 */
function isWithinRadius(point, center, radiusMeters = 200) {
  const toRadians = (value) => (value * Math.PI) / 180;
  const earthRadius = 6371000;
  const latitudeDelta = toRadians(center.lat - point.lat);
  const longitudeDelta = toRadians(center.lng - point.lng);

  const a =
    Math.sin(latitudeDelta / 2) * Math.sin(latitudeDelta / 2) +
    Math.cos(toRadians(point.lat)) *
      Math.cos(toRadians(center.lat)) *
      Math.sin(longitudeDelta / 2) *
      Math.sin(longitudeDelta / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = earthRadius * c;

  return distance <= radiusMeters;
}

/**
 * Main entry - uses polygon if defined, falls back to circle
 * @param {{lat: number, lng: number}} employeeGPS
 * @param {{geo_fence_polygons?: Array<{lat: number, lng: number}>, geofence_center?: {lat: number, lng: number}, geofence_radius_meters?: number}} branch
 * @returns {boolean}
 */
function checkGeofence(employeeGPS, branch) {
  const polygon = normalizePolygon(branch.geo_fence_polygons);
  if (polygon.length >= 3) {
    return isInsidePolygon(employeeGPS, polygon);
  }

  if (branch.geofence_center) {
    return isWithinRadius(employeeGPS, branch.geofence_center, branch.geofence_radius_meters || 200);
  }

  return false;
}

module.exports = {
  isInsidePolygon,
  isWithinRadius,
  checkGeofence,
};
