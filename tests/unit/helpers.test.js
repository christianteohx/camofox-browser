/**
 * Unit tests for lib/helpers.js - self-healing helpers system.
 * 
 * Note: File-based tests (loadHelpers) are tested via integration-style
 * tests that use unique temp directories per test to avoid ESM caching.
 */

import { describe, test, expect } from '@jest/globals';
import { registerHelpers } from '../../lib/helpers.js';

describe('helpers.js', () => {
  describe('registerHelpers', () => {
    test('should register all helpers with Express app', async () => {
      const routes = [];
      const app = {
        post: (path, handler) => routes.push({ method: 'POST', path }),
        get: (path, handler) => routes.push({ method: 'GET', path }),
      };

      const ctx = {
        getSession: async () => ({}),
        events: { emit: () => {} },
        log: () => {},
        safeError: (err) => err.message,
      };

      // Create mock helper objects directly
      const mockHelpers = [
        {
          name: 'reg_one',
          file: 'reg_one.js',
          description: 'Helper one',
          register: async (app, ctx) => {
            app.get('/helpers/one', (req, res) => res.json({ ok: true }));
          }
        },
        {
          name: 'reg_two',
          file: 'reg_two.js',
          description: 'Helper two',
          register: async (app, ctx) => {
            app.post('/helpers/two', (req, res) => res.json({ ok: true }));
          }
        }
      ];

      const registered = await registerHelpers(mockHelpers, app, ctx);

      expect(registered).toHaveLength(2);
      expect(registered.map(h => h.name)).toContain('reg_one');
      expect(registered.map(h => h.name)).toContain('reg_two');
      expect(routes.map(r => `${r.method} ${r.path}`)).toEqual([
        'GET /helpers/one',
        'POST /helpers/two',
      ]);
    });

    test('should skip helpers that throw during registration', async () => {
      const routes = [];
      const app = {
        post: (path, handler) => routes.push({ path }),
        get: (path, handler) => routes.push({ path }),
      };

      let logCall = null;
      const ctx = {
        getSession: async () => ({}),
        events: { emit: () => {} },
        log: (level, msg, fields) => { logCall = { level, msg, fields }; },
        safeError: (err) => err.message,
      };

      // Create mock helpers - one good, one bad
      const mockHelpers = [
        {
          name: 'good',
          file: 'good.js',
          description: 'Good helper',
          register: async (app, ctx) => {
            app.get('/good', (req, res) => res.json({ ok: true }));
          }
        },
        {
          name: 'bad',
          file: 'bad.js',
          description: 'Bad helper',
          register: async (app, ctx) => {
            throw new Error('Intentional failure');
          }
        }
      ];

      const registered = await registerHelpers(mockHelpers, app, ctx);

      // Good helper should be registered, bad should be skipped
      expect(registered).toHaveLength(1);
      expect(registered[0].name).toBe('good');
      expect(routes).toHaveLength(1);
      expect(logCall.msg).toBe('helper registration failed, skipping');
      expect(logCall.fields.file).toBe('bad.js');
    });

    test('should pass plugin context to helpers', async () => {
      const routes = [];
      const app = {
        get: (path, handler) => { routes.push({ path, handler }); },
      };

      const ctx = {
        getSession: async () => ({}),
        events: { emit: () => {} },
        log: () => {},
        safeError: (err) => err.message,
      };

      // Create a helper that verifies context
      const mockHelpers = [
        {
          name: 'ctx_test',
          file: 'ctx_test.js',
          description: 'Context test helper',
          register: async (app, helperCtx) => {
            app.get('/ctx/test', (req, res) => {
              res.json({
                hasGetSession: typeof helperCtx.getSession === 'function',
                hasEvents: typeof helperCtx.events === 'object',
                hasLog: typeof helperCtx.log === 'function',
              });
            });
          }
        }
      ];

      const registered = await registerHelpers(mockHelpers, app, ctx);

      expect(registered).toHaveLength(1);
      expect(routes).toHaveLength(1);

      // Test the handler uses context correctly
      const mockReq = {};
      const mockRes = {
        json: (data) => {
          expect(data.hasGetSession).toBe(true);
          expect(data.hasEvents).toBe(true);
          expect(data.hasLog).toBe(true);
        }
      };
      routes[0].handler(mockReq, mockRes);
    });

    test('should handle empty helpers array', async () => {
      const routes = [];
      const app = {
        get: (path, handler) => routes.push({ path }),
      };

      const ctx = {
        getSession: async () => ({}),
        events: { emit: () => {} },
        log: () => {},
        safeError: (err) => err.message,
      };

      const registered = await registerHelpers([], app, ctx);
      expect(registered).toHaveLength(0);
      expect(routes).toHaveLength(0);
    });

    test('should handle helper with empty name', async () => {
      const routes = [];
      const app = {
        get: (path, handler) => routes.push({ path }),
      };

      const ctx = {
        getSession: async () => ({}),
        events: { emit: () => {} },
        log: () => {},
        safeError: (err) => err.message,
      };

      const mockHelpers = [
        {
          name: '',
          file: 'empty_name.js',
          description: 'Empty name helper',
          register: async (app, ctx) => {
            app.get('/empty', (req, res) => res.json({ ok: true }));
          }
        }
      ];

      const registered = await registerHelpers(mockHelpers, app, ctx);
      expect(registered).toHaveLength(1);
      expect(registered[0].name).toBe('');
    });
  });
});