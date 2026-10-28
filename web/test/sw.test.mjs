// Offline mode's service worker (web/src/sw.ts) with a fake cache and network (no Chrome): one start uses one set of
// files.  A player's start on 2026-10-25 had the page's script from a copy (yesterday's) and /game.json, so the module,
// from the server (today's): its renderer refused the game's graphics ("GPU control block mismatch").
//   node --test web/test/sw.test.mjs
// The service worker in a real Chrome, with a server that goes and comes back: web/tools/offline-test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'https://nfsu2.test';

// ---- the service worker's world: self, caches, fetch ------------------------
const on = {};
globalThis.self = { location: { origin: ORIGIN }, addEventListener: (t, f) => { on[t] = f; }, skipWaiting: async () => {}, clients: { claim: async () => {} } };
const keyOf = k => { const u = new URL(typeof k === 'string' ? k : k.url, ORIGIN); return u.pathname + u.search; };
const copies = new Map();
const cache = {
  match: async k => copies.get(keyOf(k))?.clone(),
  put: async (k, r) => { copies.set(keyOf(k), r); },
  keys: async () => [...copies.keys()].map(k => ({ url: ORIGIN + k })),
  delete: async k => copies.delete(keyOf(k)),
};
globalThis.caches = { open: async () => cache, keys: async () => [], delete: async () => true };
/** the server: path -> [status, body, ms before the answer] (anything else: 404 at once) */
let server = {};
globalThis.fetch = async q => {
  const [status, body, ms] = server[keyOf(q)] ?? [404, 'Not found', 0];
  if (ms) await new Promise(r => setTimeout(r, ms));
  const r = new Response(body, { status, headers: { etag: `"${body.length}"` } });
  Object.defineProperty(r, 'type', { value: 'basic' });
  return r;
};

const js = (await esbuild.build({ entryPoints: [path.join(ROOT, 'web/src/sw.ts')], bundle: true, format: 'esm', write: false })).outputFiles[0].text;
await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

/** one request of the page, as the service worker answers it: its body */
async function get(p, mode = 'cors') {
  let answer = null;
  on.fetch({ request: { method: 'GET', headers: new Headers(), url: ORIGIN + p, mode }, respondWith: r => { answer = r; }, waitUntil: () => {} });
  assert.ok(answer, `${p} is the service worker's`);
  return (await answer).text();
}
const online = () => new Promise(res => on.message({ data: 'online', ports: [{ postMessage: res }] }));

test('a copy answered for one file: the files after it in that start are copies too, until the page says online', async () => {
  for (const [k, v] of Object.entries({ '/': 'page 1', '/main.js': 'script 1', '/main.css': 'style 1', '/game.json': '{"rev":"1"}' }))
    copies.set(k, new Response(v, { headers: { etag: `"old-${k}"` } }));
  // a new version on the server, whose script fails once (a 5xx from the proxy in front) while the stylesheet,
  // asked at the same time, answers a little later
  server = { '/': [200, 'page 2', 0], '/main.js': [502, 'Bad gateway', 0], '/main.css': [200, 'style 2', 20], '/game.json': [200, '{"rev":"2"}', 0] };
  assert.equal(await get('/', 'navigate'), 'page 2');
  const [script, style] = await Promise.all([get('/main.js'), get('/main.css')]);
  assert.equal(script, 'script 1', 'the script from its copy');
  assert.equal(style, 'style 2', 'the stylesheet was on its way already');
  assert.equal(await get('/game.json'), '{"rev":"1"}', 'the list of the module the copied script goes with, not the server\'s');
  // a reload for the server's version (shell.ts reload): from the server again
  await online();
  assert.equal(await get('/game.json'), '{"rev":"2"}');
});
