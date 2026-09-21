import { Router } from "express";
import { authRoutes } from "./modules/auth/auth.routes";
import { programRoutes } from "./modules/program/program.routes";
import { reportRoutes } from "./modules/report/report.routes";
import { userRoutes } from "./modules/user/user.routes";

export const apiRouter = Router();

apiRouter.use("/auth", authRoutes);
apiRouter.use("/users", userRoutes);
apiRouter.use("/programs", programRoutes);
apiRouter.use("/reports", reportRoutes);
