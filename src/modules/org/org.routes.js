const express = require('express');
const multer = require('multer');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const roleGuard = require('../../middleware/roleGuard');
const orgController = require('./org.controller');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

router.use(authenticate, orgGuard, roleGuard('admin', 'superadmin'));

router.get('/stats', asyncHandler(orgController.stats));
router.get('/info', asyncHandler(orgController.info));
router.get('/settings', asyncHandler(orgController.settings));
router.post('/logo', upload.single('file'), asyncHandler(orgController.uploadLogo));
router.put('/profile', asyncHandler(orgController.updateProfile));
router.put('/settings', asyncHandler(orgController.updateSettings));

module.exports = router;
