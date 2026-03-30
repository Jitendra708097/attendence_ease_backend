const { v4: uuidv4 } = require('uuid');

function requestId(req, res, next) {
  const incomingRequestId = req.headers['x-request-id'];
  const requestIdValue = incomingRequestId || uuidv4();

  req.id = requestIdValue;
  res.setHeader('x-request-id', requestIdValue);

  next();
}

module.exports = requestId;
