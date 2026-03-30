function notFound(req, res, next) {
  const error = new Error(`Route not found: ${req.originalUrl}`);
  error.statusCode = 404;
  error.code = 'HTTP_404';
  next(error);
}

module.exports = notFound;
