import { z } from "zod";

export const idParamSchema = z.object({
  params: z.object({ id: z.uuid("Invalid id") }),
});
