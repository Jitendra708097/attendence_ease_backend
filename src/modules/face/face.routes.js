const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const roleGuard = require('../../middleware/roleGuard');
const faceController = require('./face.controller');

const router = express.Router();

router.use(authenticate, orgGuard);

router.post('/enroll', asyncHandler(faceController.enroll));
router.post('/verify', asyncHandler(faceController.verify));
router.get('/status/:empId', asyncHandler(faceController.status));
router.delete('/:empId', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(faceController.remove));

module.exports = router;
