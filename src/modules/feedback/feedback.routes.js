const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const blockImpersonatedWrites = require('../../middleware/blockImpersonatedWrites');
const feedbackController = require('./feedback.controller');

const router = express.Router();

router.use(authenticate, orgGuard);

router.post('/', blockImpersonatedWrites, asyncHandler(feedbackController.submit));

module.exports = router;
