const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const env = require('./config/env');
const authRoutes = require('./modules/auth/auth.routes');
const attendanceRoutes = require('./modules/attendance/attendance.routes');
const branchRoutes = require('./modules/branch/branch.routes');
const departmentRoutes = require('./modules/department/department.routes');
const employeeRoutes = require('./modules/employee/employee.routes');
const faceRoutes = require('./modules/face/face.routes');
const leaveRoutes = require('./modules/leave/leave.routes');
const notificationRoutes = require('./modules/notification/notification.routes');
const orgRoutes = require('./modules/org/org.routes');
const regularisationRoutes = require('./modules/regularisation/regularisation.routes');
const shiftRoutes = require('./modules/shift/shift.routes');
const superadminRoutes = require('./modules/superadmin/superadmin.routes');
const billingRoutes = require('./modules/billing/billing.routes');
const requestId = require('./middleware/requestId');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');
// const face = require('./routes/face.routes');

const app = express();

const allowedOrigins = [env.frontend.adminUrl, env.frontend.superadminUrl,env.frontend.mobileUrl].filter(Boolean);

morgan.token('request-id', (req) => req.id || '-');

app.use(requestId);
app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(Object.assign(new Error('Origin not allowed by CORS'), { statusCode: 403, code: 'HTTP_403' }));
    },
    credentials: true,
  })
);
app.use(express.json());
app.use(
  morgan(':method :url :status :response-time ms - :res[content-length] req_id=:request-id', {
    stream: {
      write(message) {
        process.stdout.write(message);
      },
    },
  })
);

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/attendance', attendanceRoutes);
app.use('/api/v1/branches', branchRoutes);
app.use('/api/v1/departments', departmentRoutes);
app.use('/api/v1/employees', employeeRoutes);
app.use('/api/v1/face', faceRoutes);
app.use('/api/v1/leave', leaveRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/org', orgRoutes);
app.use('/api/v1/regularisations', regularisationRoutes);
app.use('/api/v1/shifts', shiftRoutes);
app.use('/api/v1/billing', billingRoutes);
app.use('/api/v1/superadmin', superadminRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
