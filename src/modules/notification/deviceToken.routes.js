const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const notificationController = require('./notification.controller');

const router = express.Router();

router.use(authenticate, orgGuard);

router.post('/', asyncHandler(notificationController.registerToken));
router.delete('/', asyncHandler(notificationController.deregisterToken));

module.exports = router;
