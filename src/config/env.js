const path = require('path');
const dotenv = require('dotenv');

dotenv.config({
  path: process.env.ENV_FILE || path.resolve(process.cwd(), '.env'),
});

function readEnv(key, fallback) {
  const value = process.env[key];

  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return value;
}

function readRequiredEnv(key) {
  const value = readEnv(key);

  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

function parseBoolean(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  return String(value).toLowerCase() === 'true';
}

function parseNumber(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number(value);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function parseJson(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return defaultValue;
  }
}

const env = {
  nodeEnv: readEnv('NODE_ENV', 'development'),
  port: parseNumber(readEnv('PORT', 3000), 3000),
  database: {
    host: readRequiredEnv('DB_HOST'),
    port: parseNumber(readEnv('DB_PORT', 5432), 5432),
    name: readRequiredEnv('DB_NAME'),
    user: readRequiredEnv('DB_USER'),
    password: readEnv('DB_PASS', readEnv('DB_PASSWORD', '')),
    ssl: parseBoolean(readEnv('DB_SSL', false), false),
  },
  redis: {
    url: readEnv('REDIS_URL'),
    host: readEnv('REDIS_HOST'),
    port: parseNumber(readEnv('REDIS_PORT', 6379), 6379),
    username: readEnv('REDIS_USERNAME'),
    password: readEnv('REDIS_PASSWORD'),
  },
  jwt: {
    accessSecret: readEnv('JWT_ACCESS_SECRET', readEnv('JWT_SECRET', 'replace-with-access-secret')),
    refreshSecret: readRequiredEnv('JWT_REFRESH_SECRET'),
    accessExpiry: readEnv('JWT_ACCESS_EXPIRY', '15m'),
    refreshExpiry: readEnv('JWT_REFRESH_EXPIRY', '30d'),
  },
  aws: {
    region: readEnv('AWS_REGION', ''),
    accessKeyId: readEnv('AWS_ACCESS_KEY_ID', ''),
    secretAccessKey: readEnv('AWS_SECRET_ACCESS_KEY', ''),
    rekognitionCollectionId: readEnv('AWS_REKOGNITION_COLLECTION_ID', ''),
  },
  cloudinary: {
    cloudName: readEnv('CLOUDINARY_CLOUD_NAME', ''),
    apiKey: readEnv('CLOUDINARY_API_KEY', ''),
    apiSecret: readEnv('CLOUDINARY_API_SECRET', ''),
  },
  firebase: {
    serviceAccountJson: parseJson(readEnv('FIREBASE_SERVICE_ACCOUNT_JSON', '{}'), {}),
  },
  googleMapsApiKey: readEnv('GOOGLE_MAPS_API_KEY', ''),
  frontend: {
    adminUrl: readEnv('FRONTEND_ADMIN_URL', readEnv('ADMIN_WEB_URL')),
    superadminUrl: readEnv('FRONTEND_SUPERADMIN_URL', readEnv('SUPERADMIN_WEB_URL')),
    mobileUrl: readEnv('FRONTED_MOBILE_URL', readEnv('MOBILE_APP'))
  },
  smtp: {
    host: readEnv('SMTP_HOST', ''),
    port: parseNumber(readEnv('SMTP_PORT', 587), 587),
    user: readEnv('SMTP_USER', ''),
    pass: readEnv('SMTP_PASS', ''),
    from: readEnv('EMAIL_FROM', readEnv('SMTP_USER', '')),
  },
  razorpay: {
    keyId: readEnv('RAZORPAY_KEY_ID', ''),
    secret: readEnv('RAZORPAY_SECRET', ''),
    webhookSecret: readEnv('RAZORPAY_WEBHOOK_SECRET', ''),
  },
};

module.exports = env;
