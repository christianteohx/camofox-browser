/**
 * Self-healing helpers system for camofox-browser.
 *
 * Allows agents to write custom helper .js files at runtime.
 * Helpers are auto-discovered and registered on server startup.
 * Bad helpers (syntax errors, missing exports) are skipped gracefully.
 *
 * Directory structure:
 *   ~/.camofox/helpers/          (default, user-level)
 *   ./helpers/                   (default, project-level)
 *   or CAMOFOX_HELPERS_DIR env override
 *
 * Each helper file exports:
 *   register(app, ctx)           - Express app + plugin context
 *   // optional:
 *   export const name = 'xxx'
 *   export const description = 'LLM-friendly description'
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { pathToFileURL } from 'url';

/**
 * Load and validate a single helper file.
 * Returns null if the file cannot be loaded (syntax error, missing export, etc.)
 */
async function loadHelper(filePath, log) {
  try {
    // Try to read the file first to check for obvious syntax issues
    const code = readFileSync(filePath, 'utf-8');

    // Import dynamically
    const fileUrl = pathToFileURL(filePath).href;
    const mod = await import(fileUrl).catch(err => {
      // Provide better error context for import failures
      const newErr = new Error(`Failed to import helper "${basename(filePath)}": ${err.message}`);
      newErr.cause = err;
      throw newErr;
    });

    const register = mod.register || mod.default;
    if (typeof register !== 'function') {
      log('warn', 'helper skipped (no register function)', { file: basename(filePath) });
      return null;
    }

    return {
      name: mod.name || basename(filePath, '.js'),
      description: mod.description || '',
      file: basename(filePath),
      register,
      rawCode: code,
    };
  } catch (err) {
    // Syntax errors, import errors, etc — skip this helper
    log('warn', 'helper skipped (load error)', {
      file: basename(filePath),
      error: err.message,
    });
    return null;
  }
}

/**
 * Discover and load all helpers from a directory.
 * Returns array of loaded helpers (skipping bad ones).
 */
export async function loadHelpers(helpersDir, log) {
  const loaded = [];

  if (!helpersDir) {
    log('info', 'helpers: no directory configured, skipping');
    return loaded;
  }

  if (!existsSync(helpersDir)) {
    log('info', 'helpers: directory does not exist, skipping', { dir: helpersDir });
    return loaded;
  }

  let files;
  try {
    files = readdirSync(helpersDir).filter(f => f.endsWith('.js') && !f.startsWith('_') && !f.startsWith('.'));
  } catch (err) {
    log('warn', 'helpers: failed to read directory', { dir: helpersDir, error: err.message });
    return loaded;
  }

  if (files.length === 0) {
    log('info', 'helpers: no helper files found', { dir: helpersDir });
    return loaded;
  }

  log('info', 'helpers: discovering helpers', { dir: helpersDir, fileCount: files.length });

  for (const file of files) {
    const filePath = join(helpersDir, file);
    const helper = await loadHelper(filePath, log);
    if (helper) {
      loaded.push(helper);
      log('info', 'helpers: loaded', { file, name: helper.name, description: helper.description });
    }
  }

  return loaded;
}

/**
 * Register all helpers with the Express app and plugin context.
 */
export async function registerHelpers(helpers, app, ctx) {
  const registered = [];

  for (const helper of helpers) {
    try {
      await helper.register(app, ctx);
      registered.push({
        name: helper.name,
        file: helper.file,
        description: helper.description,
      });
    } catch (err) {
      ctx.log('warn', 'helper registration failed, skipping', {
        file: helper.file,
        name: helper.name,
        error: err.message,
      });
    }
  }

  return registered;
}