/**
 * Test helper - scrape_table
 * Extracts tabular data from a page.
 * 
 * LLM description: Scrape an HTML table from the current page and return
 * the data as structured JSON with headers and rows.
 */

export const name = 'scrape_table';
export const description = 'Extract HTML table data from the current page as JSON with headers and rows.';

export async function register(app, ctx) {
  /**
   * POST /helpers/scrape_table
   * Scrape table data from the current page.
   * 
   * Body: { userId, tabId, selector? }
   *   userId   - User session ID
   *   tabId    - Tab ID
   *   selector - Optional CSS selector (defaults to first table)
   * 
   * Returns: { ok: true, headers: string[], rows: string[][] }
   */
  app.post('/helpers/scrape_table', async (req, res) => {
    try {
      const { userId, tabId, selector } = req.body;
      if (!userId) return res.status(400).json({ error: 'userId required' });
      if (!tabId) return res.status(400).json({ error: 'tabId required' });

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

      const { page } = foundTab;
      page.toolCalls++; page.consecutiveTimeouts = 0;

      const tableData = await page.evaluate((sel) => {
        const table = sel ? document.querySelector(sel) : document.querySelector('table');
        if (!table) return null;

        const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim());
        const rows = Array.from(table.querySelectorAll('tr')).slice(headers.length ? 1 : 0).map(tr =>
          Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim())
        );

        return { headers, rows };
      }, selector || null);

      if (!tableData) {
        return res.status(404).json({ error: 'No table found on page' });
      }

      ctx.events.emit('helper:scrape_table', { userId, tabId, selector, rowCount: tableData.rows.length });
      res.json({ ok: true, ...tableData });
    } catch (err) {
      ctx.log('error', 'scrape_table failed', { error: err.message });
      res.status(500).json({ error: ctx.safeError(err) });
    }
  });
}