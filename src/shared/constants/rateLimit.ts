const MINUTE = 60 * 1000;

// Per IP across the whole API. The Stripe webhook is exempt.
export const GLOBAL_LIMIT = { windowMs: 15 * MINUTE, limit: 300 };

// Per IP on register, login, refresh, and Google login, to slow brute-force attempts.
export const AUTH_LIMIT = { windowMs: 15 * MINUTE, limit: 20 };

// Per signed-in user on report submission, to curb spam.
export const REPORT_SUBMIT_LIMIT = { windowMs: 60 * MINUTE, limit: 10 };
