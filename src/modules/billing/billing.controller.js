const { ok } = require('../../utils/response');
const billingService = require('./billing.service');

async function currentPlan(req, res) {
  const data = await billingService.getCurrentPlan(req.org_id);
  return ok(res, data, 'Current plan fetched');
}

async function invoices(req, res) {
  const data = await billingService.getInvoices(req.org_id);
  return ok(res, data, 'Invoices fetched');
}

async function createOrder(req, res) {
  const data = await billingService.createInvoiceOrder(req.org_id, req.params.invoiceId);
  return ok(res, data, 'Payment order created');
}

async function verifyPayment(req, res) {
  const data = await billingService.verifyInvoicePayment(
    req.org_id,
    req.body || {},
    req.idempotencyKey
  );
  return ok(res, data, 'Payment verified');
}

async function downloadInvoice(req, res) {
  const data = await billingService.downloadInvoice(req.org_id, req.params.invoiceId);
  return ok(res, data, 'Invoice download prepared');
}

module.exports = {
  currentPlan,
  invoices,
  createOrder,
  verifyPayment,
  downloadInvoice,
};
