import { catchAsync } from "../../shared/utils/catchAsync";
import { requireUser } from "../../shared/utils/requireUser";
import { sendResponse } from "../../shared/utils/sendResponse";
import * as userService from "./user.service";

export const getMe = catchAsync(async (req, res) => {
  const data = await userService.getProfile(requireUser(req).id);
  sendResponse(res, { message: "Profile retrieved", data });
});

export const updateMe = catchAsync(async (req, res) => {
  const data = await userService.updateProfile(requireUser(req).id, req.body);
  sendResponse(res, { message: "Profile updated", data });
});
