const nodemailer = require('nodemailer');
const env = require('../../config/env');

let transporter;

function isEmailConfigured() {
  return Boolean(env.smtp.host && env.smtp.port && env.smtp.user && env.smtp.pass && env.smtp.from);
}

function getTransporter() {
  if (!isEmailConfigured()) {
    return null;
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: Number(env.smtp.port) === 465,
      auth: {
        user: env.smtp.user,
        pass: env.smtp.pass,
      },
    });
  }

  return transporter;
}

function buildWelcomeEmail({ organisationName, employeeName, employeeEmail, tempPassword }) {
  const greeting = `Welcome to ${organisationName}. Your employee account has been created by the admin portal.`;

  return {
    subject: `${organisationName} employee account details`,
    text: [
      `Hello ${employeeName},`,
      '',
      greeting,
      '',
      `Organisation: ${organisationName}`,
      `Login Email: ${employeeEmail}`,
      `Temporary Password: ${tempPassword}`,
      '',
      'Please sign in and change your password after your first login.',
      '',
      `Regards,`,
      `${organisationName} Team`,
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
        <p>Hello ${employeeName},</p>
        <p>${greeting}</p>
        <p><strong>Organisation:</strong> ${organisationName}</p>
        <p><strong>Login Email:</strong> ${employeeEmail}</p>
        <p><strong>Temporary Password:</strong> ${tempPassword}</p>
        <p>Please sign in and change your password after your first login.</p>
        <p>Regards,<br />${organisationName} Team</p>
      </div>
    `,
  };
}

function buildPasswordResetOtpEmail({ organisationName, employeeName, otp, expiresInMinutes }) {
  const greeting = `We received a request to reset your ${organisationName} password.`;

  return {
    subject: `${organisationName} password reset code`,
    text: [
      `Hello ${employeeName},`,
      '',
      greeting,
      '',
      `Your verification code is: ${otp}`,
      `This code will expire in ${expiresInMinutes} minutes.`,
      '',
      'If you did not request a password reset, you can ignore this email.',
      '',
      `Regards,`,
      `${organisationName} Team`,
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
        <p>Hello ${employeeName},</p>
        <p>${greeting}</p>
        <p style="margin: 24px 0;">
          <span style="display: inline-block; font-size: 28px; letter-spacing: 8px; font-weight: 700; color: #0d7377;">
            ${otp}
          </span>
        </p>
        <p>This code will expire in <strong>${expiresInMinutes} minutes</strong>.</p>
        <p>If you did not request a password reset, you can ignore this email.</p>
        <p>Regards,<br />${organisationName} Team</p>
      </div>
    `,
  };
}

async function sendWelcomeEmployeeEmail({ to, organisationName, employeeName, employeeEmail, tempPassword }) {
  const mailTransporter = getTransporter();

  if (!mailTransporter) {
    return {
      sent: false,
      skipped: true,
      reason: 'smtp_not_configured',
    };
  }

  const emailContent = buildWelcomeEmail({
    organisationName,
    employeeName,
    employeeEmail,
    tempPassword,
  });

  const info = await mailTransporter.sendMail({
    from: env.smtp.from,
    to,
    subject: emailContent.subject,
    text: emailContent.text,
    html: emailContent.html,
  });

  return {
    sent: true,
    skipped: false,
    messageId: info.messageId,
  };
}

async function sendPasswordResetOtpEmail({ to, organisationName, employeeName, otp, expiresInMinutes }) {
  const mailTransporter = getTransporter();

  if (!mailTransporter) {
    return {
      sent: false,
      skipped: true,
      reason: 'smtp_not_configured',
    };
  }

  const emailContent = buildPasswordResetOtpEmail({
    organisationName,
    employeeName,
    otp,
    expiresInMinutes,
  });

  const info = await mailTransporter.sendMail({
    from: env.smtp.from,
    to,
    subject: emailContent.subject,
    text: emailContent.text,
    html: emailContent.html,
  });

  return {
    sent: true,
    skipped: false,
    messageId: info.messageId,
  };
}

module.exports = {
  isEmailConfigured,
  sendWelcomeEmployeeEmail,
  sendPasswordResetOtpEmail,
};
