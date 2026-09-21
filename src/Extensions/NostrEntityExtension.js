import { Node, mergeAttributes, ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";
import React from "react";
import Nip19Parsing from "@/Components/Nip19Parsing";
import {
  asStandaloneAddrs,
  toValidAddrLoose,
} from "@/Helpers/NostrEntityParsing";

// Typed at the end of a line, and pasted anywhere. Kept in sync with
// ENTITY_ONLY_RE / ENTITY_RE in @/Helpers/NostrEntityParsing; every match is
// re-validated with toValidAddrLoose before it becomes a node.
const ENTITY_INPUT_RE =
  /(?:^|\s)@?(?:nostr:)?(?:npub|nprofile|nevent|note|naddr)1[a-z0-9]+[.,;:!?]?\s$/i;
const ENTITY_PASTE_RE =
  /@?(?:nostr:)?(?:npub|nprofile|nevent|note|naddr)1[a-z0-9]+/gi;

function NostrEntityView({ node, selected }) {
  const { addr } = node.attrs;
  return (
    <NodeViewWrapper
      contentEditable={false}
      data-drag-handle
      style={{
        outline: selected ? "2px solid var(--color-primary-accent)" : "none",
        outlineOffset: 2,
        borderRadius: 10,
        margin: "6px 0",
        display: "block",
        userSelect: "none",
      }}
    >
      <Nip19Parsing addr={addr} />
    </NodeViewWrapper>
  );
}

const NostrEntityExtension = Node.create({
  name: "nostrEntity",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  isolating: false,

  addAttributes() {
    return {
      addr: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-nostr-entity]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes({ "data-nostr-entity": HTMLAttributes.addr }, HTMLAttributes),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(NostrEntityView);
  },

  addCommands() {
    return {
      insertNostrEntity:
        (attrs) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs,
          });
        },
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.write(`nostr:${node.attrs.addr}`);
          state.closeBlock(node);
        },
        parse: {
          updateDOM(element) {
            element.querySelectorAll("p").forEach((p) => {
              // Shared rule: a paragraph made only of nostr entities becomes
              // one block embed per entity, matching ArticlePreview.
              // A block node cannot live in a table cell, and ArticlePreview
              // keeps those inline, so skip paragraphs inside a table.
              if (p.closest("td, th")) return;
              // Never swallow a deliberate code sample or a link: textContent
              // would read through them and ArticlePreview leaves both alone.
              if (p.querySelector("code, pre, a")) return;
              const addrs = asStandaloneAddrs(p.textContent);
              if (!addrs) return;
              const frag = document.createDocumentFragment();
              addrs.forEach((addr) => {
                const div = document.createElement("div");
                div.setAttribute("data-nostr-entity", addr);
                div.setAttribute("addr", addr);
                frag.appendChild(div);
              });
              p.replaceWith(frag);
            });
          },
        },
      },
    };
  },

  addInputRules() {
    // A typed entity becomes a block embed only when it stands alone on the
    // line; otherwise MentionExtension turns it into an inline mention.
    const handler = ({ range, match, chain, state }) => {
      const addr = toValidAddrLoose(match[0].trim());
      if (!addr) return null;

      // `range.from` is where the match begins. If anything other than
      // whitespace precedes it in this text block, the entity is inline.
      const $from = state.doc.resolve(range.from);
      const before = $from.parent.textBetween(0, Math.max(0, $from.parentOffset));
      if (before.trim().length > 0) return null;

      chain()
        .deleteRange(range)
        .insertContent({ type: "nostrEntity", attrs: { addr } })
        .run();
      return undefined;
    };

    return [
      { find: ENTITY_INPUT_RE, handler },
    ];
  },

  addPasteRules() {
    return [
      {
        find: ENTITY_PASTE_RE,
        handler({ range, match, chain }) {
          const addr = toValidAddrLoose(match[0].trim());
          if (!addr) return null;
          chain()
            .deleteRange(range)
            .insertContent({ type: "nostrEntity", attrs: { addr } })
            .run();
          return undefined;
        },
      },
    ];
  },
});

export default NostrEntityExtension;
