import { Router } from "express";
import { authRoutes } from "./modules/auth/auth.routes";

export const apiRouter = Router();

apiRouter.use("/auth", authRoutes);
