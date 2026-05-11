const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const roleGuard = require('../../middleware/roleGuard');
const leaveController = require('./leave.controller');

const router = express.Router();

router.use(authenticate, orgGuard);

router.get('/', asyncHandler(leaveController.list));
router.post('/', asyncHandler(leaveController.create));
router.get('/balance', asyncHandler(leaveController.balance));
router.get('/history', asyncHandler(leaveController.list));
router.post('/apply', asyncHandler(leaveController.create));
router.get('/requests', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(leaveController.adminList));
router.get('/requests/:id', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(leaveController.adminDetail));
router.get('/requests/:id/context', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(leaveController.adminContext));
router.get('/balances', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(leaveController.balances));
router.get('/types', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(leaveController.types));
router.get('/calendar', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(leaveController.calendar));
router.get('/pending', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(leaveController.pending));
router.put('/:id/approve', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(leaveController.approve));
router.put('/:id/reject', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(leaveController.reject));
router.delete('/:id', asyncHandler(leaveController.remove));
router.post('/:id/cancel', asyncHandler(leaveController.remove));

module.exports = router;
