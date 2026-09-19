import { catchAsync } from "../../shared/utils/catchAsync";
import { sendResponse } from "../../shared/utils/sendResponse";
import * as authService from "./auth.service";

export const register = catchAsync(async (req, res) => {
  const data = await authService.register(req.body);
  sendResponse(res, { statusCode: 201, message: "Registration successful", data });
});

export const login = catchAsync(async (req, res) => {
  const data = await authService.login(req.body);
  sendResponse(res, { message: "Login successful", data });
});
