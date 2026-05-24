const crypto = require('crypto');
const { Op } = require('sequelize');
const env = require('../../config/env');
const { sequelize } = require('../../config/database');
const { Employee, Organisation, PaymentRecord } = require('../../models');
const { PLAN_LABELS } = require('../../utils/constants');
const planService = require('../plan/plan.service');

function createError(code, message, statusCode, details = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function getMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function getPeriodStart(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function getPeriodEnd(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59, 999));
}

function getDueDate(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 10, 23, 59, 59, 999));
}

function formatInvoiceNumber(orgId, monthKey) {
  return `AE-${monthKey.replace('-', '')}-${String(orgId).slice(0, 8).toUpperCase()}`;
}

function toAmountPaise(amount) {
  return Math.max(0, Math.round(Number(amount || 0) * 100));
}

function getPlanLabel(plan) {
  return PLAN_LABELS[plan] || String(plan || 'plan').replace(/(^\w|\s\w)/g, (match) => match.toUpperCase());
}

function getPlanPrice(plan) {
  const fallback = planService.DEFAULT_PLAN_DEFINITIONS.find((definition) => definition.code === plan);
  return Number(fallback?.price_per_employee || fallback?.monthly_price || 0);
}

async function getOrganisation(orgId) {
  const organisation = await Organisation.findOne({ where: { id: orgId } });

  if (!organisation) {
    throw createError('HTTP_404', 'Organisation not found', 404);
  }

  return organisation;
}

async function getEmployeeCount(orgId) {
  return Employee.count({
    where: {
      org_id: orgId,
      is_active: true,
      role: {
        [Op.in]: ['admin', 'manager', 'employee'],
      },
    },
  });
}

function getBillingSettings(organisation) {
  return organisation.settings?.billing || { payments: [] };
}

function normalizeInvoice(payment = {}, fallback = {}) {
  const source = payment || {};
  const date = source.date || fallback.date;
  const dueDate = source.dueDate || fallback.dueDate;
  const status = source.status || fallback.status || 'paid';

  return {
    id: source.invoiceId || fallback.id,
    invoiceNumber: source.invoiceNumber || fallback.invoiceNumber,
    amount: Number(source.amount || fallback.amount || 0),
    currency: source.currency || fallback.currency || 'INR',
    date,
    dueDate,
    status,
    paidAt: source.paidAt || null,
    employeeCount: Number(source.employeeCount || fallback.employeeCount || 0),
    plan: source.plan || fallback.plan || 'trial',
    planLabel: source.planLabel || fallback.planLabel || getPlanLabel(source.plan || fallback.plan),
    period: source.period || fallback.period || null,
    razorpayOrderId: source.razorpayOrderId || null,
    razorpayPaymentId: source.razorpayPaymentId || null,
    isCurrent: Boolean(source.isCurrent || fallback.isCurrent),
    isOverdue: status !== 'paid' && dueDate ? new Date(dueDate).getTime() < Date.now() : false,
  };
}

function paymentRecordToInvoice(record, fallback = {}) {
  const invoiceId = record.invoice_id;
  const match = /^inv-(.+)-(\d{4}-\d{2})$/.exec(invoiceId || '');
  const monthKey = fallback.period?.key || match?.[2] || getMonthKey(record.created_at || new Date());
  const periodStart = fallback.period?.start || `${monthKey}-01T00:00:00.000Z`;
  const periodEnd =
    fallback.period?.end ||
    getPeriodEnd(new Date(`${monthKey}-01T00:00:00.000Z`)).toISOString();
  const dueDate = fallback.dueDate || getDueDate(new Date(`${monthKey}-01T00:00:00.000Z`)).toISOString();
  const orgId = fallback.orgId || match?.[1] || record.org_id;

  return normalizeInvoice(
    {
      invoiceId,
      invoiceNumber: fallback.invoiceNumber || formatInvoiceNumber(orgId, monthKey),
      amount: Number(record.amount_paise || 0) / 100,
      currency: record.currency || 'INR',
      date: fallback.date || periodStart,
      dueDate,
      status: record.status === 'verified' ? 'paid' : record.status || 'paid',
      paidAt: record.created_at ? record.created_at.toISOString() : null,
      employeeCount: fallback.employeeCount,
      plan: fallback.plan,
      planLabel: fallback.planLabel,
      period: {
        key: monthKey,
        start: periodStart,
        end: periodEnd,
      },
      razorpayOrderId: record.razorpay_order_id,
      razorpayPaymentId: record.razorpay_payment_id,
    },
    fallback
  );
}

function formatDisplayDate(value) {
  if (!value) {
    return '-';
  }

  return new Date(value).toLocaleDateString('en-IN', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}

function formatDisplayAmount(amount, currency = 'INR') {
  return `${currency} ${Number(amount || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInvoiceHtml({ invoice, organisation }) {
  const period = invoice.period || {};
  const lineAmount = Number(invoice.amount || 0);
  const statusLabel = String(invoice.status || 'due').toUpperCase();
  const planLabel = invoice.planLabel || getPlanLabel(invoice.plan);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(invoice.invoiceNumber)} - AttendEase Invoice</title>
  <style>
    body { margin: 0; background: #f4f6f8; color: #111827; font-family: Arial, sans-serif; }
    .page { max-width: 820px; margin: 32px auto; background: #ffffff; padding: 40px; border: 1px solid #e5e7eb; }
    .header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #111827; padding-bottom: 24px; }
    .brand { font-size: 28px; font-weight: 700; letter-spacing: 0; }
    .muted { color: #6b7280; font-size: 13px; line-height: 1.6; }
    .invoice-title { text-align: right; }
    .invoice-title h1 { margin: 0 0 8px; font-size: 24px; }
    .status { display: inline-block; padding: 6px 10px; border-radius: 4px; background: #ecfdf3; color: #027a48; font-weight: 700; font-size: 12px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 28px 0; }
    .section-title { font-size: 12px; font-weight: 700; color: #374151; text-transform: uppercase; margin-bottom: 8px; }
    .box { border: 1px solid #e5e7eb; padding: 16px; border-radius: 6px; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th { background: #f9fafb; text-align: left; color: #374151; font-size: 12px; text-transform: uppercase; }
    th, td { padding: 12px; border-bottom: 1px solid #e5e7eb; }
    .right { text-align: right; }
    .total { display: flex; justify-content: flex-end; margin-top: 24px; }
    .total-box { width: 320px; border: 1px solid #111827; border-radius: 6px; overflow: hidden; }
    .total-row { display: flex; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #e5e7eb; }
    .total-row.final { background: #111827; color: #ffffff; font-weight: 700; border-bottom: 0; }
    .footer { margin-top: 36px; padding-top: 18px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #6b7280; }
    @media print { body { background: #ffffff; } .page { margin: 0; border: 0; } }
  </style>
</head>
<body>
  <main class="page">
    <section class="header">
      <div>
        <div class="brand">AttendEase</div>
        <div class="muted">Employee attendance management platform</div>
      </div>
      <div class="invoice-title">
        <h1>Invoice</h1>
        <div class="muted">${escapeHtml(invoice.invoiceNumber)}</div>
        <div class="status">${escapeHtml(statusLabel)}</div>
      </div>
    </section>

    <section class="grid">
      <div class="box">
        <div class="section-title">Bill To</div>
        <strong>${escapeHtml(organisation.name)}</strong>
        <div class="muted">Organisation ID: ${escapeHtml(organisation.id)}</div>
      </div>
      <div class="box">
        <div class="section-title">Invoice Details</div>
        <div class="muted">Invoice Date: ${escapeHtml(formatDisplayDate(invoice.date))}</div>
        <div class="muted">Due Date: ${escapeHtml(formatDisplayDate(invoice.dueDate))}</div>
        <div class="muted">Period: ${escapeHtml(formatDisplayDate(period.start))} - ${escapeHtml(formatDisplayDate(period.end))}</div>
      </div>
    </section>

    <table>
      <thead>
        <tr>
          <th>Description</th>
          <th class="right">Employees</th>
          <th class="right">Plan</th>
          <th class="right">Amount</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>AttendEase ${escapeHtml(planLabel)} subscription</td>
          <td class="right">${escapeHtml(invoice.employeeCount)}</td>
          <td class="right">${escapeHtml(planLabel)}</td>
          <td class="right">${escapeHtml(formatDisplayAmount(lineAmount, invoice.currency))}</td>
        </tr>
      </tbody>
    </table>

    <section class="total">
      <div class="total-box">
        <div class="total-row"><span>Subtotal</span><span>${escapeHtml(formatDisplayAmount(lineAmount, invoice.currency))}</span></div>
        <div class="total-row"><span>Tax</span><span>${escapeHtml(formatDisplayAmount(0, invoice.currency))}</span></div>
        <div class="total-row final"><span>Total</span><span>${escapeHtml(formatDisplayAmount(lineAmount, invoice.currency))}</span></div>
      </div>
    </section>

    <section class="footer">
      This invoice is generated electronically by AttendEase. Trial invoices may show a zero amount and paid status because no payment is required.
    </section>
  </main>
</body>
</html>`;
}

function escapePdfText(value) {
  return String(value ?? '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function pdfTextLine(text, x, y, size = 10, font = 'F1') {
  return `BT /${font} ${size} Tf ${x} ${y} Td (${escapePdfText(text)}) Tj ET`;
}

function buildPdf(objects) {
  const chunks = ['%PDF-1.4\n'];
  const offsets = [0];

  objects.forEach((object, index) => {
    offsets[index + 1] = Buffer.byteLength(chunks.join(''), 'utf8');
    chunks.push(`${index + 1} 0 obj\n${object}\nendobj\n`);
  });

  const xrefOffset = Buffer.byteLength(chunks.join(''), 'utf8');
  chunks.push(`xref\n0 ${objects.length + 1}\n`);
  chunks.push('0000000000 65535 f \n');
  offsets.slice(1).forEach((offset) => {
    chunks.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  });
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  return Buffer.from(chunks.join(''), 'utf8');
}

function renderInvoicePdf({ invoice, organisation }) {
  const period = invoice.period || {};
  const lineAmount = Number(invoice.amount || 0);
  const statusLabel = String(invoice.status || 'due').toUpperCase();
  const planLabel = invoice.planLabel || getPlanLabel(invoice.plan);
  const lines = [
    pdfTextLine('AttendEase', 50, 790, 22, 'F2'),
    pdfTextLine('Employee attendance management platform', 50, 770, 9),
    pdfTextLine('INVOICE', 440, 790, 18, 'F2'),
    pdfTextLine(invoice.invoiceNumber, 440, 770, 10),
    pdfTextLine(`Status: ${statusLabel}`, 440, 752, 10, 'F2'),
    '50 735 m 545 735 l S',

    pdfTextLine('Bill To', 50, 705, 11, 'F2'),
    pdfTextLine(organisation.name, 50, 688, 10, 'F2'),
    pdfTextLine(`Organisation ID: ${organisation.id}`, 50, 672, 9),

    pdfTextLine('Invoice Details', 330, 705, 11, 'F2'),
    pdfTextLine(`Invoice Date: ${formatDisplayDate(invoice.date)}`, 330, 688, 9),
    pdfTextLine(`Due Date: ${formatDisplayDate(invoice.dueDate)}`, 330, 672, 9),
    pdfTextLine(`Period: ${formatDisplayDate(period.start)} - ${formatDisplayDate(period.end)}`, 330, 656, 9),

    '50 620 m 545 620 l S',
    pdfTextLine('Description', 55, 602, 10, 'F2'),
    pdfTextLine('Employees', 315, 602, 10, 'F2'),
    pdfTextLine('Plan', 390, 602, 10, 'F2'),
    pdfTextLine('Amount', 485, 602, 10, 'F2'),
    '50 590 m 545 590 l S',
    pdfTextLine(`AttendEase ${planLabel} subscription`, 55, 570, 10),
    pdfTextLine(invoice.employeeCount, 330, 570, 10),
    pdfTextLine(planLabel, 390, 570, 10),
    pdfTextLine(formatDisplayAmount(lineAmount, invoice.currency), 465, 570, 10),
    '50 552 m 545 552 l S',

    pdfTextLine('Subtotal', 380, 510, 10),
    pdfTextLine(formatDisplayAmount(lineAmount, invoice.currency), 465, 510, 10),
    pdfTextLine('Tax', 380, 492, 10),
    pdfTextLine(formatDisplayAmount(0, invoice.currency), 465, 492, 10),
    pdfTextLine('Total', 380, 468, 12, 'F2'),
    pdfTextLine(formatDisplayAmount(lineAmount, invoice.currency), 465, 468, 12, 'F2'),

    '50 115 m 545 115 l S',
    pdfTextLine('This invoice is generated electronically by AttendEase.', 50, 95, 9),
    pdfTextLine('Trial invoices may show a zero amount and paid status because no payment is required.', 50, 80, 9),
  ];

  const stream = lines.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`,
  ];

  return buildPdf(objects);
}

async function buildBillingSnapshot(orgId) {
  const organisation = await getOrganisation(orgId);
  const [employeeCount, paymentRecords] = await Promise.all([
    getEmployeeCount(orgId),
    PaymentRecord.findAll({
      where: {
        org_id: orgId,
      },
      order: [['created_at', 'DESC']],
    }),
  ]);
  const settings = getBillingSettings(organisation);
  const payments = Array.isArray(settings.payments) ? settings.payments : [];
  const monthKey = getMonthKey();
  const periodStart = getPeriodStart();
  const periodEnd = getPeriodEnd();
  const dueDate = getDueDate();
  const plan = organisation.plan || 'trial';
  const billing = await planService.getBillingForOrganisation(organisation, employeeCount);
  const amount = billing.monthlyAmount;
  const planLabel = billing.mapped?.name || getPlanLabel(plan);
  const invoiceId = `inv-${organisation.id}-${monthKey}`;
  const invoiceNumber = formatInvoiceNumber(organisation.id, monthKey);

  const currentPayment =
    payments.find((payment) => payment.invoiceId === invoiceId) ||
    paymentRecords.find((record) => record.invoice_id === invoiceId);
  const currentInvoice = normalizeInvoice(
    currentPayment && currentPayment.invoice_id
      ? paymentRecordToInvoice(currentPayment, {
          id: invoiceId,
          invoiceNumber,
          amount,
          currency: 'INR',
          date: periodStart.toISOString(),
          dueDate: dueDate.toISOString(),
          status: amount === 0 ? 'paid' : 'due',
          employeeCount,
          plan,
          planLabel,
          isCurrent: true,
          period: {
            key: monthKey,
            start: periodStart.toISOString(),
            end: periodEnd.toISOString(),
          },
        })
      : currentPayment,
    {
      id: invoiceId,
      invoiceNumber,
      amount,
      currency: 'INR',
      date: periodStart.toISOString(),
      dueDate: dueDate.toISOString(),
      status: amount === 0 ? 'paid' : 'due',
      employeeCount,
      plan,
      planLabel,
      isCurrent: true,
      period: {
        key: monthKey,
        start: periodStart.toISOString(),
        end: periodEnd.toISOString(),
      },
    }
  );

  const legacyInvoices = payments
    .filter((payment) => payment && payment.invoiceId !== invoiceId)
    .map((payment) => normalizeInvoice(payment))
    .sort((a, b) => new Date(b.date || b.paidAt || 0) - new Date(a.date || a.paidAt || 0));

  const paymentRecordInvoices = paymentRecords
    .filter((record) => record.invoice_id !== invoiceId)
    .map((record) =>
      paymentRecordToInvoice(record, {
        orgId,
        plan,
        planLabel,
      })
    );

  const historicalById = new Map();
  [...paymentRecordInvoices, ...legacyInvoices].forEach((invoice) => {
    if (!invoice?.id || historicalById.has(invoice.id)) {
      return;
    }

    historicalById.set(invoice.id, invoice);
  });

  const invoices = [currentInvoice, ...historicalById.values()].sort(
    (a, b) => new Date(b.date || b.paidAt || 0) - new Date(a.date || a.paidAt || 0)
  );

  return {
    organisation,
    employeeCount,
    currentInvoice,
    invoices,
    settings,
    planDefinition: billing.mapped,
  };
}

async function createRazorpayOrder({ amount, receipt, notes }) {
  if (!env.razorpay.keyId || !env.razorpay.secret) {
    throw createError('BILLING_004', 'Razorpay is not configured on the server', 500);
  }

  const auth = Buffer.from(`${env.razorpay.keyId}:${env.razorpay.secret}`).toString('base64');
  const response = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: toAmountPaise(amount),
      currency: 'INR',
      receipt,
      notes,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw createError(
      'BILLING_005',
      data?.error?.description || 'Unable to create Razorpay order',
      response.status || 502
    );
  }

  return data;
}

async function getCurrentPlan(orgId) {
  const { organisation, employeeCount, currentInvoice, planDefinition } = await buildBillingSnapshot(orgId);
  const trialEndsAt = organisation.trial_ends_at;
  const isTrial = organisation.plan === 'trial';
  const planName = planDefinition?.name || getPlanLabel(organisation.plan);
  const features = [
    `${employeeCount} active employees`,
    `${planName} billing model`,
    isTrial ? `${planDefinition?.trialDays || 15} day free trial` : 'Monthly organisation billing',
  ];

  return {
    name: planName,
    code: organisation.plan,
    price: planDefinition?.pricePerEmployee ?? getPlanPrice(organisation.plan),
    billingUnit: planDefinition?.billingType === 'flat' ? 'month' : 'employee/month',
    employeeCount,
    monthlyAmount: currentInvoice.amount,
    currency: 'INR',
    trialEndsAt,
    currentInvoice,
    features,
    planDefinition,
  };
}

async function getInvoices(orgId) {
  const { invoices, currentInvoice } = await buildBillingSnapshot(orgId);
  return { invoices, currentInvoice };
}

async function createInvoiceOrder(orgId, invoiceId) {
  const { organisation, currentInvoice } = await buildBillingSnapshot(orgId);

  if (currentInvoice.id !== invoiceId) {
    throw createError('HTTP_404', 'Invoice not found', 404);
  }

  if (currentInvoice.status === 'paid') {
    throw createError('BILLING_006', 'Invoice is already paid', 409);
  }

  if (!currentInvoice.amount) {
    throw createError('BILLING_007', 'Trial invoice does not require payment', 400);
  }

  const order = await createRazorpayOrder({
    amount: currentInvoice.amount,
    receipt: currentInvoice.invoiceNumber,
    notes: {
      orgId,
      invoiceId,
      orgName: organisation.name,
    },
  });

  return {
    invoice: currentInvoice,
    order: {
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
    },
    razorpayKeyId: env.razorpay.keyId,
    organisation: {
      name: organisation.name,
    },
  };
}

async function verifyInvoicePayment(orgId, payload, idempotencyKey = null) {
  const {
    invoiceId,
    razorpay_order_id: razorpayOrderId,
    razorpay_payment_id: razorpayPaymentId,
    razorpay_signature: razorpaySignature,
  } = payload;

  if (!invoiceId || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    throw createError('BILLING_008', 'Missing payment verification details', 422);
  }

  // Step 1: Verify Razorpay signature
  const generatedSignature = crypto
    .createHmac('sha256', env.razorpay.secret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  if (generatedSignature !== razorpaySignature) {
    throw createError('BILLING_009', 'Invalid payment signature', 400);
  }

  // ✅ ACID FIX: Use database transaction
  const transaction = await sequelize.transaction({
    isolationLevel: sequelize.Transaction.ISOLATION_LEVELS.SERIALIZABLE,
  });

  try {
    // Step 2: Check idempotency (if key provided)
    if (idempotencyKey) {
      const existingRecord = await PaymentRecord.findOne({
        where: { idempotency_key: idempotencyKey },
        transaction,
      });

      if (existingRecord) {
        await transaction.commit();
        return {
          invoice: normalizeInvoice({
            invoiceId: existingRecord.invoice_id,
            amount: Math.round(existingRecord.amount_paise / 100),
            paidAt: existingRecord.created_at.toISOString(),
            status: 'paid',
          }),
          verified: true,
          alreadyPaid: true,
          idempotent: true,
        };
      }
    }

    // Step 3: Check for duplicate Razorpay payment ID
    const existingByPaymentId = await PaymentRecord.findOne({
      where: { razorpay_payment_id: razorpayPaymentId },
      transaction,
    });

    if (existingByPaymentId) {
      await transaction.commit();
      return {
        invoice: normalizeInvoice({
          invoiceId: existingByPaymentId.invoice_id,
          amount: Math.round(existingByPaymentId.amount_paise / 100),
          paidAt: existingByPaymentId.created_at.toISOString(),
          status: 'paid',
        }),
        verified: true,
        alreadyPaid: true,
        duplicate: true,
      };
    }

    // Step 4: Build billing snapshot with lock
    const organisation = await Organisation.findOne({
      where: { id: orgId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!organisation) {
      await transaction.rollback();
      throw createError('HTTP_404', 'Organisation not found', 404);
    }

    const { currentInvoice } = await buildBillingSnapshot(orgId);

    if (currentInvoice.id !== invoiceId) {
      await transaction.rollback();
      throw createError('HTTP_404', 'Invoice not found', 404);
    }

    // Step 5: Create payment record (atomic insert)
    const paymentRecordDb = await PaymentRecord.create(
      {
        org_id: orgId,
        invoice_id: invoiceId,
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: razorpayPaymentId,
        razorpay_signature: razorpaySignature,
        amount_paise: toAmountPaise(currentInvoice.amount),
        currency: 'INR',
        status: 'verified',
        idempotency_key: idempotencyKey,
      },
      { transaction }
    );

    // Step 6: Update organisation settings (legacy support)
    const settings = organisation.settings || {};
    const billing = settings.billing || { payments: [] };
    const payments = Array.isArray(billing.payments) ? billing.payments : [];

    const paymentData = {
      invoiceId: currentInvoice.id,
      invoiceNumber: currentInvoice.invoiceNumber,
      amount: currentInvoice.amount,
      currency: currentInvoice.currency,
      date: currentInvoice.date,
      dueDate: currentInvoice.dueDate,
      status: 'paid',
      paidAt: new Date().toISOString(),
      employeeCount: currentInvoice.employeeCount,
      plan: currentInvoice.plan,
      planLabel: currentInvoice.planLabel,
      period: currentInvoice.period,
      razorpayOrderId,
      razorpayPaymentId,
    };

    const nextSettings = {
      ...settings,
      billing: {
        ...billing,
        payments: [paymentData, ...payments],
        lastPaymentAt: paymentData.paidAt,
      },
    };

    await organisation.update({ settings: nextSettings }, { transaction });

    // ✅ Step 7: Commit transaction (atomic guarantee)
    await transaction.commit();

    return {
      invoice: normalizeInvoice(paymentData),
      paymentRecord: {
        id: paymentRecordDb.id,
        razorpayPaymentId: paymentRecordDb.razorpay_payment_id,
      },
      verified: true,
      alreadyPaid: false,
    };
  } catch (error) {
    // ✅ Rollback on ANY error
    if (transaction) {
      await transaction.rollback().catch(() => {});
    }

    if (error.code === 'ER_DUP_ENTRY' || error.name === 'SequelizeUniqueConstraintError') {
      // Duplicate payment caught at DB level (race condition prevented)
      const existing = await PaymentRecord.findOne({
        where: { razorpay_payment_id: razorpayPaymentId },
      });

      return {
        invoice: normalizeInvoice({
          invoiceId: existing?.invoice_id,
          amount: existing ? Math.round(existing.amount_paise / 100) : 0,
          paidAt: existing?.created_at ? existing.created_at.toISOString() : null,
          status: 'paid',
        }),
        verified: true,
        alreadyPaid: true,
        dbConstraintCaught: true,
      };
    }

    throw error;
  }
}

async function downloadInvoice(orgId, invoiceId) {
  const { invoices, organisation } = await buildBillingSnapshot(orgId);
  const invoice = invoices.find((item) => item.id === invoiceId);

  if (!invoice) {
    throw createError('HTTP_404', 'Invoice not found', 404);
  }

  return {
    invoice,
    filename: `${invoice.invoiceNumber}.pdf`,
    contentType: 'application/pdf',
    encoding: 'base64',
    content: renderInvoicePdf({ invoice, organisation }).toString('base64'),
  };
}

module.exports = {
  getCurrentPlan,
  getInvoices,
  createInvoiceOrder,
  verifyInvoicePayment,
  downloadInvoice,
};
