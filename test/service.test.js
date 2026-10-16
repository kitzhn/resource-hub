import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadCatalog, search, toVod, validateCatalog } from '../src/catalog.js';
import { createApp, getConfig } from '../src/server.js';

const demoPath = new URL('../examples/catalog.demo.json', import.meta.url);
const source = JSON.parse(await readFile(demoPath, 'utf8'));
const resources = validateCatalog(structuredClone(source));
const TOKEN = 'test-only-token-with-more-than-32-characters';
const settings = overrides => ({ token: TOKEN, allowedIps: [], requestsPerMinute: 500, ...overrides });

async function serve(t, options = {}) {
  const server = createApp(resources, settings(options));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, init = {}) => fetch(base + path, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers } });
}

test('catalog loads all three resource types', async () => {
  assert.deepEqual((await loadCatalog(demoPath)).map(item => item.kind).sort(), ['comic', 'torrent', 'vod']);
});

test('search supports Chinese, case normalization, filters and stable pagination', () => {
  assert.equal(search(resources, { q: '漫画' }).items[0].kind, 'comic');
  assert.equal(search(resources, { q: 'ＤＥＭＯ', kind: 'torrent' }).items.length, 1);
  const first = search(resources, { q: 'demo', limit: 2 });
  const last = search(resources, { q: 'demo', limit: 2, offset: Number(first.nextCursor) });
  assert.equal(first.total, 3);
  assert.equal(last.nextCursor, null);
  assert.equal(new Set([...first.items, ...last.items].map(item => item.id)).size, 3);
});

test('invalid catalogs fail before the server starts', async t => {
  const mutations = [
    ['duplicate IDs', catalog => catalog.resources.push(catalog.resources[0])],
    ['numeric ID', catalog => { catalog.resources[0].id = 123; }],
    ['unknown type', catalog => { catalog.resources[0].kind = 'other'; }],
    ['missing provenance', catalog => { delete catalog.resources[0].sourceUrl; }],
    ['invalid timestamp', catalog => { catalog.resources[0].fetchedAt = 'yesterday'; }],
    ['unclassified rights', catalog => { catalog.resources[0].rightsStatus = 'free'; }],
    ['empty episodes', catalog => { catalog.resources[0].episodes = []; }],
    ['unsafe URL scheme', catalog => { catalog.resources[0].episodes[0].url = 'javascript:alert(1)'; }],
    ['embedded credentials', catalog => { catalog.resources[0].episodes[0].url = 'https://user:secret@example.invalid/x.m3u8'; }],
    ['VOD delimiter injection', catalog => { catalog.resources[0].episodes[0].title = 'extra#episode'; }],
    ['wrong magnet hash', catalog => { catalog.resources[1].infohashV1 = 'a'.repeat(40); }],
    ['invalid comic pages', catalog => { catalog.resources[2].chapters[0].pages = ['file:///private']; }],
  ];
  for (const [label, change] of mutations) await t.test(label, () => {
    const catalog = structuredClone(source); change(catalog);
    assert.throws(() => validateCatalog(catalog));
  });
});

test('VOD adapter preserves signed HLS URLs and skips unsupported playback formats', () => {
  const vod = structuredClone(resources.find(item => item.kind === 'vod'));
  vod.episodes = [{ title: '第1集', url: 'https://example.invalid/video.m3u8?token=a%2Fb&expires=9' }];
  assert.equal(toVod(vod).vod_play_url, `第1集$${vod.episodes[0].url}`);
  vod.episodes[0].url = 'https://example.invalid/video.mp4';
  assert.equal(toVod(vod), null);
});

test('configuration fails closed for missing or placeholder tokens and bad ports', () => {
  for (const env of [{}, { API_TOKEN: 'short' }, { API_TOKEN: 'replace-with-a-random-token-at-least-32-characters' }, { API_TOKEN: TOKEN, PORT: '-1' }]) assert.throws(() => getConfig(env));
  assert.equal(getConfig({ API_TOKEN: TOKEN }).host, '127.0.0.1');
  assert.deepEqual(getConfig({ API_TOKEN: TOKEN }).allowedIps, []);
});

test('health is public but all data endpoints require a valid Bearer token', async t => {
  const request = await serve(t);
  assert.equal((await request('/v1/health', { headers: { Authorization: '' } })).status, 200);
  for (const path of ['/v1/search?q=demo', '/v1/resources/demo-comic', '/compat/vod?ac=videolist&wd=demo']) {
    assert.equal((await request(path, { headers: { Authorization: '' } })).status, 401);
    assert.equal((await request(path, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  }
});

test('search and resource endpoints return real HTTP responses with private cache headers', async t => {
  const request = await serve(t);
  const response = await request('/v1/search?q=demo&kind=torrent');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal((await response.json()).items[0].id, 'demo-torrent');
  const comic = await (await request('/v1/resources/demo-comic/chapters')).json();
  assert.equal(comic.items.length, 1);
  const vod = await (await request('/v1/resources/demo-documentary/episodes')).json();
  assert.equal(vod.items.length, 1);
  assert.equal((await request('/v1/resources/demo-comic/episodes')).status, 404);
  assert.equal((await request('/v1/resources/absent')).status, 404);
});

test('invalid queries, pagination and methods are rejected', async t => {
  const request = await serve(t);
  for (const path of ['/v1/search', '/v1/search?q=x&kind=other', '/v1/search?q=x&cursor=-1', '/v1/search?q=x&limit=101', '/v1/search?q=x&limit=', '/compat/vod?ac=other', '/compat/vod?ac=videolist&wd=x&pg=0']) assert.equal((await request(path)).status, 400, path);
  assert.equal((await request('/v1/search?q=x', { method: 'POST' })).status, 405);
  assert.equal((await request('/unknown')).status, 404);
});

test('LunaTV VOD search/detail exports only playable VOD records', async t => {
  const request = await serve(t);
  const found = await (await request('/compat/vod?ac=videolist&wd=demo&pg=1')).json();
  assert.equal(found.code, 1);
  assert.equal(found.total, 1);
  assert.equal(found.list[0].vod_id, 'demo-documentary');
  assert.match(found.list[0].vod_play_url, /\$https:\/\/example\.invalid\/demo\.m3u8$/);
  const detail = await (await request('/compat/vod?ac=videolist&ids=demo-documentary')).json();
  assert.deepEqual(detail.list, found.list);
  const torrent = await (await request('/compat/vod?ac=videolist&ids=demo-torrent')).json();
  assert.deepEqual(torrent.list, []);
});

test('only explicitly trusted socket peers can bypass auth on the compatibility route', async t => {
  const request = await serve(t, { allowedIps: ['127.0.0.1'] });
  assert.equal((await request('/compat/vod?ac=videolist&wd=demo', { headers: { Authorization: '' } })).status, 200);
  assert.equal((await request('/v1/search?q=demo', { headers: { Authorization: '' } })).status, 401);
});

test('forwarded IP headers never grant compatibility access', async t => {
  const request = await serve(t, { allowedIps: ['192.0.2.5'] });
  const response = await request('/compat/vod?ac=videolist&wd=demo', { headers: { Authorization: '', 'X-Forwarded-For': '192.0.2.5', 'X-Real-IP': '192.0.2.5' } });
  assert.equal(response.status, 401);
});

test('rate limiting applies before authentication', async t => {
  const request = await serve(t, { requestsPerMinute: 2 });
  assert.equal((await request('/v1/health')).status, 200);
  assert.equal((await request('/v1/health')).status, 200);
  const response = await request('/v1/health');
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) >= 1);
});
