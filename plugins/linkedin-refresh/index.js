/**
 * LinkedIn Cookie Refresh Plugin for camofox-browser.
 *
 * Provides a flow to refresh the `li_at` session cookie for a user by
 * prompting them to log in via the browser itself — no Docker VNC required.
 *
 * Usage:
 *   POST /linkedin/refresh?userId=xxx
 *
 * Flow:
 *   1. Create or reuse the user's session + open a new tab to LinkedIn login
 *   2. Wait for the user to authenticate (polls every 5s for up to 5 min)
 *   3. Extract the `li_at` cookie from the tab's browser context
 *   4. Checkpoint the user's storage state so it persists across restarts
 *   5. Return {ok: true, message: "..."} or {ok: false, error: "..."}
 *
 * Configuration (camofox.config.json):
 *   {
 *     "plugins": {
 *       "linkedin-refresh": {
 *         "enabled": true,
 *         "pollIntervalMs": 5000,
 *         "timeoutMs": 300000
 *       }
 *     }
 *   }
 */

import { persistStorageState } from '../../lib/persistence.js';

const DEFAULT_POLL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Detect whether the LinkedIn page has an active auth wall (login gate).
 * We check for the presence of the feed URL or a confirmed logged-in indicator.
 */
async function isLinkedInAuthenticated(page) {
  try {
    const url = page.url();

    // Already on feed = definitely logged in
    if (url.includes('linkedin.com/feed') || url.includes('linkedin.com/mynetwork')) {
      return true;
    }

    // Check DOM for logged-in indicators
    const result = await page.evaluate(() => {
      // Logged-in: top-nav identity block is present
      const identityBlock = document.querySelector(
        '.feed-identity-module, .global-nav, .nav-footer, [data-control-name="identity_profile"]'
      );
      if (identityBlock) return true;

      // Also check for the feed main content
      const feed = document.querySelector('.scaffold-finite-scroll, .feed-shared-update-v2');
      if (feed) return true;

      return false;
    });

    return result;
  } catch {
    return false;
  }
}

export async function register(app, ctx, pluginConfig = {}) {
  const { events, config, log, getSession, safePageClose, normalizeUserId } = ctx;

  const pollIntervalMs = pluginConfig.pollIntervalMs ?? DEFAULT_POLL_MS;
  const timeoutMs = pluginConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const profileDir =
    process.env.CAMOFOX_PROFILE_DIR || pluginConfig.profileDir || config.profileDir;

  if (!profileDir) {
    log('warn', 'linkedin-refresh plugin: no profileDir configured, cookie persistence disabled');
  }

  log('info', 'linkedin-refresh plugin enabled', { profileDir, pollIntervalMs, timeoutMs });

  /**
   * POST /linkedin/refresh?userId=xxx
   *
   * Opens a tab, navigates to LinkedIn login, waits for auth, extracts li_at,
   * checkpoints the user's storage state, and returns the result.
   */
  app.post('/linkedin/refresh', async (req, res) => {
    const userId = req.query?.userId || req.body?.userId;
    if (!userId) {
      return res.status(400).json({ ok: false, error: 'userId is required (query or body)' });
    }

    const reqId = req.reqId;
    const key = normalizeUserId(userId);

    log('info', 'linkedin-refresh: starting', { reqId, userId: key });

    let tabId = null;
    let tabState = null;
    let session = null;
    let contextForCookies = null;

    try {
      // --- Step 1: Get or create the user's session ---
      session = await ctx.getSession(key);

      // --- Step 2: Open a fresh tab to LinkedIn login ---
      const page = await session.context.newPage();
      tabId = `li-refresh-${Date.now()}`;
      contextForCookies = session.context;

      tabState = {
        page,
        tabId,
        userId: key,
      };

      log('info', 'linkedin-refresh: opened LinkedIn tab', { reqId, userId: key, tabId });

      await page.goto('https://www.linkedin.com/login', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      log('info', 'linkedin-refresh: navigated to LinkedIn login', { reqId, userId: key, url: page.url() });

      // --- Step 3: Poll until authenticated or timed out ---
      const startTime = Date.now();
      let authenticated = false;
      let lastCheck = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        // Short wait between polls
        await page.waitForTimeout(pollIntervalMs);

        if (page.isClosed()) {
          return res.status(410).json({
            ok: false,
            error: 'LinkedIn tab was closed before authentication completed',
          });
        }

        const isAuth = await isLinkedInAuthenticated(page).catch(() => false);
        if (isAuth) {
          authenticated = true;
          log('info', 'linkedin-refresh: authentication detected', {
            reqId,
            userId: key,
            url: page.url(),
            elapsedMs: Date.now() - startTime,
          });
          break;
        }

        // Refresh the page if still on login page and stale
        const currentUrl = page.url();
        if (currentUrl.includes('/login') && Date.now() - lastCheck > 2 * pollIntervalMs) {
          lastCheck = Date.now();
          try {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
          } catch {
            // Page may have navigated; ignore reload errors
          }
        }
      }

      if (!authenticated) {
        await safePageClose(page).catch(() => {});
        return res.status(408).json({
          ok: false,
          error: `Authentication timeout: LinkedIn did not authenticate within ${Math.round(timeoutMs / 1000)}s. Please log in manually.`,
        });
      }

      // --- Step 4: Extract li_at cookie from the context ---
      const cookies = await contextForCookies.cookies('https://www.linkedin.com');
      const liAtCookie = cookies.find((c) => c.name === 'li_at');

      if (!liAtCookie) {
        await safePageClose(page).catch(() => {});
        return res.status(500).json({
          ok: false,
          error: 'li_at cookie not found in browser context after authentication. LinkedIn may have changed their auth flow.',
        });
      }

      log('info', 'linkedin-refresh: li_at cookie extracted', {
        reqId,
        userId: key,
        domain: liAtCookie.domain,
        expires: liAtCookie.expires,
        httpOnly: liAtCookie.httpOnly,
      });

      // --- Step 5: Checkpoint storage state for the user ---
      if (profileDir) {
        const result = await persistStorageState({
          profileDir,
          userId: key,
          context: contextForCookies,
          logger: { warn: (msg, f) => log('warn', msg, f) },
        });
        if (result.persisted) {
          log('info', 'linkedin-refresh: storage state persisted', {
            reqId,
            userId: key,
            path: result.storageStatePath,
          });
        } else {
          log('warn', 'linkedin-refresh: storage state persist skipped or failed', {
            reqId,
            userId: key,
            reason: result.reason,
          });
        }
      }

      // --- Step 6: Close the auth tab ---
      await safePageClose(page).catch(() => {});

      log('info', 'linkedin-refresh: complete', {
        reqId,
        userId: key,
        elapsedMs: Date.now() - startTime,
        cookieDomain: liAtCookie.domain,
      });

      return res.json({
        ok: true,
        message: 'li_at cookie refreshed and storage state checkpointed successfully',
        cookie: {
          name: liAtCookie.name,
          domain: liAtCookie.domain,
          path: liAtCookie.path,
          expires: liAtCookie.expires,
          httpOnly: liAtCookie.httpOnly,
          secure: liAtCookie.secure,
        },
        storageCheckpoint: !!profileDir,
      });
    } catch (err) {
      if (tabState?.page && !tabState.page.isClosed()) {
        await safePageClose(tabState.page).catch(() => {});
      }
      const msg = ctx.safeError ? ctx.safeError(err) : err.message;
      log('error', 'linkedin-refresh: failed', { reqId, userId: key, error: err.message });
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  // Emit event on successful refresh
  events.on('server:shutdown', async () => {
    // Nothing to clean up — tabs are managed by the session lifecycle
  });
}
