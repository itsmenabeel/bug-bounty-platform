import { catchAsync } from "../../shared/utils/catchAsync";
import { requireUser } from "../../shared/utils/requireUser";
import { sendResponse } from "../../shared/utils/sendResponse";
import * as payoutService from "./payout.service";
import type { ListPayoutsQuery } from "./payout.validation";

export const reward = catchAsync(async (req, res) => {
  const data = await payoutService.rewardReport(String(req.params.id), requireUser(req));
  sendResponse(res, { message: "Reward issued", data });
});

export const list = catchAsync(async (req, res) => {
  const { items, meta } = await payoutService.listPayouts(
    requireUser(req),
    req.query as unknown as ListPayoutsQuery,
  );
  sendResponse(res, { message: "Payouts retrieved", data: items, meta });
});
