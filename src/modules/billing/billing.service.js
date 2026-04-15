const crypto = require('crypto');
const { Op } = require('sequelize');
const env = require('../../config/env');
const { sequelize } = require('../../config/database');
const { Employee, Organisation, PaymentRecord } = require('../../models');
const { PLAN_PRICES, PLAN_LABELS } = require('../../utils/constants');

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
  return Number(PLAN_PRICES[plan] || 0);
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

function normalizeInvoice(payment, fallback = {}) {
  return {
    id: payment.invoiceId || fallback.id,
    invoiceNumber: payment.invoiceNumber || fallback.invoiceNumber,
    amount: Number(payment.amount || fallback.amount || 0),
    currency: payment.currency || fallback.currency || 'INR',
    date: payment.date || fallback.date,
    dueDate: payment.dueDate || fallback.dueDate,
    status: payment.status || fallback.status || 'paid',
    paidAt: payment.paidAt || null,
    employeeCount: Number(payment.employeeCount || fallback.employeeCount || 0),
    plan: payment.plan || fallback.plan || 'trial',
    planLabel: payment.planLabel || fallback.planLabel || getPlanLabel(payment.plan || fallback.plan),
    period: payment.period || fallback.period || null,
    razorpayOrderId: payment.razorpayOrderId || null,
    razorpayPaymentId: payment.razorpayPaymentId || null,
  };
}

async function buildBillingSnapshot(orgId) {
  const organisation = await getOrganisation(orgId);
  const employeeCount = await getEmployeeCount(orgId);
  const settings = getBillingSettings(organisation);
  const payments = Array.isArray(settings.payments) ? settings.payments : [];
  const monthKey = getMonthKey();
  const periodStart = getPeriodStart();
  const periodEnd = getPeriodEnd();
  const dueDate = getDueDate();
  const plan = organisation.plan || 'trial';
  const amount = employeeCount * getPlanPrice(plan);
  const invoiceId = `inv-${organisation.id}-${monthKey}`;
  const invoiceNumber = formatInvoiceNumber(organisation.id, monthKey);

  const currentPayment = payments.find((payment) => payment.invoiceId === invoiceId);
  const currentInvoice = normalizeInvoice(
    currentPayment,
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
      planLabel: getPlanLabel(plan),
      period: {
        key: monthKey,
        start: periodStart.toISOString(),
        end: periodEnd.toISOString(),
      },
    }
  );

  const historicalInvoices = payments
    .filter((payment) => payment.invoiceId !== invoiceId)
    .map((payment) => normalizeInvoice(payment))
    .sort((a, b) => new Date(b.date || b.paidAt || 0) - new Date(a.date || a.paidAt || 0));

  const invoices = [currentInvoice, ...historicalInvoices].sort(
    (a, b) => new Date(b.date || b.paidAt || 0) - new Date(a.date || a.paidAt || 0)
  );

  return {
    organisation,
    employeeCount,
    currentInvoice,
    invoices,
    settings,
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
  const { organisation, employeeCount, currentInvoice } = await buildBillingSnapshot(orgId);
  const trialEndsAt = organisation.trial_ends_at;
  const isTrial = organisation.plan === 'trial';
  const features = [
    `${employeeCount} active employees`,
    `${getPlanLabel(organisation.plan)} billing model`,
    isTrial ? '15 day free trial' : 'Monthly organisation billing',
  ];

  return {
    name: getPlanLabel(organisation.plan),
    code: organisation.plan,
    price: getPlanPrice(organisation.plan),
    billingUnit: 'employee/month',
    employeeCount,
    monthlyAmount: currentInvoice.amount,
    currency: 'INR',
    trialEndsAt,
    features,
  };
}

async function getInvoices(orgId) {
  const { invoices } = await buildBillingSnapshot(orgId);
  return { invoices };
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
          amount: Math.round(existing?.amount_paise / 100),
          paidAt: existing?.created_at.toISOString(),
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
    filename: `${invoice.invoiceNumber}.txt`,
    content: [
      `AttendEase Invoice`,
      `Organisation: ${organisation.name}`,
      `Invoice: ${invoice.invoiceNumber}`,
      `Amount: INR ${invoice.amount}`,
      `Status: ${invoice.status}`,
      `Date: ${invoice.date}`,
      `Due Date: ${invoice.dueDate}`,
      invoice.paidAt ? `Paid At: ${invoice.paidAt}` : null,
    ].filter(Boolean).join('\n'),
  };
}

module.exports = {
  getCurrentPlan,
  getInvoices,
  createInvoiceOrder,
  verifyInvoicePayment,
  downloadInvoice,
};
