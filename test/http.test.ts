import assert from "node:assert/strict";
import test from "node:test";

import { apiError, apiSuccess } from "../src/lib/http.ts";
import {
  PANEL_CLIENT_HEADER,
  PANEL_CLIENT_ID,
  validateMutationRequest,
} from "../src/lib/request-security.ts";

test("accepts mutations only from loopback with the panel client header", () => {
  const headers = { [PANEL_CLIENT_HEADER]: PANEL_CLIENT_ID, origin: "http://127.0.0.1:3000" };
  assert.equal(validateMutationRequest(new Request("http://127.0.0.1:3000/api/test", { headers })), null);
  assert.equal(validateMutationRequest(new Request("http://192.168.1.10/api/test", { headers }))?.code, "LOOPBACK_REQUIRED");
  assert.equal(validateMutationRequest(new Request("http://127.0.0.1/api/test"))?.code, "PANEL_CLIENT_REQUIRED");
  assert.equal(validateMutationRequest(new Request("http://127.0.0.1/api/test", {
    headers: { ...headers, origin: "https://example.com" },
  }))?.code, "INVALID_ORIGIN");
  assert.equal(validateMutationRequest(new Request("http://127.0.0.1/api/test", {
    headers: { ...headers, "sec-fetch-site": "cross-site" },
  }))?.code, "INVALID_FETCH_SITE");
});

test("uses the canonical HTTP envelopes", async () => {
  const success = apiSuccess({ accepted: true }, 202);
  assert.equal(success.status, 202);
  assert.deepEqual(await success.json(), { success: true, data: { accepted: true } });

  const failure = apiError("DEVICE_NOT_READY", "El dispositivo no esta preparado", 409, { deviceId: "serial-1" });
  assert.equal(failure.status, 409);
  assert.deepEqual(await failure.json(), {
    success: false,
    code: "DEVICE_NOT_READY",
    message: "El dispositivo no esta preparado",
    details: { deviceId: "serial-1" },
  });
});
