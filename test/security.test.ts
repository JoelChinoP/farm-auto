import assert from "node:assert/strict";
import test from "node:test";

import { isAllowedApiMutation } from "../src/lib/request-security.ts";

test("allows same-origin mutations from the local control panel", () => {
  assert.equal(
    isAllowedApiMutation({
      hostname: "127.0.0.1",
      requestOrigin: "http://127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      fetchSite: "same-origin",
      panelClient: "control-panel",
    }),
    true,
  );
});

test("rejects cross-origin, rebound-host, and unmarked mutations", () => {
  const requests = [
    {
      hostname: "127.0.0.1",
      requestOrigin: "http://127.0.0.1:3000",
      origin: "https://attacker.example",
      fetchSite: "cross-site",
      panelClient: "control-panel",
    },
    {
      hostname: "attacker.example",
      requestOrigin: "http://attacker.example",
      origin: "http://attacker.example",
      fetchSite: "same-origin",
      panelClient: "control-panel",
    },
    {
      hostname: "127.0.0.1",
      requestOrigin: "http://127.0.0.1:3000",
      origin: null,
      fetchSite: null,
      panelClient: null,
    },
  ];
  for (const request of requests) {
    assert.equal(isAllowedApiMutation(request), false);
  }
});
