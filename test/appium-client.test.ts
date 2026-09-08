import assert from "node:assert/strict";
import test from "node:test";

import {
  AppiumClient,
  AppiumClientError,
  type AppiumFetch,
} from "../src/lib/appium-client.ts";

function expectCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof AppiumClientError);
    assert.equal(error.code, code);
    return true;
  };
}

test("creates an Appium 3 session with the exact runtime capabilities", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const fetch: AppiumFetch = async (input, init) => {
    request = { url: String(input), init };
    return Response.json({
      value: {
        sessionId: "farm-session",
        capabilities: { platformName: "Android", deviceApiLevel: 35 },
      },
    });
  };
  const client = new AppiumClient({ baseUrl: "http://127.0.0.1:4723/", fetch });

  assert.deepEqual(await client.createSession({ udid: "serial-1", systemPort: 8200 }), {
    sessionId: "farm-session",
    capabilities: { platformName: "Android", deviceApiLevel: 35 },
  });
  assert.equal(request?.url, "http://127.0.0.1:4723/session");
  assert.equal(request?.init?.method, "POST");
  assert.ok(request?.init?.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    capabilities: {
      alwaysMatch: {
        platformName: "Android",
        "appium:automationName": "uiautomator2",
        "appium:udid": "serial-1",
        "appium:systemPort": 8200,
        "appium:noReset": true,
        "appium:autoLaunch": false,
        "appium:suppressKillServer": true,
      },
    },
  });
  assert.equal(client.ownsSession("farm-session"), true);
});

test("accepts only Android hierarchy page sources", async () => {
  const responses = [
    Response.json({ value: "<?xml version=\"1.0\"?><hierarchy rotation=\"0\"><node /></hierarchy>" }),
    Response.json({ value: "<html></html>" }),
  ];
  const client = new AppiumClient({
    baseUrl: "http://localhost:4723",
    ownedSessionIds: ["persisted-session"],
    fetch: async () => responses.shift()!,
  });

  assert.match(await client.getPageSource("persisted-session"), /^<\?xml/);
  await assert.rejects(
    client.getPageSource("persisted-session"),
    expectCode("APPIUM_PAGE_SOURCE_INVALID"),
  );
});

test("decodes and validates base64 screenshots", async () => {
  const expected = Buffer.from("fake-png");
  const responses = [
    Response.json({ value: expected.toString("base64") }),
    Response.json({ value: "not base64" }),
  ];
  const client = new AppiumClient({
    baseUrl: "https://[::1]:4723",
    ownedSessionIds: ["session-1"],
    fetch: async () => responses.shift()!,
  });

  assert.deepEqual(await client.getScreenshot("session-1"), expected);
  await assert.rejects(client.getScreenshot("session-1"), expectCode("APPIUM_SCREENSHOT_INVALID"));
});

test("uses owned W3C sessions for the required Android interaction primitives", async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const responses: unknown[] = [
    null,
    null,
    [{ "element-6066-11e4-a52e-4f735466cecf": "element-1" }],
    [{ "element-6066-11e4-a52e-4f735466cecf": "element-2" }],
    "texto exacto",
    "true",
    null,
    null,
    null,
  ];
  const client = new AppiumClient({
    baseUrl: "http://127.0.0.1:4723",
    ownedSessionIds: ["session-1"],
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return Response.json({ value: responses.shift() });
    },
  });

  await client.activateApp("session-1", "com.facebook.lite");
  await client.executeScript("session-1", "mobile: deepLink", [{ url: "https://facebook.com/post/1", package: "com.facebook.lite" }]);
  assert.deepEqual(await client.findElements("session-1", "accessibility id", "Me gusta"), [{ elementId: "element-1" }]);
  assert.deepEqual(await client.findElementsFromElement("session-1", "element-1", "xpath", ".//*[@text='objetivo']"), [{ elementId: "element-2" }]);
  assert.equal(await client.getElementText("session-1", "element-1"), "texto exacto");
  assert.equal(await client.getElementAttribute("session-1", "element-1", "selected"), "true");
  await client.clearElement("session-1", "element-1");
  await client.setElementValue("session-1", "element-1", "á");
  await client.clickElement("session-1", "element-1");

  assert.match(requests[0].url, /appium\/device\/activate_app$/);
  assert.deepEqual(requests[1].body, { script: "mobile: deepLink", args: [{ url: "https://facebook.com/post/1", package: "com.facebook.lite" }] });
  assert.deepEqual(requests[2].body, { using: "accessibility id", value: "Me gusta" });
  assert.match(requests[3].url, /element\/element-1\/elements$/);
  assert.deepEqual(requests[7].body, { text: "á", value: ["á"] });
});

test("deletes an owned session only after Appium confirms success", async () => {
  let attempts = 0;
  const client = new AppiumClient({
    baseUrl: "http://127.0.0.1:4723",
    ownedSessionIds: ["session-1"],
    fetch: async () => {
      attempts += 1;
      return attempts === 1
        ? Response.json({ value: { error: "unknown error", message: "cleanup failed" } }, { status: 500 })
        : Response.json({ value: null });
    },
  });

  await assert.rejects(client.deleteSession("session-1"), expectCode("unknown error"));
  assert.equal(client.ownsSession("session-1"), true);
  await client.deleteSession("session-1");
  assert.equal(client.ownsSession("session-1"), false);
  await assert.rejects(client.deleteSession("session-1"), expectCode("APPIUM_SESSION_NOT_OWNED"));
  assert.equal(attempts, 2);
});

test("rejects foreign sessions without contacting Appium", async () => {
  let requests = 0;
  const client = new AppiumClient({
    baseUrl: "http://127.0.0.1:4723",
    fetch: async () => {
      requests += 1;
      return Response.json({ value: null });
    },
  });

  await assert.rejects(client.getPageSource("foreign"), expectCode("APPIUM_SESSION_NOT_OWNED"));
  await assert.rejects(client.getScreenshot("foreign"), expectCode("APPIUM_SESSION_NOT_OWNED"));
  await assert.rejects(client.deleteSession("foreign"), expectCode("APPIUM_SESSION_NOT_OWNED"));
  assert.equal(requests, 0);
});

test("parses W3C value errors and plain HTTP errors", async () => {
  const responses = [
    Response.json({ value: { error: "invalid session id", message: "session is gone" } }, { status: 404 }),
    Response.json({ value: { message: "service unavailable" } }, { status: 503 }),
    Response.json({ value: { error: "unknown error", message: "failed despite HTTP 200" } }),
  ];
  const client = new AppiumClient({
    baseUrl: "http://127.0.0.1:4723",
    ownedSessionIds: ["session-1"],
    fetch: async () => responses.shift()!,
  });

  await assert.rejects(client.getPageSource("session-1"), (error: unknown) => {
    assert.ok(error instanceof AppiumClientError);
    assert.equal(error.code, "invalid session id");
    assert.equal(error.message, "session is gone");
    assert.equal(error.status, 404);
    return true;
  });
  await assert.rejects(client.getPageSource("session-1"), expectCode("APPIUM_HTTP_ERROR"));
  await assert.rejects(client.getPageSource("session-1"), expectCode("unknown error"));
});

test("aborts each request when its timeout expires", async () => {
  const fetch: AppiumFetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    assert.ok(signal);
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const client = new AppiumClient({
    baseUrl: "http://127.0.0.1:4723",
    ownedSessionIds: ["session-1"],
    fetch,
  });

  await assert.rejects(
    client.getPageSource("session-1", { timeoutMs: 5 }),
    expectCode("APPIUM_TIMEOUT"),
  );
});

test("rejects non-loopback, credentialed and unsupported Appium URLs", () => {
  assert.throws(
    () => new AppiumClient({ baseUrl: "http://192.168.1.20:4723" }),
    expectCode("APPIUM_URL_NOT_LOOPBACK"),
  );
  assert.throws(
    () => new AppiumClient({ baseUrl: "http://user:secret@127.0.0.1:4723" }),
    expectCode("APPIUM_URL_CREDENTIALS"),
  );
  assert.throws(
    () => new AppiumClient({ baseUrl: "ftp://127.0.0.1:4723" }),
    expectCode("APPIUM_URL_NOT_LOOPBACK"),
  );
});
