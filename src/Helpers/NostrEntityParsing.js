import { nip19 } from "nostr-tools";

/**
 * Single source of truth for detecting nostr bech32 entities in user text.
 *
 * Both renderers of article content consume this module so that the TipTap
 * editor preview (WriteArticle) and the published article page (ArticlePreview)
 * recognise exactly the same set of mentions:
 *   - src/Extensions/NostrEntityExtension.js + MentionExtension.js  (editor)
 *   - src/Helpers/remarkNostrEntities.js                            (article)
 */

const ENTITY_BODY = "(?:npub|nprofile|nevent|note|naddr)1[a-z0-9]+";

// An entity anywhere in running text. The "nostr:" prefix and a leading "@"
// are both optional, matching how authors actually write mentions.
export const ENTITY_RE = new RegExp(`@?(?:nostr:)?(${ENTITY_BODY})`, "gi");

// An entity that makes up a whole token on its own.
export const ENTITY_ONLY_RE = new RegExp(`^@?(?:nostr:)?(${ENTITY_BODY})$`, "i");

const TRAILING_PUNCT_RE = /[.,;:!?)\]]+$/;

// Bech32 decoding is pure string work but not free, and the same handful of
// addresses recur throughout a long article (and on every keystroke in the
// editor). Memoising keeps repeat lookups O(1).
//
// Bounded so a hostile or very long document cannot grow it without limit;
// entries are cheap (a short string key, a string-or-null value), so a cap in
// the low thousands stays far below a megabyte while covering any real article.
const MAX_VALIDATION_CACHE = 2000;
const validationCache = new Map();

/**
 * Normalises a candidate token and confirms it is a decodable nostr entity.
 * Returns the lowercase address, or null when the token only looks like one
 * (e.g. "note1st" or a truncated npub).
 */
export function toValidAddr(candidate) {
  if (!candidate) return null;
  const addr = candidate.toLowerCase();

  if (validationCache.has(addr)) {
    return validationCache.get(addr);
  }

  let result = null;
  try {
    nip19.decode(addr);
    result = addr;
  } catch {
    result = null;
  }

  // Simple FIFO eviction: drop the oldest entry once the cap is reached.
  // Map preserves insertion order, so the first key is the oldest.
  if (validationCache.size >= MAX_VALIDATION_CACHE) {
    validationCache.delete(validationCache.keys().next().value);
  }
  validationCache.set(addr, result);

  return result;
}

/**
 * Strips trailing sentence punctuation, then validates. Used where an entity
 * ends a sentence, e.g. "written by nostr:npub1abc…".
 */
export function toValidAddrLoose(token) {
  if (!token) return null;
  const match = token.replace(TRAILING_PUNCT_RE, "").match(ENTITY_ONLY_RE);
  return match ? toValidAddr(match[1]) : null;
}

/**
 * True when the character before `index` does not glue the match to a word or
 * a URL path. Without this, "https://njump.me/npub1…" would be rewritten into
 * a mention and the surrounding link destroyed.
 */
export function hasBoundaryBefore(text, index) {
  if (index === 0) return true;
  return !/[a-z0-9/]/i.test(text[index - 1]);
}

/**
 * Splits a run of text into literal strings and validated entity addresses.
 * Returns null when the text holds no entity, letting callers skip all work
 * and keep the original node untouched.
 *
 * @param {string} text
 * @returns {Array<{type:"text",value:string}|{type:"entity",addr:string}>|null}
 */
export function splitTextByEntities(text) {
  if (!text) return null;

  // Cheap pre-check: the substring "1" plus a prefix letter must be present.
  // Avoids running the global regex over ordinary prose.
  if (!/(?:npub|nprofile|nevent|note|naddr)1/i.test(text)) return null;

  const parts = [];
  let last = 0;
  let match;
  ENTITY_RE.lastIndex = 0;

  while ((match = ENTITY_RE.exec(text)) !== null) {
    // Zero-length matches are impossible here, but guard against a pathological
    // regex state rather than spinning forever.
    if (match[0].length === 0) {
      ENTITY_RE.lastIndex += 1;
      continue;
    }
    if (!hasBoundaryBefore(text, match.index)) continue;

    const addr = toValidAddr(match[1]);
    if (!addr) continue;

    if (match.index > last) {
      parts.push({ type: "text", value: text.slice(last, match.index) });
    }
    parts.push({ type: "entity", addr });
    last = match.index + match[0].length;
  }

  if (parts.length === 0) return null;
  if (last < text.length) {
    parts.push({ type: "text", value: text.slice(last) });
  }
  return parts;
}

/**
 * When `text` consists solely of nostr entities separated by whitespace,
 * returns their addresses in order. Returns null otherwise.
 *
 * This is what promotes a line to a full-size block preview rather than a
 * compact inline mention.
 */
export function asStandaloneAddrs(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const addrs = [];
  for (const token of tokens) {
    const addr = toValidAddrLoose(token);
    if (!addr) return null;
    addrs.push(addr);
  }
  return addrs;
}
