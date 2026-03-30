const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const roleGuard = require('../../middleware/roleGuard');
const shiftController = require('./shift.controller');

const router = express.Router();

router.use(authenticate, orgGuard, roleGuard('admin', 'manager', 'superadmin'));

router.get('/', asyncHandler(shiftController.listShifts));
router.post('/', asyncHandler(shiftController.createShift));
router.put('/:id', asyncHandler(shiftController.updateShift));
router.delete('/:id', asyncHandler(shiftController.deleteShift));

module.exports = router;
