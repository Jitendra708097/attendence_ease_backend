const env = require('../../config/env');

let firebaseAdmin;
let firebaseApp;

function parseServiceAccount() {
  const rawValue = env.firebase && env.firebase.serviceAccountJson
    ? env.firebase.serviceAccountJson
    : null;

  if (!rawValue) {
    return null;
  }

  try {
    return JSON.parse(rawValue);
  } catch (error) {
    console.error('[notification:fcm] Invalid FIREBASE_SERVICE_ACCOUNT_JSON:', error.message);
    return null;
  }
}

function getFirebaseAdmin() {
  if (firebaseAdmin !== undefined) {
    return firebaseAdmin;
  }

  try {
    firebaseAdmin = require('firebase-admin');
  } catch (error) {
    firebaseAdmin = null;
  }

  return firebaseAdmin;
}

function getFirebaseApp() {
  if (firebaseApp !== undefined) {
    return firebaseApp;
  }

  const admin = getFirebaseAdmin();
  const serviceAccount = parseServiceAccount();

  if (!admin || !serviceAccount) {
    firebaseApp = null;
    return firebaseApp;
  }

  if (admin.apps && admin.apps.length > 0) {
    firebaseApp = admin.app();
    return firebaseApp;
  }

  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  return firebaseApp;
}

async function sendMulticast({ tokens, notification, data = {} }) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return {
      successCount: 0,
      failureCount: 0,
      responses: [],
      skipped: true,
      reason: 'no_tokens',
    };
  }

  const app = getFirebaseApp();

  if (!app) {
    return {
      successCount: 0,
      failureCount: 0,
      responses: tokens.map(() => ({ success: false, skipped: true })),
      skipped: true,
      reason: 'firebase_admin_unavailable',
    };
  }

  const admin = getFirebaseAdmin();

  return admin.messaging(app).sendEachForMulticast({
    tokens,
    notification,
    data: Object.entries(data).reduce((accumulator, [key, value]) => {
      accumulator[key] = value == null ? '' : String(value);
      return accumulator;
    }, {}),
  });
}

module.exports = {
  sendMulticast,
};
