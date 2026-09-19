import { Router } from "express";
import { validate } from "../../middlewares/validate";
import * as authController from "./auth.controller";
import { loginSchema, registerSchema } from "./auth.validation";

export const authRoutes = Router();

authRoutes.post("/register", validate(registerSchema), authController.register);
authRoutes.post("/login", validate(loginSchema), authController.login);
