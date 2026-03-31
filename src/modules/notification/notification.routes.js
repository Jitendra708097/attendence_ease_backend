const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const notificationController = require('./notification.controller');

const router = express.Router();

router.use(authenticate, orgGuard);

router.get('/', asyncHandler(notificationController.list));
router.post('/read', asyncHandler(notificationController.read));
router.post('/read-all', asyncHandler(notificationController.readAll));
router.get('/unread-count', asyncHandler(notificationController.unreadCount));
router.post('/register-token', asyncHandler(notificationController.registerToken));

module.exports = router;
