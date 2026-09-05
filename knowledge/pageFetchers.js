import puppeteer from "puppeteer";
import { convert } from "html-to-text";
import { pool } from "../db.js";

let browserInstance = null;

/**
 * Returns a shared Puppeteer browser instance.
 * Automatically handles reconnection if the browser is closed or disconnected.
 */
async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browserInstance;
}

/**
 * Fetches static HTML from a URL and extracts clean text using html-to-text.
 * @param {string} url 
 * @returns {Promise<string>}
 */
export async function fetchStaticPage(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Static fetch HTTP error: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const text = convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "nav", format: "skip" },
      { selector: "footer", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "img", format: "skip" },
    ],
  });

  return text.trim();
}

/**
 * Uses headless Puppeteer to render client-side JavaScript (e.g. React SPA)
 * and extracts innerText of the document body.
 * @param {string} url 
 * @returns {Promise<string>}
 */
export async function fetchRenderedPage(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 800 });

    // Navigate and wait for networkidle0 with 15s timeout
    await page.goto(url, {
      waitUntil: "networkidle0",
      timeout: 15000,
    });

    const text = await page.evaluate(() => {
      // Clean up obvious non-content elements before reading
      const selectorsToRemove = ["script", "style", "noscript", "svg"];
      selectorsToRemove.forEach((tag) => {
        document.querySelectorAll(tag).forEach((el) => el.remove());
      });
      return document.body ? document.body.innerText : "";
    });

    return (text || "").trim();
  } finally {
    try {
      await page.close();
    } catch {
      // ignore page close errors
    }
  }
}

/**
 * Dispatcher:
 * 'static' -> fetchStaticPage
 * 'react' -> fetchRenderedPage
 * 'auto' (default) -> try static first, fallback to Puppeteer if result < 200 chars
 * @param {string} url 
 * @param {string} [pageType='auto'] 
 * @returns {Promise<string>}
 */
export async function fetchPageContent(url, pageType = "auto") {
  const normalizedType = (pageType || "auto").toLowerCase();

  if (normalizedType === "static") {
    return await fetchStaticPage(url);
  }

  if (normalizedType === "react") {
    return await fetchRenderedPage(url);
  }

  // 'auto' mode: try static first
  try {
    const staticText = await fetchStaticPage(url);
    if (staticText && staticText.length >= 200) {
      return staticText;
    }
    console.log(`[fetchPageContent] Static text too short (${staticText?.length || 0} chars) for ${url}. Falling back to Puppeteer.`);
  } catch (err) {
    console.warn(`[fetchPageContent] Static fetch failed for ${url} (${err.message}). Falling back to Puppeteer.`);
  }

  return await fetchRenderedPage(url);
}

/**
 * Queries all active tracked_pages, fetches each one via fetchPageContent,
 * and updates their cache columns independently.
 * @returns {Promise<Array<{id: number, label: string, status: string, error?: string}>>}
 */
export async function refreshTrackedPages() {
  console.log("[refreshTrackedPages] Starting refresh of active tracked pages...");
  let pages = [];
  try {
    const res = await pool.query(
      `SELECT id, label, url, page_type FROM tracked_pages WHERE is_active = TRUE ORDER BY id ASC`
    );
    pages = res.rows;
  } catch (err) {
    console.error("[refreshTrackedPages] Failed to query tracked_pages:", err);
    throw err;
  }

  if (pages.length === 0) {
    console.log("[refreshTrackedPages] No active tracked pages to refresh.");
    return [];
  }

  const results = await Promise.allSettled(
    pages.map(async (page) => {
      try {
        const text = await fetchPageContent(page.url, page.page_type);

        if (!text || text.trim().length === 0) {
          throw new Error("Fetched page content was empty.");
        }

        await pool.query(
          `UPDATE tracked_pages
           SET page_content_cache = $1,
               cache_updated_at = NOW(),
               last_fetched_at = NOW(),
               last_fetch_status = 'success',
               last_fetch_error = NULL
           WHERE id = $2`,
          [text, page.id]
        );

        console.log(`[refreshTrackedPages] Successfully refreshed page [${page.id}] ${page.label} (${text.length} chars)`);
        return { id: page.id, label: page.label, status: "success" };
      } catch (err) {
        const errorMessage = err?.message || String(err);
        console.error(`[refreshTrackedPages] Failed refreshing page [${page.id}] ${page.label}:`, errorMessage);

        await pool.query(
          `UPDATE tracked_pages
           SET last_fetched_at = NOW(),
               last_fetch_status = 'failed',
               last_fetch_error = $1
           WHERE id = $2`,
          [errorMessage, page.id]
        );

        return { id: page.id, label: page.label, status: "failed", error: errorMessage };
      }
    })
  );

  return results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { id: pages[i].id, label: pages[i].label, status: "failed", error: r.reason?.message || String(r.reason) }
  );
}
