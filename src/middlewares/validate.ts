import type { RequestHandler } from "express";
import type { ZodType } from "zod";

// Schema shape: z.object({ body?, params?, query? }). Parsed values replace the raw ones.
export const validate =
  (schema: ZodType): RequestHandler =>
  (req, _res, next) => {
    const parsed = schema.parse({ body: req.body, params: req.params, query: req.query }) as {
      body?: unknown;
      params?: Record<string, string>;
      query?: unknown;
    };

    if (parsed.body !== undefined) req.body = parsed.body;
    if (parsed.params) Object.assign(req.params, parsed.params);
    // Express 5 exposes req.query as a getter, so it has to be redefined.
    if (parsed.query !== undefined) {
      Object.defineProperty(req, "query", { value: parsed.query, configurable: true });
    }
    next();
  };
