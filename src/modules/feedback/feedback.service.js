const { Op } = require('sequelize');
const { Employee, Organisation, UserFeedback, sequelize } = require('../../models');
const { getPagination } = require('../../utils/pagination');

const FEEDBACK_TYPES = new Set(['bug', 'suggestion', 'confusing', 'other']);

function createError(code, message, statusCode, details = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function normalizeType(value) {
  return String(value || '').trim().toLowerCase();
}

function toDto(record) {
  const organisation = record.organisation || record.Organisation || null;
  const employee = record.employee || null;

  return {
    id: record.id,
    orgId: record.org_id,
    orgName: organisation?.name || null,
    orgSlug: organisation?.slug || null,
    empId: record.emp_id,
    employeeName: record.employee_name || employee?.name || null,
    employeeEmail: record.employee_email || employee?.email || null,
    employeePhone: record.employee_phone || employee?.phone || null,
    employeeCode: record.employee_code || employee?.emp_code || null,
    rating: record.rating,
    feedbackType: record.feedback_type,
    message: record.message,
    appContext: record.app_context || {},
    createdAt: record.created_at,
  };
}

function validateFeedbackPayload(payload = {}) {
  const details = [];
  const rating = Number(payload.rating);
  const feedbackType = normalizeType(payload.feedbackType || payload.feedback_type);
  const message = String(payload.message || '').trim();

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    details.push({ field: 'rating', message: 'Rating must be between 1 and 5' });
  }

  if (!FEEDBACK_TYPES.has(feedbackType)) {
    details.push({ field: 'feedbackType', message: 'Feedback type is invalid' });
  }

  if (!message) {
    details.push({ field: 'message', message: 'Message is required' });
  } else if (message.length > 3000) {
    details.push({ field: 'message', message: 'Message must be 3000 characters or less' });
  }

  if (details.length > 0) {
    throw createError('FDB_001', 'Invalid feedback payload', 422, details);
  }

  return { rating, feedbackType, message };
}

async function submitFeedback({ orgId, empId, payload = {} }) {
  const { rating, feedbackType, message } = validateFeedbackPayload(payload);

  const employee = await Employee.findOne({
    where: {
      id: empId,
      org_id: orgId,
      is_active: true,
    },
    attributes: ['id', 'name', 'email', 'phone', 'emp_code'],
  });

  if (!employee) {
    throw createError('HTTP_404', 'Employee not found', 404);
  }

  const feedback = await UserFeedback.create({
    org_id: orgId,
    emp_id: empId,
    rating,
    feedback_type: feedbackType,
    message,
    employee_name: employee.name || null,
    employee_email: employee.email || null,
    employee_phone: employee.phone || null,
    employee_code: employee.emp_code || null,
    app_context: payload.appContext && typeof payload.appContext === 'object' ? payload.appContext : {},
  });

  return toDto(feedback);
}

function buildFeedbackWhere(query = {}) {
  const where = {};

  if (query.orgId) {
    where.org_id = query.orgId;
  }

  if (query.empId) {
    where.emp_id = query.empId;
  }

  if (query.feedbackType && FEEDBACK_TYPES.has(normalizeType(query.feedbackType))) {
    where.feedback_type = normalizeType(query.feedbackType);
  }

  if (query.rating) {
    const rating = Number(query.rating);
    if (Number.isInteger(rating) && rating >= 1 && rating <= 5) {
      where.rating = rating;
    }
  }

  if (query.search) {
    const search = String(query.search).trim();
    if (search) {
      where[Op.or] = [
        { message: { [Op.iLike]: `%${search}%` } },
        { employee_name: { [Op.iLike]: `%${search}%` } },
        { employee_email: { [Op.iLike]: `%${search}%` } },
        { employee_phone: { [Op.iLike]: `%${search}%` } },
        { employee_code: { [Op.iLike]: `%${search}%` } },
      ];
    }
  }

  if (query.startDate || query.endDate) {
    where.created_at = {};
    if (query.startDate) {
      where.created_at[Op.gte] = new Date(query.startDate);
    }
    if (query.endDate) {
      where.created_at[Op.lte] = new Date(query.endDate);
    }
  }

  return where;
}

async function listFeedback(query = {}) {
  const { limit, offset, page } = getPagination(query);
  const where = buildFeedbackWhere(query);

  const result = await UserFeedback.findAndCountAll({
    where,
    include: [
      {
        model: Organisation,
        as: 'organisation',
        attributes: ['id', 'name', 'slug'],
        required: false,
        paranoid: false,
      },
      {
        model: Employee,
        as: 'employee',
        attributes: ['id', 'name', 'email', 'phone', 'emp_code'],
        required: false,
        paranoid: false,
      },
    ],
    order: [['created_at', 'DESC']],
    limit,
    offset,
    distinct: true,
  });

  return {
    feedback: result.rows.map(toDto),
    total: result.count,
    page,
    limit,
    totalPages: Math.ceil(result.count / limit) || 1,
  };
}

async function getFeedbackSummary(query = {}) {
  const where = buildFeedbackWhere(query);
  const [total, avgRatingRow, typeRows, ratingRows] = await Promise.all([
    UserFeedback.count({ where }),
    UserFeedback.findOne({
      where,
      attributes: [[sequelize.fn('AVG', sequelize.col('rating')), 'avgRating']],
      raw: true,
    }),
    UserFeedback.findAll({
      where,
      attributes: ['feedback_type', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      group: ['feedback_type'],
      raw: true,
    }),
    UserFeedback.findAll({
      where,
      attributes: ['rating', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      group: ['rating'],
      raw: true,
    }),
  ]);

  return {
    total,
    avgRating: avgRatingRow?.avgRating ? Number(Number(avgRatingRow.avgRating).toFixed(1)) : 0,
    byType: typeRows.reduce((acc, row) => {
      acc[row.feedback_type] = Number(row.count || 0);
      return acc;
    }, {}),
    byRating: ratingRows.reduce((acc, row) => {
      acc[row.rating] = Number(row.count || 0);
      return acc;
    }, {}),
  };
}

module.exports = {
  submitFeedback,
  listFeedback,
  getFeedbackSummary,
};
