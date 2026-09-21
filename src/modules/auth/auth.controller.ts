import { catchAsync } from "../../shared/utils/catchAsync";
import { sendResponse } from "../../shared/utils/sendResponse";
import * as authService from "./auth.service";

export const register = catchAsync(async (req, res) => {
  const data = await authService.register(req.body);
  sendResponse(res, { statusCode: 201, message: "Registration successful", data });
});

export const googleLogin = catchAsync(async (req, res) => {
  const data = await authService.googleLogin(req.body);
  sendResponse(res, { message: "Login successful", data });
});

export const refresh = catchAsync(async (req, res) => {
  const data = await authService.refresh(req.body.refreshToken);
  sendResponse(res, { message: "Token refreshed", data });
});

export const logout = catchAsync(async (req, res) => {
  await authService.logout(req.body.refreshToken);
  sendResponse(res, { message: "Logged out" });
});

export const login = catchAsync(async (req, res) => {
  const data = await authService.login(req.body);
  sendResponse(res, { message: "Login successful", data });
});
