import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

test("builds capabilities, checks health, closes sessions and cancels", async () => {
  let created = 0;
  let deleted = 0;
  let delaySession = false;
  let failDelete = false;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/wd/hub/status") {
      response.end(
        JSON.stringify({
          value: { ready: true, message: "ready", build: { version: "3.7.0" } },
        }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/wd/hub/session") {
      created += 1;
      const send = () =>
        response.end(
          JSON.stringify({
            value: {
              sessionId: `session-${created}`,
              capabilities: { platformName: "Android" },
            },
          }),
        );
      if (delaySession) setTimeout(send, 50);
      else send();
      return;
    }
    if (request.method === "DELETE" && request.url?.startsWith("/wd/hub/session/")) {
      deleted += 1;
      if (failDelete) {
        response.statusCode = 500;
        response.end(
          JSON.stringify({ value: { error: "unknown error", message: "still alive" } }),
        );
        return;
      }
      response.end(JSON.stringify({ value: null }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ value: { error: "unknown command" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.APPIUM_URL = `http://127.0.0.1:${address.port}/wd/hub`;

  const {
    buildAndroidCapabilities,
    cancelAndroidOperation,
    closeLingeringAndroidSessions,
    getAppiumHealth,
    getAndroidOperationCompletion,
    finishAndroidOperation,
    startAndroidOperation,
    withAndroidSession,
  } = await import("../src/lib/appium.ts");
  const profile = { device_id: "serial-1", alias: "Equipo 1", system_port: 8200 };
  assert.deepEqual(buildAndroidCapabilities(profile), {
    platformName: "Android",
    "appium:automationName": "UiAutomator2",
    "appium:udid": "serial-1",
    "appium:deviceName": "Equipo 1",
    "appium:systemPort": 8200,
    "appium:noReset": true,
    "appium:fullReset": false,
    "appium:autoLaunch": false,
    "appium:newCommandTimeout": 180,
    "appium:adbExecTimeout": 30_000,
    "appium:uiautomator2ServerInstallTimeout": 90_000,
    "appium:uiautomator2ServerLaunchTimeout": 90_000,
    "appium:suppressKillServer": true,
    "wdio:enforceWebDriverClassic": true,
  });
  assert.deepEqual(await getAppiumHealth(), {
    ok: true,
    version: "3.7.0",
    message: "ready",
  });

  await withAndroidSession("complete", profile, async () => "ok");
  assert.equal(deleted, 1);

  delaySession = true;
  const pending = withAndroidSession("cancel", profile, async (_driver, signal) => {
    await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  while (created < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(
    withAndroidSession("cancel", profile, async () => undefined),
    /sesión Appium activa/,
  );
  assert.equal(await cancelAndroidOperation("cancel"), true);
  delaySession = false;
  await assert.rejects(pending, (error: unknown) => {
    return error instanceof Error && error.message === "La operación fue cancelada.";
  });
  assert.equal(deleted, 2);

  startAndroidOperation("cancel-before-session");
  const completion = getAndroidOperationCompletion("cancel-before-session");
  assert.ok(completion);
  assert.equal(await cancelAndroidOperation("cancel-before-session"), true);
  await assert.rejects(
    withAndroidSession("cancel-before-session", profile, async () => undefined),
    /La operación fue cancelada/,
  );
  await finishAndroidOperation("cancel-before-session");
  await completion;
  assert.equal(created, 2);

  failDelete = true;
  await assert.rejects(
    withAndroidSession("delete-failure", profile, async () => undefined),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "DEVICE_CLEANUP_UNKNOWN",
      ),
  );
  failDelete = false;
  await closeLingeringAndroidSessions(profile);

  await Promise.all([
    withAndroidSession("parallel-1", profile, async () => undefined),
    withAndroidSession(
      "parallel-2",
      { ...profile, device_id: "serial-2", system_port: 8201 },
      async () => undefined,
    ),
  ]);
  assert.equal(created, 5);
  assert.equal(deleted, 9);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
