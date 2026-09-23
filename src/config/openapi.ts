import fs from "node:fs";
import path from "node:path";

// docs/ sits outside src/, so the spec is read from disk rather than imported,
// which keeps it out of the compiled build and always in sync with the repo copy.
const specPath = path.join(process.cwd(), "docs", "openapi.json");
export const openapiSpec: object = JSON.parse(fs.readFileSync(specPath, "utf-8"));
