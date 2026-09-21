import { ndkInstance } from "@/Helpers/NDKInstance";
import {
  getEventFromCache,
  setEventFromCache,
} from "@/Helpers/utils/eventsCache";

/**
 * Coalesces the per-mention relay lookups made by Nip19Parsing.
 *
 * A long article can hold a hundred mentions. Left alone, each one opens its
 * own REQ, so the client sends hundreds of subscriptions for a few dozen
 * distinct authors and events. This module collects requests raised in the
 * same tick, de-duplicates them, and issues a handful of batched REQs instead.
 *
 * Guarantees relied on by callers:
 *   - a resolver is invoked at most once per subscriber;
 *   - a subscriber that unmounts before its batch resolves is dropped, so no
 *     state is written to a dead component;
 *   - every batch is torn down on EOSE or on a timeout, so no subscription is
 *     left open (see the NDKRelaySubscription retention issue fixed earlier).
 */

// Collect everything raised within this window into one batch. One frame is
// enough to catch a whole article's mentions, which all mount together.
const BATCH_WINDOW_MS = 60;

// Relays reject or truncate very large filters, so cap each REQ.
const MAX_KEYS_PER_FILTER = 200;

// Give up on a batch after this long and let subscribers fall back.
const BATCH_TIMEOUT_MS = 6000;

// pending: cacheKey -> { kind, key, relays:Set, subscribers:Set<fn> }
let pending = new Map();
let flushTimer = null;

function cacheKeyFor(kind, key) {
  return `${kind}:${key}`;
}

/**
 * Registers interest in an author (kind 0) or an event id.
 *
 * @param {"author"|"id"} kind
 * @param {string} key   pubkey (hex) or event id (hex)
 * @param {string[]} relays  optional relay hints from the bech32 address
 * @param {(event:object)=>void} onEvent  called once with the raw event
 * @returns {() => void} unsubscribe
 */
export function requestEntity(kind, key, relays, onEvent) {
  if (!key) return () => {};

  const cacheKey = cacheKeyFor(kind, key);
  let entry = pending.get(cacheKey);
  if (!entry) {
    entry = { kind, key, relays: new Set(), subscribers: new Set() };
    pending.set(cacheKey, entry);
  }
  (relays || []).forEach((r) => entry.relays.add(r));
  entry.subscribers.add(onEvent);

  if (!flushTimer) {
    flushTimer = setTimeout(flush, BATCH_WINDOW_MS);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.subscribers.delete(onEvent);
    // Leave the entry in place if the batch already went out; an in-flight
    // REQ with no remaining subscribers simply resolves into the cache.
    if (entry.subscribers.size === 0 && pending.get(cacheKey) === entry) {
      pending.delete(cacheKey);
    }
  };
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function flush() {
  flushTimer = null;
  const batch = pending;
  pending = new Map();
  if (batch.size === 0) return;

  const authors = [];
  const ids = [];
  const relayHints = new Set();

  for (const entry of batch.values()) {
    if (entry.subscribers.size === 0) continue;
    if (entry.kind === "author") authors.push(entry.key);
    else ids.push(entry.key);
    entry.relays.forEach((r) => relayHints.add(r));
  }
  if (authors.length === 0 && ids.length === 0) return;

  const filters = [];
  chunk(authors, MAX_KEYS_PER_FILTER).forEach((slice) =>
    filters.push({ kinds: [0], authors: slice }),
  );
  chunk(ids, MAX_KEYS_PER_FILTER).forEach((slice) =>
    filters.push({ ids: slice }),
  );
  if (filters.length === 0) return;

  const relayUrls = relayHints.size
    ? [...new Set([...ndkInstance.explicitRelayUrls, ...relayHints])]
    : ndkInstance.explicitRelayUrls;

  const sub = ndkInstance.subscribe(filters, {
    cacheUsage: "CACHE_FIRST",
    groupable: false,
    subId: "nip19-batch",
    closeOnEose: true,
    relayUrls,
  });

  let settled = false;
  const stop = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // Always tear the subscription down: a relay that never sends EOSE would
    // otherwise keep it, and its relay-side state, alive for the session.
    try {
      sub.stop();
    } catch {
      /* already stopped */
    }
  };

  const timer = setTimeout(stop, BATCH_TIMEOUT_MS);

  sub.on("event", (event) => {
    if (!event?.id) return;

    const byId = batch.get(cacheKeyFor("id", event.id));
    const byAuthor =
      event.kind === 0 ? batch.get(cacheKeyFor("author", event.pubkey)) : null;

    // Subscribers receive the NDKEvent untouched: Nip19Parsing calls
    // event.rawEvent() on it, so a plain object would break parsing.
    [byId, byAuthor].forEach((entry) => {
      if (!entry) return;
      entry.subscribers.forEach((fn) => {
        try {
          fn(event);
        } catch (err) {
          console.log(err);
        }
      });
      entry.subscribers.clear();
    });

    // Cache even when nothing is waiting, so a later mention resolves for free.
    if (!byId && !byAuthor) {
      try {
        const raw =
          typeof event.rawEvent === "function" ? event.rawEvent() : event;
        setEventFromCache(event.kind === 0 ? event.pubkey : event.id, raw);
      } catch (err) {
        console.log(err);
      }
    }
  });

  sub.on("eose", stop);
}

/**
 * Synchronous cache probe, so a mention that was already fetched on this page
 * renders without touching the network at all.
 */
export function peekEntity(kind, key) {
  if (!key) return null;
  return getEventFromCache(key);
}
