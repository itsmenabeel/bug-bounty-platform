import dotenv from "dotenv";

// Only the database comes from .env. Everything else is pinned here, so tests never
// use real Stripe keys, JWT secrets, Redis, or rate limits.
dotenv.config({ quiet: true });

const { TEST_DATABASE_URL, TEST_DIRECT_URL } = process.env;
if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.DIRECT_URL = TEST_DIRECT_URL ?? TEST_DATABASE_URL;
}

Object.assign(process.env, {
  NODE_ENV: "test",
  REDIS_URL: "",
  RATE_LIMIT_ENABLED: "false",
  CORS_ORIGINS: "http://localhost:3000",
  JWT_ACCESS_SECRET: "jest-access-secret-0123456789abcdef0123456789",
  JWT_REFRESH_SECRET: "jest-refresh-secret-0123456789abcdef012345678",
  JWT_ACCESS_TTL: "15m",
  JWT_REFRESH_TTL: "7d",
  BCRYPT_ROUNDS: "10",
  GOOGLE_CLIENT_ID: "jest-client.apps.googleusercontent.com",
  STRIPE_SECRET_KEY: "sk_test_jest_dummy_key",
  STRIPE_WEBHOOK_SECRET: "whsec_jest_dummy_secret",
  PAYMENT_SUCCESS_URL: "http://localhost:3000/payment/success",
  PAYMENT_CANCEL_URL: "http://localhost:3000/payment/cancel",
});
