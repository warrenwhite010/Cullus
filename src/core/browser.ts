// Rendering a page when a bare fetch is not enough.
//
// fetchPage() is a plain fetch plus regex HTML stripping. That is the right
// default — it is an order of magnitude cheaper than a browser — but it runs no
// JavaScript, so a single-page app yields almost nothing, and sites that
// fingerprint clients answer 403. This module is the fallback for those cases
// only. See the escalation rules in webTools.fetchPage.
//
// Deliberately NOT exposed to the model as tools. The Playwright MCP server
// would hand it around twenty browser tools, and this codebase has a measured
// failure from exactly that shape — see the comment above SERVER_KEYWORDS in
// provider.ts, where a model given 58 tools called none of them. The browser is
// an implementation detail; the model still sees web_search and fetch_url.
//
// Playwright is an OPTIONAL dependency. It pulls a large browser download, so
// everything here degrades to "not available" rather than throwing, and doctor
// reports the one command that fixes it.
//
// The security-relevant part is navigation guarding. The pre-flight host check
// in fetchPage only ever sees the URL the caller asked for. A browser follows
// redirects and runs scripts that navigate, so a public page can send it to
// 169.254.169.254 and read cloud metadata. Every main-frame request is therefore
// re-checked here, not just the first one.

import { blockedUrlReason } from "./netGuard.js";
import { debugLog } from "./session.js";

/** Closed after this long with no fetches, so no Chromium outlives a session. */
const IDLE_SHUTDOWN_MS = 60_000;
const NAV_TIMEOUT_MS = Number((process.env.CULLUS_BROWSER_TIMEOUT_MS ?? process.env.ASSISTANT_BROWSER_TIMEOUT_MS) ?? 25_000);

let browserPromise: Promise<any> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let playwrightMissing = false;

export interface RenderResult {
  html: string;
  status: number;
  url: string;
  error?: string;
  /** True when Playwright itself is unavailable, as opposed to the page failing. */
  unavailable?: boolean;
}

/** Is the browser path usable at all? Cheap after the first call. */
export async function browserAvailable(): Promise<boolean> {
  if (playwrightMissing) return false;
  try {
    await import("playwright");
    return true;
  } catch {
    playwrightMissing = true;
    return false;
  }
}

function touchIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void closeBrowser(), IDLE_SHUTDOWN_MS);
  // Never hold the process open just because a browser is warm.
  idleTimer.unref?.();
}

async function getBrowser(): Promise<any | null> {
  if (playwrightMissing) return null;

  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import("playwright");
      return chromium.launch({
        headless: true,
        args: ["--disable-dev-shm-usage", "--no-sandbox"],
      });
    })().catch((err) => {
      playwrightMissing = true;
      browserPromise = null;
      debugLog("browser-launch-failed", { message: err?.message });
      return null;
    });
  }

  return browserPromise;
}

/** Shut the browser down. Safe to call when nothing is running. */
export async function closeBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const pending = browserPromise;
  browserPromise = null;
  try {
    const browser = await pending;
    await browser?.close();
  } catch {
    /* already gone */
  }
}

/**
 * Load a URL in a real browser and return the rendered HTML.
 *
 * One fresh context per call, so nothing — cookies, storage, service workers —
 * carries between two pages the model reads.
 */
export async function renderPage(rawUrl: string): Promise<RenderResult> {
  const fail = (error: string, extra: Partial<RenderResult> = {}): RenderResult => ({
    html: "",
    status: 0,
    url: rawUrl,
    error,
    ...extra,
  });

  if (!(await browserAvailable())) {
    return fail("Playwright is not installed.", { unavailable: true });
  }

  const browser = await getBrowser();
  if (!browser) return fail("The browser could not be launched.", { unavailable: true });

  touchIdleTimer();

  let context: any;
  try {
    context = await browser.newContext({
      javaScriptEnabled: true,
      // A stated bot UA gets blocked by the very sites this path exists for.
      // Ordinary desktop Chrome, and nothing more: no stealth patching.
      viewport: { width: 1280, height: 900 },
    });

    let blockedReason: string | null = null;

    // The guard. Every request the page makes is checked, so a redirect chain or
    // a script-driven navigation cannot reach an address the pre-flight check
    // would have refused.
    await context.route("**/*", async (route: any) => {
      const request = route.request();
      const type = request.resourceType();

      // Text is all that is wanted. Blocking these cuts page time substantially
      // and removes a large slice of what a hostile page can even attempt.
      if (["image", "media", "font", "stylesheet"].includes(type)) {
        return route.abort();
      }

      let target: URL;
      try {
        target = new URL(request.url());
      } catch {
        return route.abort();
      }

      const reason = await blockedUrlReason(target);
      if (reason) {
        // Only a main-frame navigation is worth reporting as a refusal; a
        // blocked subresource is noise.
        if (type === "document" && request.isNavigationRequest()) blockedReason = reason;
        debugLog("browser-blocked-request", { url: request.url(), reason });
        return route.abort();
      }

      // Redirects are the hole. route.continue() hands the request to the
      // browser's network stack, which follows 3xx hops itself — the handler
      // never sees them, so a public URL redirecting to 169.254.169.254 issues
      // that request before anything can object. Measured, not theorised: a
      // local listener received the redirected GET.
      //
      // So navigations are fetched with redirects disabled, the Location header
      // is checked against the same guard, and only then is the 3xx handed back
      // for the browser to follow — which re-enters this handler for the next
      // hop. Subresources keep the cheap path; they cannot become the page.
      if (!request.isNavigationRequest()) return route.continue();

      try {
        const response = await route.fetch({ maxRedirects: 0 });
        const status = response.status();

        if (status >= 300 && status < 400) {
          const location = response.headers()["location"];
          if (location) {
            let next: URL;
            try {
              next = new URL(location, request.url());
            } catch {
              return route.abort();
            }

            const hopReason = await blockedUrlReason(next);
            if (hopReason) {
              blockedReason = hopReason;
              debugLog("browser-blocked-redirect", { from: request.url(), to: next.toString() });
              return route.abort();
            }
          }
        }

        return route.fulfill({ response });
      } catch (err: any) {
        debugLog("browser-route-fetch-failed", { url: request.url(), message: err?.message });
        return route.abort();
      }
    });

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    const response = await page.goto(rawUrl, { waitUntil: "domcontentloaded" });

    if (blockedReason) return fail(blockedReason);

    // Give client-side rendering a moment to populate, but never block on a page
    // that keeps a connection open forever.
    try {
      await page.waitForLoadState("networkidle", { timeout: 5_000 });
    } catch {
      /* good enough — read what rendered */
    }

    const html = await page.content();
    const finalUrl = page.url();

    // Belt and braces: the final URL is re-checked even though every navigation
    // was routed, because route interception and redirects have edge cases and
    // this costs nothing.
    const finalReason = await blockedUrlReason(new URL(finalUrl));
    if (finalReason) return fail(finalReason);

    return { html, status: response?.status() ?? 0, url: finalUrl };
  } catch (err: any) {
    if (blockedReasonFrom(err)) return fail(blockedReasonFrom(err)!);
    return fail(`Browser could not load the page: ${err?.message ?? String(err)}`);
  } finally {
    try {
      await context?.close();
    } catch {
      /* nothing to do */
    }
  }
}

/**
 * A navigation aborted by the route guard surfaces as a generic Playwright
 * error, so the useful reason has to be recovered from it.
 */
function blockedReasonFrom(err: any): string | null {
  const message = String(err?.message ?? "");
  if (/net::ERR_FAILED|net::ERR_ABORTED/.test(message)) {
    return "Refusing to load that page: a navigation was blocked as a private or non-http address.";
  }
  return null;
}
