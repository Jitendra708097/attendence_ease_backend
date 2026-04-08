const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const roleGuard = require('../../middleware/roleGuard');
const billingController = require('./billing.controller');

const router = express.Router();

router.use(authenticate, orgGuard, roleGuard('admin', 'superadmin'));

router.get('/current-plan', asyncHandler(billingController.currentPlan));
router.get('/invoices', asyncHandler(billingController.invoices));
router.get('/invoices/:invoiceId/download', asyncHandler(billingController.downloadInvoice));
router.post('/invoices/:invoiceId/create-order', asyncHandler(billingController.createOrder));
router.post('/verify-payment', asyncHandler(billingController.verifyPayment));

module.exports = router;
