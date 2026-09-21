import {
  asStandaloneAddrs,
  splitTextByEntities,
} from "@/Helpers/NostrEntityParsing";

/**
 * Remark plugin that renders nostr entities found anywhere in article markdown.
 *
 * Detection rules live in @/Helpers/NostrEntityParsing so the TipTap editor
 * preview and the published article page stay in agreement.
 *
 * Pass 1 promotes paragraphs made only of entities to block-level previews.
 * Pass 2 turns every remaining entity in running text into an inline mention.
 */

// Nodes whose text must never be rewritten: code, raw html and link labels.
// Rewriting a link's label would strip its href; rewriting code would corrupt
// a deliberate example.
const SKIP_INLINE_IN = new Set([
  "link",
  "linkReference",
  "definition",
  "inlineCode",
  "code",
  "html",
]);

function blockNode(addr) {
  return {
    type: "nostrEmbed",
    data: { hName: "div", hProperties: { "data-nostr-addr": addr } },
    children: [],
  };
}

function inlineNode(addr) {
  return {
    type: "nostrInline",
    data: { hName: "span", hProperties: { "data-nostr-inline": addr } },
    children: [],
  };
}

/**
 * Pass 1 — a paragraph whose entire content is one or more nostr entities
 * (separated by whitespace or hard breaks, trailing punctuation tolerated)
 * becomes one block embed per entity.
 */
function embedStandaloneParagraphs(parent) {
  if (!parent.children) return;

  const next = [];
  for (const child of parent.children) {
    if (child.type === "paragraph" && child.children?.length) {
      const onlyTextOrBreak = child.children.every(
        (c) => c.type === "text" || c.type === "break",
      );
      if (onlyTextOrBreak) {
        const raw = child.children
          .map((c) => (c.type === "text" ? c.value : "\n"))
          .join("");
        const addrs = asStandaloneAddrs(raw);
        if (addrs) {
          addrs.forEach((addr) => next.push(blockNode(addr)));
          continue;
        }
      }
    }
    embedStandaloneParagraphs(child);
    next.push(child);
  }
  parent.children = next;
}

/**
 * Pass 2 — any entity left inside running text (paragraphs, list items,
 * headings, emphasis, table cells) becomes a compact inline mention.
 */
function mentionInlineEntities(node) {
  if (!node.children || SKIP_INLINE_IN.has(node.type)) return;

  let rewrote = false;
  const next = [];

  for (const child of node.children) {
    if (child.type !== "text") {
      mentionInlineEntities(child);
      next.push(child);
      continue;
    }

    const parts = splitTextByEntities(child.value);
    if (!parts) {
      next.push(child);
      continue;
    }

    rewrote = true;
    for (const part of parts) {
      next.push(
        part.type === "entity"
          ? inlineNode(part.addr)
          : { type: "text", value: part.value },
      );
    }
  }

  // Only swap the array when something actually changed, so untouched
  // paragraphs keep their original node objects.
  if (rewrote) node.children = next;
}

export default function remarkNostrEntities() {
  return (tree) => {
    embedStandaloneParagraphs(tree);
    mentionInlineEntities(tree);
  };
}
