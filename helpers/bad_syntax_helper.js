/**
 * Bad helper - this has a syntax error and should be skipped gracefully.
 * 
 * LLM description: A helper with broken syntax.
 */

export const name = 'bad_helper';
export const description = 'This helper will be skipped due to syntax errors.';

export async function register(app, ctx) {
  // This is a valid helper
  app.get('/helpers/bad_helper', (req, res) => {
    res.json({ ok: true });
  });
}

// Force a syntax error that will be caught
const x = {
  bad: syntax error here
};