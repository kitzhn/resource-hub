import { readFile, stat } from 'node:fs/promises';

export const KINDS = ['vod', 'torrent', 'comic'];
const RIGHTS = ['authorized', 'open-license', 'public-domain', 'unverified', 'demo'];
const ID = /^[A-Za-z0-9_-]{1,80}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function text(value, max = 500) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function webUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

function validateEpisode(episode) {
  return episode && text(episode.title, 200) && webUrl(episode.url) &&
    !episode.title.includes('$') && !episode.title.includes('#') &&
    !episode.url.includes('$') && !episode.url.includes('#');
}

export function validateCatalog(input) {
  requireValue(input?.version === 1 && Array.isArray(input.resources), 'Catalog must have version: 1 and resources: []');
  requireValue(input.resources.length <= 10000, 'Catalog exceeds 10000 resources');
  const ids = new Set();
  for (const item of input.resources) {
    requireValue(item && typeof item.id === 'string' && ID.test(item.id) && !ids.has(item.id), 'Invalid or duplicate resource id');
    ids.add(item.id);
    requireValue(KINDS.includes(item.kind), `Invalid kind: ${item.id}`);
    requireValue(text(item.title, 300) && text(item.sourceId, 80), `Missing title or sourceId: ${item.id}`);
    requireValue(webUrl(item.sourceUrl) && RIGHTS.includes(item.rightsStatus), `Invalid source or rightsStatus: ${item.id}`);
    requireValue(typeof item.fetchedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(item.fetchedAt) && Number.isFinite(Date.parse(item.fetchedAt)), `Invalid fetchedAt: ${item.id}`);
    requireValue(item.tags === undefined || (Array.isArray(item.tags) && item.tags.length <= 30 && item.tags.every(tag => text(tag, 80))), `Invalid tags: ${item.id}`);
    requireValue(item.poster === undefined || webUrl(item.poster), `Invalid poster: ${item.id}`);
    requireValue(item.year === undefined || (typeof item.year === 'string' && /^\d{4}$/.test(item.year)), `Invalid year: ${item.id}`);
    if (item.kind === 'vod') {
      requireValue(Array.isArray(item.episodes) && item.episodes.length > 0 && item.episodes.length <= 1000 && item.episodes.every(validateEpisode), `Invalid episodes: ${item.id}`);
    } else if (item.kind === 'torrent') {
      requireValue(typeof item.infohashV1 === 'string' && /^[a-fA-F0-9]{40}$/.test(item.infohashV1), `Expected v1 hexadecimal infohash: ${item.id}`);
      let magnet;
      try { magnet = new URL(item.magnet); } catch { /* validated below */ }
      const expected = `urn:btih:${item.infohashV1.toLowerCase()}`;
      requireValue(magnet?.protocol === 'magnet:' && magnet.searchParams.getAll('xt').some(xt => xt.toLowerCase() === expected), `Magnet and infohash disagree: ${item.id}`);
      requireValue(item.sizeBytes === undefined || (Number.isSafeInteger(item.sizeBytes) && item.sizeBytes >= 0), `Invalid sizeBytes: ${item.id}`);
      requireValue(item.resolution === undefined || text(item.resolution, 40), `Invalid resolution: ${item.id}`);
      requireValue(item.resolutionVerified === undefined || typeof item.resolutionVerified === 'boolean', `Invalid resolutionVerified: ${item.id}`);
    } else {
      requireValue(Array.isArray(item.chapters) && item.chapters.length <= 1000 && item.chapters.every(chapter => chapter && text(chapter.title, 200) && Array.isArray(chapter.pages) && chapter.pages.length <= 1000 && chapter.pages.every(webUrl)), `Invalid chapters: ${item.id}`);
    }
  }
  return input.resources;
}

export async function loadCatalog(path) {
  const file = await stat(path);
  requireValue(file.size <= 10 * 1024 * 1024, 'Catalog exceeds 10 MiB');
  return validateCatalog(JSON.parse(await readFile(path, 'utf8')));
}

export function search(resources, { q, kind, offset = 0, limit = 20 }) {
  const words = q.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u);
  const matches = resources.filter(item => {
    if (kind && item.kind !== kind) return false;
    const haystack = [item.title, ...(item.tags || [])].join(' ').normalize('NFKC').toLocaleLowerCase();
    return words.every(word => haystack.includes(word));
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    items: matches.slice(offset, offset + limit), total: matches.length,
    nextCursor: offset + limit < matches.length ? String(offset + limit) : null,
  };
}

export function toVod(item) {
  const episodes = item.episodes.filter(episode => new URL(episode.url).pathname.toLowerCase().endsWith('.m3u8'));
  if (!episodes.length) return null;
  return {
    vod_id: item.id, vod_name: item.title, vod_pic: item.poster || '',
    vod_year: item.year || '', type_name: '影视', vod_content: '',
    vod_play_from: 'resource-hub', vod_play_url: episodes.map(episode => `${episode.title}$${episode.url}`).join('#'),
  };
}
