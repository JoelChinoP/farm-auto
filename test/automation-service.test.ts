import assert from "node:assert/strict";
import test from "node:test";

import { isAutomationRetrySafe } from "../src/lib/automation-errors.ts";
import { AppError } from "../src/lib/errors.ts";

test("only proven preflight failures are retry safe", () => {
  assert.equal(
    isAutomationRetrySafe(new AppError("offline", 503, "APPIUM_UNAVAILABLE")),
    true,
  );
  assert.equal(
    isAutomationRetrySafe(
      new AppError("rejected", 503, "APPIUM_SESSION_NOT_CREATED"),
    ),
    true,
  );
  assert.equal(
    isAutomationRetrySafe(
      new AppError("target", 409, "FACEBOOK_TARGET_NOT_VERIFIED"),
    ),
    true,
  );
  assert.equal(
    isAutomationRetrySafe(
      new AppError("unknown", 502, "AUTOMATION_OUTCOME_UNKNOWN"),
    ),
    false,
  );
  assert.equal(
    isAutomationRetrySafe(new AppError("cleanup", 502, "DEVICE_CLEANUP_UNKNOWN")),
    false,
  );
  assert.equal(isAutomationRetrySafe(new Error("transport")), false);
});
