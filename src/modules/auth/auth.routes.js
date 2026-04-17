const express = require('express');
const rateLimit = require('express-rate-limit');
const asyncHandler = require('../../utils/asyncHandler');
const authenticate = require('../../middleware/authenticate');
const orgGuard = require('../../middleware/orgGuard');
const authController = require('./auth.controller');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'AUTH_011',
      message: 'Too many login attempts. Please try again later.',
      details: [],
    },
  },
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'AUTH_016',
      message: 'Too many reset requests. Please try again later.',
      details: [],
    },
  },
});

const resetPasswordLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'AUTH_017',
      message: 'Too many reset attempts. Please try again later.',
      details: [],
    },
  },
});

router.post('/login', loginLimiter, asyncHandler(authController.login));
router.post('/refresh', asyncHandler(authController.refresh));
router.post('/logout', authenticate, orgGuard, asyncHandler(authController.logout));
router.post('/change-password', authenticate, orgGuard, asyncHandler(authController.changePassword));
router.post('/forgot-password', forgotPasswordLimiter, asyncHandler(authController.forgotPassword));
router.post('/reset-password', resetPasswordLimiter, asyncHandler(authController.resetPassword));

module.exports = router;
