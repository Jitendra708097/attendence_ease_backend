const nodemailer = require('nodemailer');
const env = require('../../config/env');

let transporter;
const ATTENDEASE_APP_DOWNLOAD_URL =
  "https://expo.dev/accounts/jitendra7080/projects/attendease/builds/27c13634-72ad-4919-a954-8a4f5376a2b7";
const SYSTEM_GENERATED_EMAIL_NOTE = 'Note: This is a system-generated email. Please do not reply.';
const SYSTEM_GENERATED_EMAIL_NOTE_HTML = '<p style="margin-top: 24px; color: #6b7280; font-size: 13px;"><strong>Note:</strong> This is a system-generated email. Please do not reply.</p>';

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
  const greeting = `Welcome to ${organisationName}. Your employee account has been created by the admin.`;

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
      'Install the AttendEase mobile app:',
      ATTENDEASE_APP_DOWNLOAD_URL,
      '',
      'Android install guide:',
      '1. Open the link on your Android phone.',
      '2. Download the APK/build file.',
      '3. If Android blocks the install, tap Settings when prompted.',
      '4. Enable "Install unknown apps" or "Allow from this source" for your browser or file manager.',
      '5. Go back and install the app.',
      '6. Open AttendEase and log in using the email and temporary password above.',
      '',
      'If you do not see the install option, check your Downloads folder and open the downloaded file from there.',
      '',
      'Please sign in and change your password after your first login.',
      '',
      SYSTEM_GENERATED_EMAIL_NOTE,
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
        <div style="margin: 20px 0; padding: 16px; border: 1px solid #dbeafe; border-radius: 8px; background: #eff6ff;">
          <p style="margin: 0 0 10px;"><strong>Install the AttendEase mobile app</strong></p>
          <p style="margin: 0 0 12px;">
            <a href="${ATTENDEASE_APP_DOWNLOAD_URL}" style="color: #1677ff;">
              Download AttendEase app
            </a>
          </p>
          <p style="margin: 0 0 8px;"><strong>Android install guide:</strong></p>
          <ol style="margin: 0; padding-left: 20px;">
            <li>Open the link on your Android phone.</li>
            <li>Download the APK/build file.</li>
            <li>If Android blocks the install, tap <strong>Settings</strong> when prompted.</li>
            <li>Enable <strong>Install unknown apps</strong> or <strong>Allow from this source</strong> for your browser or file manager.</li>
            <li>Go back and install the app.</li>
            <li>Open AttendEase and log in using the email and temporary password above.</li>
          </ol>
          <p style="margin: 12px 0 0; color: #4b5563; font-size: 13px;">
            If you do not see the install option, check your Downloads folder and open the downloaded file from there.
          </p>
        </div>
        <p>Please sign in and change your password after your first login.</p>
        ${SYSTEM_GENERATED_EMAIL_NOTE_HTML}
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
      SYSTEM_GENERATED_EMAIL_NOTE,
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
        ${SYSTEM_GENERATED_EMAIL_NOTE_HTML}
        <p>Regards,<br />${organisationName} Team</p>
      </div>
    `,
  };
}

function buildBillingAlertEmail({ organisationName, adminName, alertType, customMessage }) {
  const alertCopy = {
    payment_due: {
      subject: `${organisationName} payment due reminder`,
      heading: 'Your AttendEase payment is due.',
    },
    payment_overdue: {
      subject: `${organisationName} payment overdue`,
      heading: 'Your AttendEase payment is overdue.',
    },
    payment_failed: {
      subject: `${organisationName} payment failed`,
      heading: 'We could not process your AttendEase payment.',
    },
    suspension_warning: {
      subject: `${organisationName} suspension warning`,
      heading: 'Your AttendEase account is at risk of suspension.',
    },
    organisation_suspended: {
      subject: `${organisationName} account suspended`,
      heading: 'Your AttendEase account is currently suspended.',
    },
    trial_expiring: {
      subject: `${organisationName} trial ending soon`,
      heading: 'Your AttendEase trial is ending soon.',
    },
  };

  const fallbackCopy = {
    subject: `${organisationName} billing alert`,
    heading: 'There is an important billing update for your AttendEase account.',
  };

  const copy = alertCopy[alertType] || fallbackCopy;
  const detail = customMessage || 'Please review your organisation billing status in the AttendEase admin portal.';

  return {
    subject: copy.subject,
    text: [
      `Hello ${adminName},`,
      '',
      copy.heading,
      '',
      detail,
      '',
      'If you need help, please contact the AttendEase support team.',
      '',
      SYSTEM_GENERATED_EMAIL_NOTE,
      '',
      'Regards,',
      'AttendEase Team',
    ].join('\n'),
    html: `
      <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.6;">
        <p>Hello ${adminName},</p>
        <p>${copy.heading}</p>
        <p>${detail}</p>
        <p>If you need help, please contact the AttendEase support team.</p>
        ${SYSTEM_GENERATED_EMAIL_NOTE_HTML}
        <p>Regards,<br />AttendEase Team</p>
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

async function sendOrgAdminBillingAlertEmail({ to, organisationName, adminName, alertType, customMessage }) {
  const mailTransporter = getTransporter();

  if (!mailTransporter) {
    return {
      sent: false,
      skipped: true,
      reason: 'smtp_not_configured',
    };
  }

  const emailContent = buildBillingAlertEmail({
    organisationName,
    adminName,
    alertType,
    customMessage,
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
  sendOrgAdminBillingAlertEmail,
};
