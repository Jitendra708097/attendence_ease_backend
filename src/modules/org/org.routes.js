const express = require('express');
const multer = require('multer');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const roleGuard = require('../../middleware/roleGuard');
const blockImpersonatedWrites = require('../../middleware/blockImpersonatedWrites');
const orgController = require('./org.controller');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});

router.use(authenticate, orgGuard);

router.get('/stats', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(orgController.stats));
router.get('/info', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(orgController.info));
router.get('/settings', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(orgController.settings));
router.get('/settings-health', roleGuard('admin', 'manager', 'superadmin'), asyncHandler(orgController.settingsHealth));
router.use(roleGuard('admin', 'superadmin'));
router.post('/logo', blockImpersonatedWrites, upload.single('file'), asyncHandler(orgController.uploadLogo));
router.delete('/logo', blockImpersonatedWrites, asyncHandler(orgController.removeLogo));
router.put('/profile', blockImpersonatedWrites, asyncHandler(orgController.updateProfile));
router.put('/settings', blockImpersonatedWrites, asyncHandler(orgController.updateSettings));

module.exports = router;
