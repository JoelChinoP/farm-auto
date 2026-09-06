import type Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";

import { chromium } from "playwright-core";
import type { BrowserContext, Locator, Page } from "playwright-core";

import { appConfig } from "./config.ts";
import { FacebookError, normalizeFacebookUrl } from "./facebook.ts";

const EXTRACTOR_VERSION = "facebook-edge-v2";
const MESSAGE_SELECTOR = '[data-ad-rendering-role="story_message"], [data-ad-preview="message"], [data-testid="post_message"]';
const COLLAPSED_DESCRIPTION = /(?:…|\.\.\.)\s*(?:(?:ver|see)\s+)?(?:más|mas|more)\s*$/iu;
const BOILERPLATE = [
  "create an account or log into facebook",
  "facebook helps you connect and share",
  "inicia sesión en facebook",
  "log into facebook",
  "see posts, photos and more on facebook",
  "regístrate o inicia sesión en facebook",
];

function normalizeText(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function isFacebookPostTarget(value: string) {
  const url = new URL(value);
  return /\/(?:posts|videos|reel|share\/[pvr])\/[^/]+/iu.test(url.pathname)
    || (url.pathname.startsWith("/watch") && url.searchParams.has("v"))
    || (["/permalink.php", "/story.php"].includes(url.pathname) && url.searchParams.has("story_fbid"))
    || (url.pathname === "/photo.php" && url.searchParams.has("fbid"));
}

export function isAllowedFacebookTargetRedirect(requestedValue: string, finalValue: string) {
  const requested = normalizeFacebookUrl(requestedValue);
  const final = normalizeFacebookUrl(finalValue);
  if (requested.normalizedUrl === final.normalizedUrl) return true;
  const requestedUrl = new URL(requested.sourceUrl);
  const resolvesTarget = requestedUrl.hostname.toLowerCase() === "fb.watch"
    || /^\/share\/[pvr]\/[^/]+\/?$/iu.test(requestedUrl.pathname)
    || (["/permalink.php", "/story.php"].includes(requestedUrl.pathname) && requestedUrl.searchParams.has("story_fbid"));
  return resolvesTarget && isFacebookPostTarget(final.sourceUrl);
}

export function buildFacebookPostContext(messages: string[], metadata = "", maxLength = 5_000) {
  const seen = new Set<string>();
  const useful = (messages.length ? messages : [metadata]).flatMap((raw) => {
    const value = normalizeText(raw);
    const key = value.toLocaleLowerCase("es");
    if (value.length < 3 || seen.has(key) || BOILERPLATE.some((fragment) => key.includes(fragment))) return [];
    seen.add(key);
    return [value];
  });
  let result = "";
  for (const value of useful) {
    const candidate = result ? `${result}\n${value}` : value;
    if (candidate.length > maxLength) break;
    result = candidate;
  }
  return result;
}

async function findPostScope(page: Page) {
  for (const selector of ['[role="dialog"]:visible:not([aria-label="Messenger"])', '[role="main"] [role="article"]:visible', '[role="article"]:visible']) {
    const scopes = page.locator(selector);
    const matches: Array<{ scope: Locator; signature: string; textLength: number }> = [];
    const count = Math.min(await scopes.count(), 10);
    for (let index = 0; index < count; index++) {
      const scope = scopes.nth(index);
      const messages = await scope.locator(MESSAGE_SELECTOR).allInnerTexts();
      if (!messages.length) continue;
      matches.push({
        scope,
        signature: [...new Set(messages.map(normalizeText))].sort().join("\n"),
        textLength: (await scope.innerText().catch(() => "")).length,
      });
    }
    if (matches.length) {
      if (new Set(matches.map((match) => match.signature)).size !== 1) {
        throw new FacebookError("FACEBOOK_TARGET_AMBIGUOUS", "Facebook expuso varias publicaciones y no se pudo aislar el objetivo.", 422);
      }
      return matches.sort((left, right) => left.textLength - right.textLength)[0].scope;
    }
    if (selector.startsWith('[role="dialog"]') && count === 1) return scopes.first();
  }
  const main = page.locator('[role="main"]:visible').first();
  return await main.count() ? main : page.locator("body");
}

async function expandPostText(page: Page, scope: Locator) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const button = scope.getByRole("button", { name: /^(Ver más|See more)$/i }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 3_000, force: true });
      await page.waitForTimeout(400);
      continue;
    }
    const text = scope.getByText(/^(Ver más|See more)$/i, { exact: true }).first();
    if (!await text.isVisible().catch(() => false)) return;
    await text.click({ timeout: 3_000, force: true });
    await page.waitForTimeout(400);
  }
}

async function readPostContext(page: Page) {
  const scope = await findPostScope(page);
  let previous = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    await expandPostText(page, scope);
    const messages = await scope.locator(MESSAGE_SELECTOR).allInnerTexts();
    const metadata = await page.locator('meta[property="og:description"], meta[name="description"]')
      .first().getAttribute("content").catch(() => "");
    const context = buildFacebookPostContext(messages, metadata ?? "");
    if (context.length >= 5 && !COLLAPSED_DESCRIPTION.test(context) && context === previous) return context;
    previous = context;
    await page.waitForTimeout(250);
  }
  if (COLLAPSED_DESCRIPTION.test(previous)) {
    throw new FacebookError("FACEBOOK_CONTENT_TRUNCATED", "Facebook no expandio el contenido completo.", 422);
  }
  if (previous.length < 5) throw new FacebookError("FACEBOOK_CONTENT_EMPTY", "Facebook no expuso contexto visible.", 422);
  return previous;
}

function isReelTarget(value: string) {
  return /^\/reels?\//iu.test(new URL(value).pathname);
}

export function reelCaptionFromLines(raw: string) {
  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.replace(/[\s\uFEFF]+/gu, " ").trim())
    .filter(Boolean);
  const headerIndex = lines.findIndex((line) => /^[^·]*·\s*(?:audio original|original audio)$/iu.test(line));
  if (headerIndex === -1) return "";
  return lines
    .slice(headerIndex + 1)
    .join(" ")
    .replace(/\s*(?:ver más|ver menos|see more|see less)$/iu, "")
    .replace(/[…]+$/gu, "")
    .trim();
}

const REEL_HEADER_PATTERN = /·\s*(?:audio original|original audio)/iu;
const REEL_TOGGLE_PATTERN = /(?:ver más|ver menos|see more|see less)/iu;

function reelPatterns() {
  return {
    headerSource: REEL_HEADER_PATTERN.source,
    headerFlags: REEL_HEADER_PATTERN.flags,
    toggleSource: REEL_TOGGLE_PATTERN.source,
    toggleFlags: REEL_TOGGLE_PATTERN.flags,
  };
}

async function readReelContext(page: Page) {
  let previous = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.evaluate((patterns) => {
      const header = new RegExp(patterns.headerSource, patterns.headerFlags);
      const toggle = new RegExp(patterns.toggleSource, patterns.toggleFlags);
      const candidates = [...document.querySelectorAll("body div")].filter((node) => {
        const text = node.textContent ?? "";
        return header.test(text) && toggle.test(text);
      });
      const container = candidates
        .sort((left, right) => left.querySelectorAll("*").length - right.querySelectorAll("*").length)[0] as HTMLElement | undefined;
      if (!container) return;
      const expand = [...container.querySelectorAll("*")].find((node) => node.children.length === 0
        && /^(?:…|\.\.\.)?\s*(?:ver más|see more)$/iu.test((node.textContent ?? "").replace(/[\s\uFEFF]+/gu, " ").trim())) as HTMLElement | undefined;
      if (expand) expand.click();
    }, reelPatterns());
    await page.waitForTimeout(400);
    const raw = await page.evaluate((patterns) => {
      const header = new RegExp(patterns.headerSource, patterns.headerFlags);
      const toggle = new RegExp(patterns.toggleSource, patterns.toggleFlags);
      const candidates = [...document.querySelectorAll("body div")].filter((node) => {
        const text = node.textContent ?? "";
        return header.test(text) && toggle.test(text);
      });
      const container = candidates
        .sort((left, right) => left.querySelectorAll("*").length - right.querySelectorAll("*").length)[0] as HTMLElement | undefined;
      return container ? container.innerText : "";
    }, reelPatterns());
    const context = reelCaptionFromLines(raw);
    if (context.length >= 5 && context === previous) return context;
    previous = context;
  }
  if (COLLAPSED_DESCRIPTION.test(previous)) {
    throw new FacebookError("FACEBOOK_CONTENT_TRUNCATED", "Facebook no expandio el contenido completo.", 422);
  }
  if (previous.length < 5) throw new FacebookError("FACEBOOK_CONTENT_EMPTY", "Facebook no expuso contexto visible.", 422);
  return previous;
}

async function readPostContextWithReelFallback(page: Page, reelFallback: boolean) {
  try {
    return await readPostContext(page);
  } catch (error) {
    if (reelFallback && error instanceof FacebookError && error.code === "FACEBOOK_CONTENT_EMPTY") {
      return await readReelContext(page);
    }
    throw error;
  }
}

export class FacebookBrowser {
  private context: BrowserContext | null = null;
  private launchPromise: Promise<BrowserContext> | null = null;
  private lockHeartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly database: Database.Database;
  private readonly owner: string;

  constructor(database: Database.Database, owner: string) {
    this.database = database;
    this.owner = owner;
  }

  private acquireLock() {
    const now = Date.now();
    // ponytail: a five-minute SQLite lease covers the bounded extractor; add heartbeats if browser work exceeds that ceiling.
    const result = this.database.prepare(`
      INSERT INTO browser_profile_locks (profile_path, owner, acquired_at, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_path) DO UPDATE SET
        owner = excluded.owner, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
      WHERE browser_profile_locks.owner = excluded.owner OR browser_profile_locks.expires_at <= excluded.acquired_at
    `).run(appConfig.facebookBrowserProfilePath.toLowerCase(), this.owner, now, now + 300_000);
    if (result.changes !== 1) {
      throw new FacebookError("FACEBOOK_BROWSER_BUSY", "Otro proceso de Farm Appium usa el perfil Edge de Facebook.", 409);
    }
  }

  private releaseLock() {
    try {
      this.database.prepare("DELETE FROM browser_profile_locks WHERE profile_path = ? AND owner = ?")
        .run(appConfig.facebookBrowserProfilePath.toLowerCase(), this.owner);
    } catch {
      // The database may already be closed during process shutdown.
    }
  }

  private async ensureContext() {
    if (this.context) {
      this.acquireLock();
      return this.context;
    }
    if (this.launchPromise) return this.launchPromise;
    this.acquireLock();
    this.launchPromise = (async () => {
      await mkdir(appConfig.facebookBrowserProfilePath, { recursive: true });
      try {
        const context = await chromium.launchPersistentContext(appConfig.facebookBrowserProfilePath, {
          headless: false,
          locale: "es-PE",
          viewport: null,
          args: ["--start-maximized"],
          ...(appConfig.facebookBrowserExecutablePath
            ? { executablePath: appConfig.facebookBrowserExecutablePath }
            : { channel: "msedge" }),
        });
        this.context = context;
        this.lockHeartbeat = setInterval(() => {
          try {
            this.acquireLock();
          } catch {
            void context.close().catch(() => undefined);
          }
        }, 60_000);
        this.lockHeartbeat.unref();
        context.on("close", () => {
          if (this.context === context) this.context = null;
          if (this.lockHeartbeat) clearInterval(this.lockHeartbeat);
          this.lockHeartbeat = null;
          this.releaseLock();
        });
        return context;
      } catch (error) {
        this.releaseLock();
        throw new FacebookError(
          "FACEBOOK_BROWSER_START_FAILED",
          "No se pudo abrir Microsoft Edge con el perfil dedicado de Facebook.",
          502,
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
    })();
    try {
      return await this.launchPromise;
    } finally {
      this.launchPromise = null;
    }
  }

  async extract(url: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const requestedUrl = normalizeFacebookUrl(url);
    const context = await this.ensureContext();
    const loggedIn = (await context.cookies("https://www.facebook.com/"))
      .some((cookie) => cookie.name === "c_user" && cookie.domain.endsWith("facebook.com"));
    if (!loggedIn) {
      const loginPage = context.pages()[0] ?? await context.newPage();
      await loginPage.goto("https://www.facebook.com/", {
        waitUntil: "domcontentloaded",
        timeout: appConfig.facebookExtractionTimeoutMs,
      }).catch(() => undefined);
      await loginPage.bringToFront();
      throw new FacebookError(
        "FACEBOOK_SESSION_REQUIRED",
        "Inicia sesion manualmente en la ventana Edge dedicada y reintenta la extraccion.",
        409,
      );
    }

    const page = await context.newPage();
    const abort = () => void page.close().catch(() => undefined);
    signal?.addEventListener("abort", abort, { once: true });
    let blockedExternalRedirect = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        try {
          normalizeFacebookUrl(request.url());
        } catch {
          blockedExternalRedirect = true;
          await route.abort("blockedbyclient");
          return;
        }
      }
      await route.continue();
    });
    try {
      signal?.throwIfAborted();
      try {
        await page.goto(requestedUrl.sourceUrl, {
          waitUntil: "domcontentloaded",
          timeout: appConfig.facebookExtractionTimeoutMs,
        });
      } catch (error) {
        if (blockedExternalRedirect) {
          throw new FacebookError("FACEBOOK_REDIRECT_BLOCKED", "Facebook redirigio la publicacion fuera de sus dominios.", 422);
        }
        throw error;
      }
      signal?.throwIfAborted();
      const normalizedFinalUrl = normalizeFacebookUrl(page.url());
      const finalUrl = normalizedFinalUrl.sourceUrl;
      const pathname = new URL(finalUrl).pathname.toLowerCase();
      if (pathname.startsWith("/login")) {
        throw new FacebookError("FACEBOOK_SESSION_REQUIRED", "La sesion web de Facebook expiro.", 409);
      }
      if (pathname.startsWith("/checkpoint")) {
        throw new FacebookError("FACEBOOK_INTERVENTION_REQUIRED", "Facebook requiere resolver un checkpoint manualmente.", 409);
      }
      if (!isAllowedFacebookTargetRedirect(requestedUrl.sourceUrl, finalUrl)) {
        throw new FacebookError("FACEBOOK_TARGET_REDIRECTED", "El enlace no resolvio a la publicacion esperada.", 422);
      }
      const contextText = await readPostContextWithReelFallback(page, isReelTarget(finalUrl));
      signal?.throwIfAborted();
      return { context: contextText, finalUrl, extractorVersion: EXTRACTOR_VERSION };
    } finally {
      signal?.removeEventListener("abort", abort);
      await page.close().catch(() => undefined);
    }
  }

  async close() {
    const context = this.context;
    this.context = null;
    if (this.lockHeartbeat) clearInterval(this.lockHeartbeat);
    this.lockHeartbeat = null;
    if (context) await context.close().catch(() => undefined);
    this.releaseLock();
  }
}
