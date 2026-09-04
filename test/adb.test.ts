import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  AdbClient,
  type AdbExecutionOptions,
  type AdbExecutor,
  calculateHardwareId,
  HardwareIdentityMismatchError,
  parseAdbDevices,
  parseForeground,
  parsePackages,
  parseResolvedActivity,
  SAFE_ADB_URL,
} from "../src/lib/adb.ts";

interface RecordedCall {
  file: string;
  args: string[];
  options: AdbExecutionOptions;
}

function createDatabase(hardwareId = calculateHardwareId("physical-1", "android-1")) {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE device_profiles (
      hardware_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL UNIQUE
    )
  `);
  database.prepare("INSERT INTO device_profiles VALUES (?, ?)").run(hardwareId, "serial-1");
  return database;
}

function recordingExecutor(
  respond: (args: readonly string[], options: AdbExecutionOptions) => { stdout?: string; stderr?: string } = () => ({}),
) {
  const calls: RecordedCall[] = [];
  const executor: AdbExecutor = async (file, args, options) => {
    calls.push({ file, args: [...args], options });
    const result = respond(args, options);
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { calls, executor };
}

test("parses ADB inventory, packages, launchers and foreground across common output variants", () => {
  const inventory = parseAdbDevices([
    "* daemon not running; starting now at tcp:5037\r",
    "* daemon started successfully\r",
    "List of devices attached\r",
    "serial-1\tdevice product:bluejay model:Pixel_6a device:bluejay transport_id:1\r",
    "serial-2 offline transport_id:2\r",
    "serial-3\tunauthorized usb:3-1 model:SM_A145M transport_id:3\r",
    "\r",
  ].join("\n"));
  assert.deepEqual(inventory, [
    { serial: "serial-1", state: "device", model: "Pixel_6a" },
    { serial: "serial-2", state: "offline" },
    { serial: "serial-3", state: "unauthorized", model: "SM_A145M" },
  ]);

  assert.deepEqual(parseForeground(`
    mCurrentFocus=null
    mFocusedApp=ActivityRecord{5a u0 com.example.app/.MainActivity t42}
  `), {
    packageName: "com.example.app",
    activityName: "com.example.app.MainActivity",
    component: "com.example.app/com.example.app.MainActivity",
  });
  assert.deepEqual(parseForeground(
    "mCurrentFocus=Window{42 u0 com.android.settings/com.android.settings.Settings}",
  )?.packageName, "com.android.settings");
  assert.equal(parseForeground("mCurrentFocus=Window{42 u0 NotificationShade}"), null);
  assert.deepEqual(parseResolvedActivity(`priority=0\r\ncom.android.launcher3/.Launcher\r\n`), {
    packageName: "com.android.launcher3",
    activityName: "com.android.launcher3.Launcher",
    component: "com.android.launcher3/com.android.launcher3.Launcher",
  });
  assert.deepEqual(parsePackages("package:com.example.one\r\nnoise\r\npackage:com.example.two\r\n"), [
    "com.example.one",
    "com.example.two",
  ]);
  assert.equal(calculateHardwareId(" physical-1\r\n", "android-1\n"), calculateHardwareId("physical-1", "android-1"));
});

test("uses explicit serials, checks the SQLite allowlist on every directed call and blocks kill-server", async () => {
  const database = createDatabase();
  const mock = recordingExecutor((args) => ({
    stdout: args[0] === "devices"
      ? "List of devices attached\nserial-1 device model:Pixel_6a\n"
      : "mCurrentFocus=Window{42 u0 com.example.app/.MainActivity}\n",
  }));
  const client = new AdbClient({ database, executor: mock.executor, adbPath: "test-adb" });

  try {
    await client.listDevices();
    await client.getForeground("serial-1");
    assert.deepEqual(mock.calls[0].args, ["devices", "-l"]);
    assert.deepEqual(mock.calls[1].args.slice(0, 2), ["-s", "serial-1"]);
    assert.equal(mock.calls[0].file, "test-adb");

    const callCount = mock.calls.length;
    await assert.rejects(client.execute("serial-1", ["kill-server"]), /kill-server esta prohibido/);
    await assert.rejects(client.getForeground("missing"), /no esta permitido/);
    await assert.rejects(client.getForeground(""), /serial ADB/);
    await assert.rejects(client.getForeground("serial\n2"), /serial ADB/);
    assert.equal(mock.calls.length, callCount);

    database.prepare("DELETE FROM device_profiles WHERE device_id = ?").run("serial-1");
    await assert.rejects(client.getForeground("serial-1"), /no esta permitido/);
    assert.equal(mock.calls.length, callCount);
  } finally {
    database.close();
  }
});

test("inspects all required properties and rejects a hardware identity mismatch", async () => {
  const database = createDatabase("incorrect-hardware-id");
  const mock = recordingExecutor((args) => {
    if (args[0] === "devices") return { stdout: "List of devices attached\nserial-1 device model:Transport_Model\n" };
    const command = args.slice(2).join(" ");
    const outputs: Record<string, string> = {
      "shell getprop ro.product.model": "Pixel 6a\r\n",
      "shell getprop ro.serialno": "physical-1\r\n",
      "shell settings get secure android_id": "android-1\r\n",
      "shell pm list packages": "package:com.example.app\r\npackage:com.android.launcher3\r\n",
      "shell dumpsys window windows": "mCurrentFocus=Window{42 u0 com.example.app/.MainActivity}\r\n",
      "shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME":
        "com.android.launcher3/.Launcher\r\n",
    };
    return { stdout: outputs[command] ?? "" };
  });
  const client = new AdbClient({ database, executor: mock.executor });

  try {
    await assert.rejects(client.inspectDevice("serial-1"), (error: unknown) => {
      assert.ok(error instanceof HardwareIdentityMismatchError);
      assert.equal(error.expectedHardwareId, "incorrect-hardware-id");
      assert.equal(error.actualHardwareId, calculateHardwareId("physical-1", "android-1"));
      return true;
    });
    assert.deepEqual(mock.calls[0].args, ["devices", "-l"]);
    assert.equal(mock.calls.length, 7);
    for (const call of mock.calls.slice(1)) assert.deepEqual(call.args.slice(0, 2), ["-s", "serial-1"]);
    database.prepare("DELETE FROM device_profiles").run();
    const discovered = await client.inspectUnregisteredDevice("serial-1");
    assert.equal(discovered.hardwareId, calculateHardwareId("physical-1", "android-1"));
    assert.equal(discovered.model, "Pixel 6a");
  } finally {
    database.close();
  }
});

test("presses Home and polls until the resolved launcher is foreground", async () => {
  const database = createDatabase();
  let foregroundChecks = 0;
  const sleeps: number[] = [];
  const mock = recordingExecutor((args) => {
    const command = args.slice(2).join(" ");
    if (command.includes("resolve-activity")) return { stdout: "com.android.launcher3/.Launcher\n" };
    if (command === "shell dumpsys window windows") {
      foregroundChecks += 1;
      return {
        stdout: foregroundChecks === 1
          ? "mCurrentFocus=Window{42 u0 com.example.app/.MainActivity}\n"
          : "mCurrentFocus=Window{43 u0 com.android.launcher3/.Launcher}\n",
      };
    }
    return {};
  });
  const client = new AdbClient({
    database,
    executor: mock.executor,
    homeTimeoutMs: 100,
    homePollIntervalMs: 10,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
  });

  try {
    const foreground = await client.goHome("serial-1");
    assert.equal(foreground.packageName, "com.android.launcher3");
    assert.deepEqual(sleeps, [10]);
    assert.ok(mock.calls.some((call) => call.args.slice(2).join(" ") === "shell input keyevent KEYCODE_HOME"));
  } finally {
    database.close();
  }
});

test("waits for a delayed safe URL handler to reach foreground", async () => {
  const database = createDatabase();
  let checks = 0;
  const mock = recordingExecutor((args) => {
    if (args.slice(2).join(" ") === "shell dumpsys window windows") {
      checks += 1;
      return { stdout: `mCurrentFocus=Window{42 u0 ${checks === 1 ? "com.sec.android.app.launcher/.Launcher" : "com.android.chrome/.Main"}}\n` };
    }
    return {};
  });
  const client = new AdbClient({
    database,
    executor: mock.executor,
    homeTimeoutMs: 100,
    homePollIntervalMs: 10,
    sleep: async () => {},
  });

  try {
    const foreground = await client.waitForForeground("serial-1", "com.android.chrome");
    assert.equal(foreground.packageName, "com.android.chrome");
    assert.equal(checks, 2);
  } finally {
    database.close();
  }
});

test("opens only the fixed safe URL with ACTION_VIEW", async () => {
  const database = createDatabase();
  const mock = recordingExecutor();
  const client = new AdbClient({ database, executor: mock.executor });

  try {
    await client.openSafeUrl("serial-1", SAFE_ADB_URL);
    assert.deepEqual(mock.calls[0].args, [
      "-s",
      "serial-1",
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      "https://example.com/",
    ]);
    await assert.rejects(client.openSafeUrl("serial-1", "https://example.org/"), /solo puede abrir/);
    assert.equal(mock.calls.length, 1);
  } finally {
    database.close();
  }
});

test("passes timeout, maxBuffer and AbortSignal to the injected executor without real processes", async () => {
  const database = createDatabase();
  const mock = recordingExecutor(() => ({
    stdout: "mCurrentFocus=Window{42 u0 com.example.app/.MainActivity}\n",
  }));
  const client = new AdbClient({
    database,
    executor: mock.executor,
    timeoutMs: 321,
    maxBuffer: 654,
  });

  try {
    await client.getForeground("serial-1");
    assert.equal(mock.calls[0].options.timeout, 321);
    assert.equal(mock.calls[0].options.maxBuffer, 654);

    const liveController = new AbortController();
    await client.getForeground("serial-1", { signal: liveController.signal, timeoutMs: 123 });
    assert.equal(mock.calls[1].options.timeout, 123);
    assert.equal(mock.calls[1].options.signal, liveController.signal);

    const abortedController = new AbortController();
    abortedController.abort(new Error("cancelled before execution"));
    await assert.rejects(
      client.getForeground("serial-1", { signal: abortedController.signal }),
      /cancelled before execution/,
    );
    assert.equal(mock.calls.length, 2);
  } finally {
    database.close();
  }
});
