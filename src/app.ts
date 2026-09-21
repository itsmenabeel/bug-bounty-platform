import express from "express";
import { errorHandler } from "./middlewares/errorHandler";
import { notFound } from "./middlewares/notFound";
import { apiRouter } from "./routes";

export const app = express();

// Stripe signs the exact bytes it sends, so this path must stay unparsed. It has to come
// before express.json, which skips any request whose body is already read.
app.use("/api/v1/payments/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/v1", apiRouter);

app.use(notFound);
app.use(errorHandler);
