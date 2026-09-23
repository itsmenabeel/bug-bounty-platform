import cors from "cors";
import express from "express";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import { env } from "./config/env";
import { openapiSpec } from "./config/openapi";
import { errorHandler } from "./middlewares/errorHandler";
import { notFound } from "./middlewares/notFound";
import { globalLimiter } from "./middlewares/rateLimit";
import { rejectNullBytes } from "./middlewares/rejectNullBytes";
import { apiRouter } from "./routes";
import { JSON_BODY_LIMIT } from "./shared/constants/http";

export const app = express();

// Behind Render's proxy, req.ip is the proxy unless the first hop is trusted.
app.set("trust proxy", env.NODE_ENV === "production" ? 1 : false);

// Swagger UI's page runs an inline bootstrap script and inline styles; every other
// response here is JSON, so allowing that on this one route doesn't loosen anything else.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'", "'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'"],
      },
    },
  }),
);
app.use(cors({ origin: env.CORS_ORIGINS }));

// Stripe signs the exact bytes it sends, so this path must stay unparsed. It has to come
// before express.json, which skips any request whose body is already read.
app.use("/api/v1/payments/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(rejectNullBytes);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));

app.use("/api/v1", globalLimiter, apiRouter);

app.use(notFound);
app.use(errorHandler);
