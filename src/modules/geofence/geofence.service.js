/**
 * Ray Casting algorithm
 * @param {{lat: number, lng: number}} point
 * @param {Array<{lat: number, lng: number}>} polygon
 * @returns {boolean}
 */
function isInsidePolygon(point, polygon = []) {
  if (!Array.isArray(polygon) || polygon.length < 3) {
    return false;
  }

  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;

    const intersects =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / ((yj - yi) || Number.EPSILON) + xi;

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
  if (Array.isArray(branch.geo_fence_polygons) && branch.geo_fence_polygons.length >= 3) {
    return isInsidePolygon(employeeGPS, branch.geo_fence_polygons);
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
