const crypto = require("crypto");
const FileSystemCache =
  require("next/dist/server/lib/incremental-cache/file-system-cache").default;

const MAX_KEY_LENGTH = 200;
const HASH_LENGTH = 32;

const shortenKey = (key) => {
  if (typeof key !== "string" || key.length <= MAX_KEY_LENGTH) return key;
  const digest = crypto
    .createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  const head = key.slice(0, MAX_KEY_LENGTH - HASH_LENGTH - 1);
  return `${head}-${digest}`;
};

/**
 * Bounded ISR cache.
 *
 * Next's FileSystemCache never removes anything from disk: it has no unlink,
 * no cap, and expiry only makes `get()` return null so the page re-renders and
 * overwrites. The only LRU it has is in memory, and `cacheMaxMemorySize: 0` in
 * next.config.mjs disables that. Meanwhile the content routes have one URL per
 * nostr event, address or pubkey, so every distinct URL a crawler visits adds a
 * permanent `.html` + `.json` pair.
 *
 * Measured in production: 36,121 HTML files / 400 MB accumulated in ~2 hours,
 * inside a /var/lib/docker/overlay2 that had reached 26 GB -- roughly 4.8 GB a
 * day, unbounded. Measured locally: exactly 2.00 files per distinct-URL request.
 *
 * Simply not caching these routes would bound the disk but send every request
 * back to the relays, which is the cost the cache exists to avoid. So instead of
 * removing the cache, this bounds it: entries are still written and still
 * served, but once the cache exceeds its limit the oldest entries are deleted.
 * Disk becomes a flat line at the cap instead of a ramp, and repeat requests
 * still hit the cache rather than the relay pool.
 *
 * Tunable without a code change:
 *   ISR_CACHE_MAX_BYTES    default 2 GB
 *   ISR_CACHE_MAX_ENTRIES  default 50,000 (backstop; entry sizes vary widely,
 *                          from ~2 KB for an unresolved page to 134 KB for a
 *                          profile carrying a full following list)
 */
const fs = require("fs");
const path = require("path");

/**
 * Only these routes are bounded. Their URL space is one entry per nostr event,
 * address or pubkey, so it is effectively infinite. Everything else -- statically
 * prerendered pages, finite routes -- is left alone: those files are build output
 * whose deletion would 404 the route until the next build.
 */
const EVICTABLE_ROUTES = [
  "note/",
  "profile/",
  "article/",
  "video/",
  "image/",
  "curation/",
];

const isEvictable = (key) => {
  if (typeof key !== "string") return false;
  const k = key.replace(/^\//, "");
  return EVICTABLE_ROUTES.some((prefix) => k.startsWith(prefix));
};

const MAX_BYTES = Number(process.env.ISR_CACHE_MAX_BYTES || 2 * 1024 * 1024 * 1024);
const MAX_ENTRIES = Number(process.env.ISR_CACHE_MAX_ENTRIES || 50000);

// Process-wide, not per-instance: Next may construct more than one handler.
const store = (globalThis.__yakiIsrCache ??= {
  // Insertion-ordered: Map preserves insertion order, so eviction walks keys
  // from the front and needs no sorting.
  entries: new Map(), // shortKey -> { bytes, files: string[] }
  totalBytes: 0,
  seeded: false,
});

const statSize = (file) => {
  try {
    return fs.statSync(file).size;
  } catch (err) {
    return 0;
  }
};

module.exports = class YakiCacheHandler extends FileSystemCache {
  /** Paths written for one cache entry: the HTML and its page-data JSON. */
  entryFiles(shortKey) {
    try {
      const html = this.getFilePath(`${shortKey}.html`, "PAGES");
      return [html, html.replace(/\.html$/, ".json")];
    } catch (err) {
      return [];
    }
  }

  /**
   * Adopt whatever is already on disk from previous runs, once, so a restart
   * does not start counting from zero against a cache that is already large.
   * Walks the pages dir a single time; all later accounting is incremental.
   */
  seed() {
    if (store.seeded) return;
    store.seeded = true;
    let root;
    try {
      root = this.getFilePath("x.html", "PAGES").replace(/x\.html$/, "");
    } catch (err) {
      return;
    }
    const walk = (dir) => {
      let items;
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        return;
      }
      for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          walk(full);
          continue;
        }
        if (!item.name.endsWith(".html")) continue;
        const json = full.replace(/\.html$/, ".json");
        const key = full.slice(root.length).replace(/\.html$/, "");
        // Statically prerendered pages (index, terms, ...) live in the same
        // directory but are build output, not regenerable cache: deleting one
        // would 404 that route until the next build. Only adopt entries under
        // the dynamic content routes.
        if (!isEvictable(key)) continue;
        const bytes = statSize(full) + statSize(json);
        store.entries.set(key, { bytes, files: [full, json] });
        store.totalBytes += bytes;
      }
    };
    walk(root);
  }

  /** Delete oldest entries until the cache is back inside both limits. */
  evict() {
    for (const [key, entry] of store.entries) {
      if (store.totalBytes <= MAX_BYTES && store.entries.size <= MAX_ENTRIES) return;
      for (const file of entry.files) {
        // Two workers can race on the same file; a failed unlink is harmless.
        try {
          fs.unlinkSync(file);
        } catch (err) {}
      }
      store.entries.delete(key);
      store.totalBytes -= entry.bytes;
    }
  }

  get(key, ...rest) {
    return super.get(shortenKey(key), ...rest);
  }

  async set(key, data, ctx) {
    const shortKey = shortenKey(key);
    const result = await super.set(shortKey, data, ctx);

    // Only PAGES entries land in the pages dir as html+json; leave anything
    // else (fetch cache, app router, images) to Next.
    if (!data || data.kind !== "PAGES") return result;
    if (!isEvictable(key)) return result;

    try {
      this.seed();
      const files = this.entryFiles(shortKey);
      if (files.length === 0) return result;
      const bytes = files.reduce((n, f) => n + statSize(f), 0);

      // Re-inserting moves the key to the back, so a refreshed entry counts as
      // recently used rather than being evicted on age alone.
      const existing = store.entries.get(shortKey);
      if (existing) store.totalBytes -= existing.bytes;
      store.entries.delete(shortKey);
      store.entries.set(shortKey, { bytes, files });
      store.totalBytes += bytes;

      if (store.totalBytes > MAX_BYTES || store.entries.size > MAX_ENTRIES) {
        this.evict();
      }
    } catch (err) {
      // Accounting must never break a page render.
    }
    return result;
  }
};
