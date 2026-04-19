/**
 * Test helper - upload_file
 * Demonstrates a helper that exposes a custom browser action.
 * 
 * LLM description: Upload a file to a web page element. Provide the element ref and local file path.
 */

export const name = 'upload_file';
export const description = 'Upload a file to a web page element. Provide the element ref and local file path.';

export async function register(app, ctx) {
  /**
   * POST /helpers/upload_file
   * Upload a file to an element on the page.
   * 
   * Body: { userId, tabId, ref, filePath }
   *   userId    - User session ID
   *   tabId     - Tab ID to interact with
   *   ref       - Element ref (e.g. "e5") or CSS selector for the file input
   *   filePath  - Absolute path to the local file to upload
   * 
   * Returns: { ok: true, filePath }
   */
  app.post('/helpers/upload_file', async (req, res) => {
    try {
      const { userId, tabId, ref, filePath } = req.body;
      if (!userId) return res.status(400).json({ error: 'userId required' });
      if (!tabId) return res.status(400).json({ error: 'tabId required' });
      if (!filePath) return res.status(400).json({ error: 'filePath required' });

      const session = await ctx.getSession(userId);

      // Find the tab in session.tabGroups
      let foundTab = null;
      for (const group of session.tabGroups.values()) {
        if (group.has(tabId)) {
          foundTab = group.get(tabId);
          break;
        }
      }
      if (!foundTab) return res.status(404).json({ error: 'Tab not found' });

      const { page, refs } = foundTab;
      page.toolCalls++; page.consecutiveTimeouts = 0;

      // Resolve element by ref or selector
      let locator;
      if (ref && refs) {
        const info = refs.get(ref);
        if (info) {
          locator = page.getByRole(info.role, info.name ? { name: info.name } : undefined).nth(info.nth);
        }
      }
      if (!locator && ref) {
        locator = page.locator(ref);
      }

      if (!locator) {
        return res.status(400).json({ error: `Could not resolve element: ${ref}` });
      }

      await locator.setInputFiles(filePath, { timeout: 10000 });

      ctx.events.emit('helper:upload_file', { userId, tabId, ref, filePath });
      res.json({ ok: true, filePath });
    } catch (err) {
      ctx.log('error', 'upload_file failed', { error: err.message });
      res.status(500).json({ error: ctx.safeError(err) });
    }
  });
}