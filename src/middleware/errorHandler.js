function errorHandler(error, req, res, next) {
  const statusCode = error.statusCode || 500;
  const code = error.code || 'SERVER_500';
  const message = error.message || 'Internal server error';
  const details = error.details || [];

  if (res.headersSent) {
    return next(error);
  }

  if (statusCode >= 500) {
    console.error(`[${req.id}]`, error);
  }

  return res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      details,
    },
  });
}

module.exports = errorHandler;
