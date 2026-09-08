import assert from "node:assert/strict";
import test from "node:test";

import { epochToLocalDate, epochToLocalDateTimeInput, localDateTimeInputToEpoch } from "../src/lib/local-time.ts";

test("round-trips datetime-local values in the browser timezone", () => {
  const epoch = new Date(2026, 8, 8, 8, 16, 0).getTime();
  const input = epochToLocalDateTimeInput(epoch);
  assert.equal(localDateTimeInputToEpoch(input), epoch);
  assert.equal(epochToLocalDate(epoch), input.slice(0, 10));
  assert.equal(localDateTimeInputToEpoch("2026-02-30T08:16"), null);
});
