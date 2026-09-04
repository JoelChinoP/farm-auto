export type AppiumFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface AppiumClientOptions {
  baseUrl: string | URL;
  timeoutMs?: number;
  ownedSessionIds?: Iterable<string>;
  fetch?: AppiumFetch;
}

export interface AppiumRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CreateAppiumSessionOptions extends AppiumRequestOptions {
  udid: string;
  systemPort: number;
}

export interface AppiumSession {
  sessionId: string;
  capabilities: Record<string, unknown>;
}

export const APPIUM_ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
export type AppiumLocatorStrategy = "accessibility id" | "id" | "-android uiautomator" | "xpath";
export type AppiumElement = { elementId: string };

export class AppiumClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    status?: number,
    details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AppiumClientError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ANDROID_HIERARCHY = /^(?:<\?xml[\s\S]*?\?>\s*)?<hierarchy(?:\s[^>]*)?>[\s\S]*<\/hierarchy>$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error.code === "string") return error.code;
  return errorCode(error.cause);
}

function normalizeBaseUrl(baseUrl: string | URL) {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (cause) {
    throw new AppiumClientError("APPIUM_URL_INVALID", "Appium base URL is invalid", undefined, undefined, { cause });
  }

  const hostname = url.hostname.toLowerCase();
  const isLoopback = hostname === "localhost"
    || hostname === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopback) {
    throw new AppiumClientError("APPIUM_URL_NOT_LOOPBACK", "Appium base URL must use HTTP(S) loopback");
  }
  if (url.username || url.password) {
    throw new AppiumClientError("APPIUM_URL_CREDENTIALS", "Appium base URL must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new AppiumClientError("APPIUM_URL_INVALID", "Appium base URL must not contain a query or fragment");
  }

  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

function validateTimeout(timeoutMs: number) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new AppiumClientError("APPIUM_TIMEOUT_INVALID", "Appium timeout must be a positive integer");
  }
}

export class AppiumClient {
  readonly #baseUrl: string;
  readonly #defaultTimeoutMs: number;
  readonly #fetch: AppiumFetch;
  readonly #ownedSessionIds: Set<string>;

  constructor({
    baseUrl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    ownedSessionIds = [],
    fetch = globalThis.fetch,
  }: AppiumClientOptions) {
    validateTimeout(timeoutMs);
    this.#baseUrl = normalizeBaseUrl(baseUrl);
    this.#defaultTimeoutMs = timeoutMs;
    this.#fetch = fetch;
    this.#ownedSessionIds = new Set(ownedSessionIds);
  }

  ownsSession(sessionId: string) {
    return this.#ownedSessionIds.has(sessionId);
  }

  async createSession({
    udid,
    systemPort,
    timeoutMs,
    signal,
  }: CreateAppiumSessionOptions): Promise<AppiumSession> {
    if (!udid.trim()) {
      throw new AppiumClientError("APPIUM_UDID_INVALID", "Appium requires an explicit device UDID");
    }
    if (!Number.isInteger(systemPort) || systemPort < 8200 || systemPort > 8299) {
      throw new AppiumClientError("APPIUM_SYSTEM_PORT_INVALID", "Appium systemPort must be between 8200 and 8299");
    }

    const value = await this.#request("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capabilities: {
          alwaysMatch: {
            platformName: "Android",
            "appium:automationName": "uiautomator2",
            "appium:udid": udid,
            "appium:systemPort": systemPort,
            "appium:noReset": true,
            "appium:autoLaunch": false,
            "appium:suppressKillServer": true,
          },
        },
      }),
    }, { timeoutMs, signal });

    const sessionId = isRecord(value) && typeof value.sessionId === "string" && value.sessionId
      ? value.sessionId
      : null;
    if (sessionId) this.#ownedSessionIds.add(sessionId);
    if (!sessionId || !isRecord(value) || !isRecord(value.capabilities)) {
      throw new AppiumClientError(
        "APPIUM_PROTOCOL_ERROR",
        "Appium returned an invalid session response",
        undefined,
        sessionId ? { sessionId } : undefined,
      );
    }

    const session = {
      sessionId,
      capabilities: value.capabilities,
    };
    return session;
  }

  async getPageSource(sessionId: string, options: AppiumRequestOptions = {}) {
    this.#assertOwns(sessionId);
    const value = await this.#request(`/session/${encodeURIComponent(sessionId)}/source`, {
      method: "GET",
    }, options);

    if (typeof value !== "string" || !ANDROID_HIERARCHY.test(value.trim())) {
      throw new AppiumClientError("APPIUM_PAGE_SOURCE_INVALID", "Appium returned an invalid Android hierarchy");
    }
    return value;
  }

  async getScreenshot(sessionId: string, options: AppiumRequestOptions = {}) {
    this.#assertOwns(sessionId);
    const value = await this.#request(`/session/${encodeURIComponent(sessionId)}/screenshot`, {
      method: "GET",
    }, options);

    if (typeof value !== "string" || !value || !BASE64.test(value)) {
      throw new AppiumClientError("APPIUM_SCREENSHOT_INVALID", "Appium returned an invalid base64 screenshot");
    }
    const screenshot = Buffer.from(value, "base64");
    if (!screenshot.length || screenshot.toString("base64") !== value) {
      throw new AppiumClientError("APPIUM_SCREENSHOT_INVALID", "Appium returned an invalid base64 screenshot");
    }
    return screenshot;
  }

  async activateApp(sessionId: string, appId: string, options: AppiumRequestOptions = {}) {
    this.#assertOwns(sessionId);
    if (!appId.trim()) throw new AppiumClientError("APPIUM_APP_ID_INVALID", "Appium requires an app id");
    await this.#request(`/session/${encodeURIComponent(sessionId)}/appium/device/activate_app`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId }),
    }, options);
  }

  async executeScript(sessionId: string, script: string, args: unknown[], options: AppiumRequestOptions = {}) {
    this.#assertOwns(sessionId);
    if (!script.trim() || !Array.isArray(args)) {
      throw new AppiumClientError("APPIUM_SCRIPT_INVALID", "Appium script and args are required");
    }
    return this.#request(`/session/${encodeURIComponent(sessionId)}/execute/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ script, args }),
    }, options);
  }

  async findElements(
    sessionId: string,
    using: AppiumLocatorStrategy,
    value: string,
    options: AppiumRequestOptions = {},
  ): Promise<AppiumElement[]> {
    this.#assertOwns(sessionId);
    if (!value.trim()) throw new AppiumClientError("APPIUM_LOCATOR_INVALID", "Appium locator cannot be empty");
    const result = await this.#request(`/session/${encodeURIComponent(sessionId)}/elements`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ using, value }),
    }, options);
    if (!Array.isArray(result)) {
      throw new AppiumClientError("APPIUM_ELEMENTS_INVALID", "Appium returned an invalid element collection");
    }
    return result.map((element) => {
      const elementId = isRecord(element) && typeof element[APPIUM_ELEMENT_KEY] === "string"
        ? element[APPIUM_ELEMENT_KEY]
        : null;
      if (!elementId) throw new AppiumClientError("APPIUM_ELEMENT_INVALID", "Appium returned an invalid element");
      return { elementId };
    });
  }

  async findElementsFromElement(
    sessionId: string,
    elementId: string,
    using: AppiumLocatorStrategy,
    value: string,
    options: AppiumRequestOptions = {},
  ): Promise<AppiumElement[]> {
    this.#assertOwns(sessionId);
    this.#assertElementId(elementId);
    if (!value.trim()) throw new AppiumClientError("APPIUM_LOCATOR_INVALID", "Appium locator cannot be empty");
    const result = await this.#request(
      `/session/${encodeURIComponent(sessionId)}/element/${encodeURIComponent(elementId)}/elements`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ using, value }),
      },
      options,
    );
    if (!Array.isArray(result)) {
      throw new AppiumClientError("APPIUM_ELEMENTS_INVALID", "Appium returned an invalid element collection");
    }
    return result.map((element) => {
      const childId = isRecord(element) && typeof element[APPIUM_ELEMENT_KEY] === "string"
        ? element[APPIUM_ELEMENT_KEY]
        : null;
      if (!childId) throw new AppiumClientError("APPIUM_ELEMENT_INVALID", "Appium returned an invalid element");
      return { elementId: childId };
    });
  }

  async clickElement(sessionId: string, elementId: string, options: AppiumRequestOptions = {}) {
    this.#assertOwns(sessionId);
    this.#assertElementId(elementId);
    await this.#request(`/session/${encodeURIComponent(sessionId)}/element/${encodeURIComponent(elementId)}/click`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }, options);
  }

  async clearElement(sessionId: string, elementId: string, options: AppiumRequestOptions = {}) {
    this.#assertOwns(sessionId);
    this.#assertElementId(elementId);
    await this.#request(`/session/${encodeURIComponent(sessionId)}/element/${encodeURIComponent(elementId)}/clear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }, options);
  }

  async setElementValue(sessionId: string, elementId: string, text: string, options: AppiumRequestOptions = {}) {
    this.#assertOwns(sessionId);
    this.#assertElementId(elementId);
    await this.#request(`/session/${encodeURIComponent(sessionId)}/element/${encodeURIComponent(elementId)}/value`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, value: [...text] }),
    }, options);
  }

  async getElementText(sessionId: string, elementId: string, options: AppiumRequestOptions = {}) {
    this.#assertOwns(sessionId);
    this.#assertElementId(elementId);
    const value = await this.#request(
      `/session/${encodeURIComponent(sessionId)}/element/${encodeURIComponent(elementId)}/text`,
      { method: "GET" },
      options,
    );
    if (typeof value !== "string") throw new AppiumClientError("APPIUM_ELEMENT_TEXT_INVALID", "Appium returned invalid element text");
    return value;
  }

  async getElementAttribute(
    sessionId: string,
    elementId: string,
    attribute: string,
    options: AppiumRequestOptions = {},
  ) {
    this.#assertOwns(sessionId);
    this.#assertElementId(elementId);
    if (!attribute.trim()) throw new AppiumClientError("APPIUM_ATTRIBUTE_INVALID", "Appium attribute cannot be empty");
    const value = await this.#request(
      `/session/${encodeURIComponent(sessionId)}/element/${encodeURIComponent(elementId)}/attribute/${encodeURIComponent(attribute)}`,
      { method: "GET" },
      options,
    );
    if (value !== null && typeof value !== "string") {
      throw new AppiumClientError("APPIUM_ATTRIBUTE_INVALID", "Appium returned an invalid element attribute");
    }
    return value;
  }

  async deleteSession(sessionId: string, options: AppiumRequestOptions = {}) {
    this.#assertOwns(sessionId);
    await this.#request(`/session/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    }, options);
    this.#ownedSessionIds.delete(sessionId);
  }

  #assertOwns(sessionId: string) {
    if (!this.#ownedSessionIds.has(sessionId)) {
      throw new AppiumClientError(
        "APPIUM_SESSION_NOT_OWNED",
        `Appium session ${JSON.stringify(sessionId)} is not owned by Farm Appium`,
      );
    }
  }

  #assertElementId(elementId: string) {
    if (!elementId.trim()) throw new AppiumClientError("APPIUM_ELEMENT_INVALID", "Appium element id cannot be empty");
  }

  async #request(path: string, init: RequestInit, options: AppiumRequestOptions) {
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    validateTimeout(timeoutMs);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, { ...init, signal });
    } catch (cause) {
      if (timeoutSignal.aborted && !options.signal?.aborted) {
        throw new AppiumClientError(
          "APPIUM_TIMEOUT",
          `Appium request timed out after ${timeoutMs} ms`,
          undefined,
          undefined,
          { cause },
        );
      }
      if (options.signal?.aborted) {
        throw new AppiumClientError(
          "APPIUM_REQUEST_ABORTED",
          "Appium request was aborted after it may have reached the server",
          undefined,
          undefined,
          { cause },
        );
      }
      if (["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"].includes(errorCode(cause) ?? "")) {
        throw new AppiumClientError(
          "APPIUM_UNREACHABLE",
          "Appium server is unreachable",
          undefined,
          undefined,
          { cause },
        );
      }
      throw new AppiumClientError(
        "APPIUM_REQUEST_UNKNOWN",
        "Appium request failed after it may have reached the server",
        undefined,
        undefined,
        { cause },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new AppiumClientError(
        response.ok ? "APPIUM_PROTOCOL_ERROR" : "APPIUM_HTTP_ERROR",
        `Appium returned a non-JSON HTTP ${response.status} response`,
        response.status,
        undefined,
        { cause },
      );
    }

    if (isRecord(payload) && isRecord(payload.value) && typeof payload.value.error === "string") {
      throw new AppiumClientError(
        payload.value.error,
        typeof payload.value.message === "string" ? payload.value.message : `Appium error: ${payload.value.error}`,
        response.status,
        payload.value,
      );
    }
    if (!response.ok) {
      throw new AppiumClientError(
        "APPIUM_HTTP_ERROR",
        `Appium request failed with HTTP ${response.status}`,
        response.status,
        payload,
      );
    }
    if (!isRecord(payload) || !Object.hasOwn(payload, "value")) {
      throw new AppiumClientError(
        "APPIUM_PROTOCOL_ERROR",
        "Appium returned an invalid W3C response",
        response.status,
        payload,
      );
    }
    return payload.value;
  }
}
