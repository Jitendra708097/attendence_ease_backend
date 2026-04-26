const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const roleGuard = require('../../middleware/roleGuard');
const attendanceController = require('./attendance.controller');

const router = express.Router();

router.use(authenticate, orgGuard);

router.post('/challenge', asyncHandler(attendanceController.challenge));
router.post('/check-in', asyncHandler(attendanceController.checkIn));
router.post('/check-out', asyncHandler(attendanceController.checkOut));
router.post('/undo-checkout', asyncHandler(attendanceController.undoCheckout));
router.get('/today', asyncHandler(attendanceController.today));
router.get('/history', asyncHandler(attendanceController.history));

router.get('/stats/today', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(attendanceController.statsToday));
router.get('/stats/trend', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(attendanceController.trend));
router.get('/stats/top-late', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(attendanceController.topLate));
router.get('/stats/activity', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(attendanceController.activity));
router.get('/live', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(attendanceController.live));
router.get('/', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(attendanceController.list));
router.get('/export', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(attendanceController.exportCsv));
router.get('/:id', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(attendanceController.getById));
router.put('/:id/manual', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(attendanceController.manual));

module.exports = router;
