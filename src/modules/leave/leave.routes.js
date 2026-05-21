const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const roleGuard = require('../../middleware/roleGuard');
const blockImpersonatedWrites = require('../../middleware/blockImpersonatedWrites');
const planFeatureGate = require('../../middleware/planFeatureGate');
const leaveController = require('./leave.controller');

const router = express.Router();

router.use(authenticate, orgGuard, planFeatureGate('leave_management'));

router.get('/', asyncHandler(leaveController.list));
router.post('/', blockImpersonatedWrites, asyncHandler(leaveController.create));
router.get('/balance', asyncHandler(leaveController.balance));
router.get('/history', asyncHandler(leaveController.list));
router.post('/apply', blockImpersonatedWrites, asyncHandler(leaveController.create));
router.post('/preview', asyncHandler(leaveController.preview));
router.get('/requests', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(leaveController.adminList));
router.get('/requests/:id', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(leaveController.adminDetail));
router.get('/requests/:id/context', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(leaveController.adminContext));
router.get('/balances', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(leaveController.balances));
router.post('/balances/adjust', roleGuard('admin', 'superadmin'), blockImpersonatedWrites, asyncHandler(leaveController.adjustBalance));
router.get('/ledger', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(leaveController.ledger));
router.get('/types', asyncHandler(leaveController.types));
router.put('/types', roleGuard('admin', 'superadmin'), blockImpersonatedWrites, asyncHandler(leaveController.upsertType));
router.post('/types', roleGuard('admin', 'superadmin'), blockImpersonatedWrites, asyncHandler(leaveController.upsertType));
router.get('/policies', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(leaveController.policies));
router.post('/policies', roleGuard('admin', 'superadmin'), blockImpersonatedWrites, asyncHandler(leaveController.upsertPolicy));
router.put('/policies/:id', roleGuard('admin', 'superadmin'), blockImpersonatedWrites, asyncHandler(leaveController.upsertPolicy));
router.get('/calendar', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(leaveController.calendar));
router.get('/pending', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(leaveController.pending));
router.get('/payroll/report', roleGuard('admin', 'superadmin'), asyncHandler(leaveController.payrollReport));
router.post('/payroll/lock', roleGuard('admin', 'superadmin'), blockImpersonatedWrites, asyncHandler(leaveController.payrollLock));
router.put('/:id/approve', roleGuard('admin', 'manager', 'superadmin'), blockImpersonatedWrites, asyncHandler(leaveController.approve));
router.put('/:id/reject', roleGuard('admin', 'manager', 'superadmin'), blockImpersonatedWrites, asyncHandler(leaveController.reject));
router.put('/:id/cancel/approve', roleGuard('admin', 'superadmin'), blockImpersonatedWrites, asyncHandler(leaveController.approveCancellation));
router.delete('/:id', blockImpersonatedWrites, asyncHandler(leaveController.remove));
router.post('/:id/cancel', blockImpersonatedWrites, asyncHandler(leaveController.remove));

module.exports = router;
