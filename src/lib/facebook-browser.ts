import "server-only";

import { mkdir } from "node:fs/promises";

import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";

import { appConfig } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { buildFacebookPostDescription } from "@/lib/facebook-context";
import { normalizeContentUrl } from "@/lib/schemas";

type FacebookBrowserState = {
  context: BrowserContext | null;
  launchPromise: Promise<BrowserContext> | null;
  extracting: boolean;
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
    extracting: false,
    lastError: null,
  });

async function isLoggedIn(context: BrowserContext) {
  const cookies = await context.cookies("https://www.facebook.com/");
  return cookies.some(
    (cookie) => cookie.name === "c_user" && cookie.domain.endsWith("facebook.com"),
  );
}

async function ensureBrowserContext() {
  if (state.context) return state.context;
  if (state.launchPromise) return state.launchPromise;

  state.launchPromise = (async () => {
    await mkdir(appConfig.facebookBrowserProfilePath, { recursive: true });
    try {
      const context = await chromium.launchPersistentContext(
        appConfig.facebookBrowserProfilePath,
        {
          headless: false,
          viewport: null,
          locale: "es-PE",
          args: ["--start-maximized"],
          ...(appConfig.facebookBrowserExecutablePath
            ? { executablePath: appConfig.facebookBrowserExecutablePath }
            : { channel: "msedge" }),
        },
      );
      state.context = context;
      state.lastError = null;
      context.on("close", () => {
        if (state.context === context) state.context = null;
        state.extracting = false;
      });
      return context;
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      throw new AppError(
        "No se pudo abrir Edge para iniciar sesión en Facebook.",
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

export async function getFacebookBrowserStatus() {
  if (!state.context) {
    return {
      status: "closed" as const,
      browserOpen: false,
      loggedIn: false,
      extracting: false,
      lastError: state.lastError,
    };
  }

  try {
    const loggedIn = await isLoggedIn(state.context);
    return {
      status: state.extracting
        ? ("extracting" as const)
        : loggedIn
          ? ("ready" as const)
          : ("login_required" as const),
      browserOpen: true,
      loggedIn,
      extracting: state.extracting,
      lastError: state.lastError,
    };
  } catch {
    state.context = null;
    state.extracting = false;
    return {
      status: "closed" as const,
      browserOpen: false,
      loggedIn: false,
      extracting: false,
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
    const context = await ensureBrowserContext();
    let page = context.pages().find((item) => item.url().includes("facebook.com"));
    if (!page) page = context.pages()[0] ?? (await context.newPage());
    if (!page.url().includes("facebook.com")) {
      await page.goto("https://www.facebook.com/", {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
    }
    await page.bringToFront();
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
  const context = state.context;
  state.context = null;
  if (context) await context.close();
  state.lastError = null;
  return getFacebookBrowserStatus();
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
      await page.waitForTimeout(400);
    }
  }
}

async function findMainArticle(page: Page): Promise<Locator | null> {
  const mainArticle = page.locator('[role="main"] [role="article"]').first();
  if (await mainArticle.count()) return mainArticle;
  const article = page.locator('[role="article"]').first();
  return (await article.count()) ? article : null;
}

async function expandPostText(page: Page, scope: Locator) {
  const button = scope.getByRole("button", { name: /^(Ver más|See more)$/i }).first();
  if (await button.isVisible().catch(() => false)) {
    await button.click({ timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(700);
    return;
  }
  const text = scope.getByText(/^(Ver más|See more)$/i, { exact: true }).first();
  if (await text.isVisible().catch(() => false)) {
    await text.click({ timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(700);
  }
}

async function readPostDescription(page: Page) {
  const article = await findMainArticle(page);
  const main = page.locator('[role="main"]').first();
  const scope = article ?? ((await main.count()) ? main : page.locator("body"));
  await expandPostText(page, scope);
  const messageSelector =
    '[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-testid="post_message"]';
  await scope
    .locator(messageSelector)
    .first()
    .waitFor({ state: "attached", timeout: 10_000 })
    .catch(() => undefined);
  let messages = await scope.locator(messageSelector).allInnerTexts();
  if (!messages.length) messages = await page.locator(messageSelector).allInnerTexts();
  const metadata = await page
    .locator('meta[property="og:description"], meta[name="description"]')
    .first()
    .getAttribute("content")
    .catch(() => "");

  return buildFacebookPostDescription({
    messages,
    metadata: metadata ?? "",
  });
}

export async function getAuthenticatedFacebookDescription(url: string) {
  const normalizedUrl = normalizeContentUrl("facebook", url);
  const status = await getFacebookBrowserStatus();
  if (!status.browserOpen || !state.context) {
    throw new AppError(
      "Abre Facebook en el navegador e inicia sesión antes de extraer.",
      409,
      "FACEBOOK_BROWSER_SESSION_REQUIRED",
    );
  }
  if (!status.loggedIn) {
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
  let page: Page | null = null;
  let keepPageOpen = false;
  try {
    page = await state.context.newPage();
    await page.goto(normalizedUrl, {
      waitUntil: "commit",
      timeout: 20_000,
    });
    await page
      .waitForLoadState("domcontentloaded", { timeout: 5_000 })
      .catch(() => undefined);
    await page.waitForTimeout(700);
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
      !(await isLoggedIn(state.context))
    ) {
      await page.bringToFront();
      keepPageOpen = true;
      throw new AppError(
        "Facebook solicita renovar la sesión en el navegador.",
        409,
        "FACEBOOK_BROWSER_LOGIN_REQUIRED",
      );
    }

    await dismissOptionalDialogs(page);
    const description = await readPostDescription(page);
    if (description.length < 5) {
      throw new AppError(
        "Facebook abrió la publicación, pero no encontró una descripción visible.",
        422,
        "FACEBOOK_BROWSER_CONTENT_EMPTY",
      );
    }
    return description;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "No se pudo leer la publicación desde la sesión de Facebook.",
      502,
      "FACEBOOK_BROWSER_EXTRACTION_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (page && !keepPageOpen) await page.close().catch(() => undefined);
    state.extracting = false;
  }
}
