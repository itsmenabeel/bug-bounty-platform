import { Router } from "express";
import { validate } from "../../middlewares/validate";
import * as authController from "./auth.controller";
import { googleLoginSchema, loginSchema, refreshSchema, registerSchema } from "./auth.validation";

export const authRoutes = Router();

authRoutes.post("/register", validate(registerSchema), authController.register);
authRoutes.post("/login", validate(loginSchema), authController.login);
authRoutes.post("/google", validate(googleLoginSchema), authController.googleLogin);
authRoutes.post("/refresh-token", validate(refreshSchema), authController.refresh);
authRoutes.post("/logout", validate(refreshSchema), authController.logout);
