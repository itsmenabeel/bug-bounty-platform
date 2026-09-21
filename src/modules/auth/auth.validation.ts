import { z } from "zod";
import { ROLES } from "../../shared/constants/roles";

const email = z.email().max(254).trim().toLowerCase();

const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(72, "Password must be at most 72 characters")
  .regex(/[A-Za-z]/, "Password must contain a letter")
  .regex(/\d/, "Password must contain a number");

export const registerSchema = z.object({
  body: z.strictObject({
    email,
    password,
    name: z.string().trim().min(2).max(100),
    // Admins are seeded or promoted by an admin, never self-registered.
    role: z.enum([ROLES.RESEARCHER, ROLES.PROGRAM_OWNER]).default(ROLES.RESEARCHER),
  }),
});

export const loginSchema = z.object({
  body: z.strictObject({
    email,
    password: z.string().min(1, "Password is required"),
  }),
});

export const refreshSchema = z.object({
  body: z.strictObject({ refreshToken: z.string().min(1, "Refresh token is required") }),
});

export const googleLoginSchema = z.object({
  body: z.strictObject({
    idToken: z.string().min(1, "Google ID token is required"),
    // Applies only when the Google account creates a new user.
    role: z.enum([ROLES.RESEARCHER, ROLES.PROGRAM_OWNER]).default(ROLES.RESEARCHER),
  }),
});

export type GoogleLoginInput = z.infer<typeof googleLoginSchema>["body"];
export type RegisterInput = z.infer<typeof registerSchema>["body"];
export type LoginInput = z.infer<typeof loginSchema>["body"];
