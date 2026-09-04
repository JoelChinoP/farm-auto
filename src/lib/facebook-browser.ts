import "server-only";

import { mkdir } from "node:fs/promises";

import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";

import { appConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { buildFacebookPostDescription } from "@/lib/facebook-context";
import {
  normalizeContentUrl,
  preferFacebookVideoPostUrl,
} from "@/lib/schemas";

type FacebookBrowserState = {
  context: BrowserContext | null;
  launchPromise: Promise<BrowserContext> | null;
  mode: "background" | "login" | null;
  extracting: boolean;
  extractionController: AbortController | null;
  extractingPage: Page | null;
  lastError: string | null;
};

const globalState = globalThis as typeof globalThis & {
  facebookBrowserState?: FacebookBrowserState;
};

const state =
  globalState.facebookBrowserState ??
  (globalState.facebookBrowserState = {
    context: null,
    launchPromise: null,
    mode: null,
    extracting: false,
    extractionController: null,
    extractingPage: null,
    lastError: null,
  });

state.mode ??= state.context ? "login" : null;

const messageSelector =
  '[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-testid="post_message"]';
const reelDetailsSelector = [
  '[aria-label="Detalles del reel"]',
  '[aria-label="Detalles del video"]',
  '[aria-label="Reel details"]',
  '[aria-label="Video details"]',
].join(", ");
const descriptionSelector = `${messageSelector}, ${reelDetailsSelector}`;
const collapsedDescription =
  /(?:…|\.\.\.)\s*(?:(?:ver|see)\s+)?(?:más|mas|more)\s*$/iu;
const expandedReelDescription = /\s*(?:ver menos|see less)\s*$/iu;

async function isLoggedIn(context: BrowserContext) {
  const cookies = await context.cookies("https://www.facebook.com/");
  return cookies.some(
    (cookie) =>
      cookie.name === "c_user" && cookie.domain.endsWith("facebook.com"),
  );
}

async function closeCurrentContext() {
  const context = state.context;
  state.context = null;
  state.mode = null;
  if (context) await context.close().catch(() => undefined);
}

async function ensureBrowserContext(mode: "background" | "login") {
  if (state.context && state.mode === mode) return state.context;
  if (state.context) await closeCurrentContext();
  if (state.launchPromise) {
    await state.launchPromise;
    return ensureBrowserContext(mode);
  }

  state.launchPromise = (async () => {
    await mkdir(appConfig.facebookBrowserProfilePath, { recursive: true });
    try {
      const context = await chromium.launchPersistentContext(
        appConfig.facebookBrowserProfilePath,
        {
          headless: mode === "background",
          viewport: mode === "background" ? { width: 1280, height: 900 } : null,
          locale: "es-PE",
          args: mode === "login" ? ["--start-maximized"] : [],
          ...(appConfig.facebookBrowserExecutablePath
            ? { executablePath: appConfig.facebookBrowserExecutablePath }
            : { channel: "msedge" }),
        },
      );
      state.context = context;
      state.mode = mode;
      state.lastError = null;
      context.on("close", () => {
        if (state.context === context) {
          state.context = null;
          state.mode = null;
        }
        state.extracting = false;
      });
      return context;
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      throw new AppError(
        mode === "login"
          ? "No se pudo abrir Edge para iniciar sesión en Facebook."
          : "No se pudo iniciar Playwright en segundo plano.",
        502,
        "FACEBOOK_BROWSER_START_FAILED",
        state.lastError,
      );
    }
  })();

  try {
    return await state.launchPromise;
  } finally {
    state.launchPromise = null;
  }
}

async function showFacebookLogin(
  context: BrowserContext,
  url = "https://www.facebook.com/",
) {
  let page = context.pages().find((item) => item.url().includes("facebook.com"));
  if (!page) page = context.pages()[0] ?? (await context.newPage());
  if (!page.url().includes("facebook.com") || url !== "https://www.facebook.com/") {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
  }
  await page.bringToFront();
}

export async function getFacebookBrowserStatus() {
  if (!state.context && state.launchPromise) {
    await state.launchPromise.catch(() => undefined);
  }
  if (!state.context) {
    return {
      status: "closed" as const,
      browserOpen: false,
      loggedIn: false,
      extracting: false,
      mode: null,
      lastError: state.lastError,
    };
  }

  try {
    let loggedIn = await isLoggedIn(state.context);
    if (!state.extracting && loggedIn && state.mode === "login") {
      await closeCurrentContext();
      const context = await ensureBrowserContext("background");
      loggedIn = await isLoggedIn(context);
    } else if (!state.extracting && !loggedIn && state.mode === "background") {
      await closeCurrentContext();
      const context = await ensureBrowserContext("login");
      await showFacebookLogin(context);
    }
    return {
      status: state.extracting
        ? ("extracting" as const)
        : loggedIn
          ? ("ready" as const)
          : ("login_required" as const),
      browserOpen: true,
      loggedIn,
      extracting: state.extracting,
      mode: state.mode,
      lastError: state.lastError,
    };
  } catch {
    await closeCurrentContext();
    state.extracting = false;
    return {
      status: "closed" as const,
      browserOpen: false,
      loggedIn: false,
      extracting: false,
      mode: null,
      lastError: state.lastError,
    };
  }
}

export async function openFacebookBrowser() {
  if (state.extracting) {
    throw new AppError(
      "Espera a que termine la extracción actual.",
      409,
      "FACEBOOK_BROWSER_BUSY",
    );
  }
  try {
    const currentStatus = await getFacebookBrowserStatus();
    if (currentStatus.loggedIn && state.mode === "background") {
      return currentStatus;
    }
    if (state.context && state.mode === "login") {
      await showFacebookLogin(state.context);
      return getFacebookBrowserStatus();
    }
    const backgroundContext = await ensureBrowserContext("background");
    if (await isLoggedIn(backgroundContext)) return getFacebookBrowserStatus();
    await closeCurrentContext();
    const loginContext = await ensureBrowserContext("login");
    await showFacebookLogin(loginContext);
    return getFacebookBrowserStatus();
  } catch (error) {
    if (error instanceof AppError) throw error;
    state.lastError = error instanceof Error ? error.message : String(error);
    throw new AppError(
      "Edge se abrió, pero no pudo cargar Facebook.",
      502,
      "FACEBOOK_BROWSER_NAVIGATION_FAILED",
      state.lastError,
    );
  }
}

export async function closeFacebookBrowser() {
  if (state.extracting) {
    throw new AppError(
      "No se puede cerrar el navegador durante una extracción.",
      409,
      "FACEBOOK_BROWSER_BUSY",
    );
  }
  await closeCurrentContext();
  state.lastError = null;
  return getFacebookBrowserStatus();
}

export function abortFacebookExtraction() {
  if (!state.extracting) return false;
  state.extractionController?.abort();
  void state.extractingPage?.close().catch(() => undefined);
  return true;
}

async function dismissOptionalDialogs(page: Page) {
  const labels = [
    /^(Permitir todas las cookies|Allow all cookies)$/i,
    /^(Solo permitir cookies esenciales|Only allow essential cookies)$/i,
    /^(Ahora no|Not now)$/i,
  ];
  for (const name of labels) {
    const button = page.getByRole("button", { name }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(250);
    }
  }
}

async function findPostScope(page: Page): Promise<Locator> {
  for (const selector of [
    '[role="dialog"]:visible',
    '[role="main"] [role="article"]:visible',
    '[role="article"]:visible',
  ]) {
    const scopes = page.locator(selector);
    const matches: Array<{
      scope: Locator;
      signature: string;
      textLength: number;
    }> = [];
    const count = Math.min(await scopes.count(), 10);
    for (let index = 0; index < count; index++) {
      const scope = scopes.nth(index);
       const messages = await scope.locator(descriptionSelector).allInnerTexts();
      if (!messages.length) continue;
      const signature = [...new Set(
        messages.map((message) => message.replace(/\s+/g, " ").trim()),
      )]
        .sort()
        .join("\n");
      matches.push({
        scope,
        signature,
        textLength: (await scope.innerText().catch(() => "")).length,
      });
    }
    if (matches.length) {
      if (new Set(matches.map((match) => match.signature)).size === 1) {
        return matches.sort((left, right) => left.textLength - right.textLength)[0]
          .scope;
      }
      throw new AppError(
        "Facebook expuso varias publicaciones y no se pudo aislar el objetivo.",
        422,
        "FACEBOOK_BROWSER_TARGET_AMBIGUOUS",
      );
    }
    if (selector.startsWith('[role="dialog"]') && count === 1) {
      return scopes.first();
    }
  }
  const main = page.locator('[role="main"]:visible').first();
  return (await main.count()) ? main : page.locator("body");
}

async function findReelScope(page: Page): Promise<Locator> {
  for (const selector of ['[role="dialog"]:visible', '[role="main"]:visible']) {
    const scope = page.locator(selector).first();
    if (await scope.count()) return scope;
  }
  return page.locator("body");
}

async function expandPostText(page: Page, scope: Locator) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const button = scope
      .getByRole("button", { name: /^(Ver más|See more)$/i })
      .first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 3_000, force: true });
      await page.waitForTimeout(600);
      continue;
    }
    const text = scope
      .getByText(/^(Ver más|See more)$/i, { exact: true })
      .first();
    if (!(await text.isVisible().catch(() => false))) return;
    await text.click({ timeout: 3_000, force: true });
    await page.waitForTimeout(600);
  }
}

async function readFacebookMetadata(page: Page) {
  const metadata = page.locator(
    'meta[property="og:description"], meta[name="description"]',
  );
  if (!(await metadata.count())) return "";
  return metadata.first().getAttribute("content").catch(() => "");
}

async function readReelMessages(scope: Locator) {
  const values = await scope.locator('span[dir="auto"]:visible').allInnerTexts();
  const candidates = [...new Set(
    values
      .map((value) => value.replace(/\s+/g, " ").trim())
      .filter((value) => value.length >= 5),
  )];
  const expanded = candidates.filter((value) => expandedReelDescription.test(value));
  if (expanded.length === 1) {
    return [expanded[0].replace(expandedReelDescription, "").trim()];
  }
  return candidates.length === 1 ? candidates : [];
}

async function readPostDescription(page: Page) {
  const pathname = new URL(page.url()).pathname.toLowerCase();
  const isReel = /\/(?:reel|reels|share\/r)\//.test(pathname);
  const scope = isReel ? await findReelScope(page) : await findPostScope(page);
  const metadata = await readFacebookMetadata(page);
  const metadataDescription = buildFacebookPostDescription({
    messages: [],
    metadata: metadata ?? "",
  });
  const deadline = Date.now() + 5_000;
  const metadataFallbackAt = Date.now() + 1_000;
  let previous = "";

  while (Date.now() < deadline) {
    let messages: string[];
    if (isReel) {
      messages = await readReelMessages(scope);
      if (messages.some((message) => collapsedDescription.test(message))) {
        const button = scope
          .getByRole("button", { name: /^(Ver más|See more)$/i })
          .first();
        if (await button.isVisible().catch(() => false)) {
          await button.click({ timeout: 3_000, force: true });
          await page.waitForTimeout(250);
          messages = await readReelMessages(scope);
        }
      }
    } else {
      await expandPostText(page, scope);
      messages = await scope.locator(descriptionSelector).allInnerTexts();
    }
    const description = buildFacebookPostDescription({
      messages,
    });
    if (
      description.length >= 5 &&
      !collapsedDescription.test(description) &&
      description === previous
    ) {
      return description;
    }
    if (description) previous = description;
    if (!description && metadataDescription && (isReel || Date.now() >= metadataFallbackAt)) {
      return metadataDescription;
    }
    await page.waitForTimeout(250);
  }

  if (collapsedDescription.test(previous)) {
    throw new AppError(
      "Facebook no expandió el contenido completo de la publicación.",
      422,
      "FACEBOOK_BROWSER_CONTENT_TRUNCATED",
    );
  }
  if (previous || metadataDescription) return previous || metadataDescription;
  throw new AppError(
    "Facebook abrió la publicación, pero no encontró una descripción visible.",
    422,
    "FACEBOOK_BROWSER_CONTENT_EMPTY",
  );
}

export async function getAuthenticatedFacebookDescription(url: string) {
  const normalizedUrl = normalizeContentUrl("facebook", url);
  const context = state.context ?? await ensureBrowserContext("background");
  if (!(await isLoggedIn(context))) {
    await closeCurrentContext();
    const loginContext = await ensureBrowserContext("login");
    await showFacebookLogin(loginContext, normalizedUrl);
    throw new AppError(
      "Completa el inicio de sesión en la ventana de Facebook.",
      409,
      "FACEBOOK_BROWSER_LOGIN_REQUIRED",
    );
  }
  if (state.extracting) {
    throw new AppError(
      "Ya hay una publicación de Facebook en proceso.",
      409,
      "FACEBOOK_BROWSER_BUSY",
    );
  }

  state.extracting = true;
  const controller = new AbortController();
  state.extractionController = controller;
  let page: Page | null = null;
  try {
    controller.signal.throwIfAborted();
    page = await context.newPage();
    state.extractingPage = page;
    controller.signal.throwIfAborted();
    await page.goto(normalizedUrl, {
      waitUntil: "commit",
      timeout: 12_000,
    });
    await page
      .waitForLoadState("domcontentloaded", { timeout: 2_000 })
      .catch(() => undefined);
    controller.signal.throwIfAborted();
    try {
      normalizeContentUrl("facebook", page.url());
    } catch {
      throw new AppError(
        "Facebook redirigió la publicación fuera de sus dominios.",
        502,
        "FACEBOOK_BROWSER_REDIRECT_BLOCKED",
      );
    }

    const pathname = new URL(page.url()).pathname.toLowerCase();
    if (
      pathname.startsWith("/login") ||
      pathname.startsWith("/checkpoint") ||
      !(await isLoggedIn(context))
    ) {
      await page.close().catch(() => undefined);
      page = null;
      await closeCurrentContext();
      const loginContext = await ensureBrowserContext("login");
      await showFacebookLogin(loginContext, normalizedUrl);
      throw new AppError(
        "Facebook solicita renovar la sesión en el navegador.",
        409,
        "FACEBOOK_BROWSER_LOGIN_REQUIRED",
      );
    }

    await dismissOptionalDialogs(page);
    const openGraphUrl = await page
      .locator('meta[property="og:url"]')
      .evaluateAll((elements) => elements[0]?.getAttribute("content") ?? null);
    const description = await readPostDescription(page);
    controller.signal.throwIfAborted();
    return {
      description,
      // Facebook resolves shared video links to /reel/ URLs, which open its isolated
      // player on Android. The Open Graph URL keeps the interactive video post surface.
      url: preferFacebookVideoPostUrl(
        page.url(),
        openGraphUrl,
      ),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AppError(
        "La extracción fue cancelada por el operador.",
        409,
        "FACEBOOK_EXTRACTION_CANCELLED",
      );
    }
    if (error instanceof AppError) throw error;
    throw new AppError(
      "No se pudo leer la publicación desde la sesión de Facebook.",
      502,
      "FACEBOOK_BROWSER_EXTRACTION_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (page) await page.close().catch(() => undefined);
    if (state.extractingPage === page) state.extractingPage = null;
    if (state.extractionController === controller) state.extractionController = null;
    state.extracting = false;
  }
}
