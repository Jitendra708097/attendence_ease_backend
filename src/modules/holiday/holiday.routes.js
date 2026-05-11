const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const roleGuard = require('../../middleware/roleGuard');
const holidayController = require('./holiday.controller');

const router = express.Router();

router.use(authenticate, orgGuard, roleGuard('admin', 'manager', 'superadmin'));

router.get('/', asyncHandler(holidayController.list));
router.post('/', asyncHandler(holidayController.create));
router.post('/bulk-import', asyncHandler(holidayController.bulkImport));
router.get('/:id', asyncHandler(holidayController.get));
router.put('/:id', asyncHandler(holidayController.update));
router.delete('/:id', asyncHandler(holidayController.remove));

module.exports = router;
