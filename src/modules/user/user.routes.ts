import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate";
import { validate } from "../../middlewares/validate";
import * as userController from "./user.controller";
import { updateProfileSchema } from "./user.validation";

export const userRoutes = Router();

userRoutes.use(authenticate);

userRoutes.get("/me", userController.getMe);
userRoutes.patch("/me", validate(updateProfileSchema), userController.updateMe);
