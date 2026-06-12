const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const roleGuard = require('../../middleware/roleGuard');
const planFeatureGate = require('../../middleware/planFeatureGate');
const attendanceController = require('./attendance.controller');

const router = express.Router();

router.use(authenticate, orgGuard, planFeatureGate('mobile_attendance'));

router.post('/challenge', asyncHandler(attendanceController.challenge));
router.post('/check-in', asyncHandler(attendanceController.checkIn));
router.post('/check-out', asyncHandler(attendanceController.checkOut));
router.post('/kiosk/scan', asyncHandler(attendanceController.kioskScan));
router.post('/sync', asyncHandler(attendanceController.sync));
router.post('/undo-checkout', asyncHandler(attendanceController.undoCheckout));
router.get('/today', asyncHandler(attendanceController.today));
router.get('/history', asyncHandler(attendanceController.history));
router.get('/history/:date', asyncHandler(attendanceController.dayDetail));

router.get('/stats/today', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(attendanceController.statsToday));
router.get('/stats/trend', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(attendanceController.trend));
router.get('/stats/top-late', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(attendanceController.topLate));
router.get('/stats/activity', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(attendanceController.activity));
router.get('/live', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(attendanceController.live));
router.get('/', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(attendanceController.list));
router.get('/export', roleGuard('admin', 'manager', 'superadmin'), planFeatureGate('reports', 'full'), asyncHandler(attendanceController.exportCsv));
router.post('/export', roleGuard('admin', 'manager', 'superadmin'), planFeatureGate('reports', 'full'), asyncHandler(attendanceController.exportCsv));
router.put('/:id/flag-anomaly', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(attendanceController.flagAnomaly));
router.put('/:id/unflag-anomaly', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(attendanceController.unflagAnomaly));
router.get('/:id', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(attendanceController.getById));
router.put('/:id/manual', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(attendanceController.manual));

module.exports = router;
