function ok(res, data, message = 'Success', statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
  });
}

function fail(res, code, message, details = [], statusCode = 400) {
  return res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      details,
    },
  });
}

function notFound(res, message = 'Not found', details = []) {
  return fail(res, 'HTTP_404', message, details, 404);
}

function unauthorized(res, code = 'AUTH_001', message = 'Unauthorized', details = []) {
  return fail(res, code, message, details, 401);
}

module.exports = {
  ok,
  fail,
  notFound,
  unauthorized,
};
