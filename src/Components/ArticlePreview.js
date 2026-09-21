import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import katex from "katex";
import "katex/dist/katex.min.css";
import Link from "next/link";
import Nip19Parsing from "@/Components/Nip19Parsing";
import { getLinkFromAddr } from "@/Helpers/Helpers";
import remarkNostrEntities from "@/Helpers/remarkNostrEntities";

function nostrHrefToRoute(href) {
  if (typeof href !== "string" || !/^nostr:/i.test(href)) return null;
  const route = getLinkFromAddr(href);
  return route && route.startsWith("/") ? route : null;
}

export default function ArticlePreview({ content }) {
  if (!content) return null;

  return (
    <div className="article-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkNostrEntities]}
        rehypePlugins={[rehypeHighlight, rehypeRaw]}
        components={{
          // Standalone entity → hast div[data-nostr-addr]
          div({ node, ...props }) {
            const addr = node?.properties?.["dataNostrAddr"];
            if (addr) {
              return (
                <div style={{ margin: "0.75rem 0" }}>
                  <Nip19Parsing addr={addr} />
                </div>
              );
            }
            return <div {...props} />;
          },

          // Inline entity → hast span[data-nostr-inline]
          span({ node, ...props }) {
            const addr = node?.properties?.["dataNostrInline"];
            if (addr) {
              return (
                <span className="nostr-inline-entity">
                  <Nip19Parsing addr={addr} minimal={true} />
                </span>
              );
            }
            return <span {...props} />;
          },

          // [label](nostr:…) links open the entity inside the app
          a({ node, href, children, ...props }) {
            const route = nostrHrefToRoute(href);
            if (route) {
              return (
                <Link href={route} {...props}>
                  {children}
                </Link>
              );
            }
            return (
              <a href={href} {...props}>
                {children}
              </a>
            );
          },

          // react-markdown v10: distinguish inline vs block via className presence
          code({ className, children, ...props }) {
            const isBlock =
              typeof className === "string" &&
              className.startsWith("language-");
            const txt = Array.isArray(children)
              ? String(children[0] ?? "")
              : String(children ?? "");

            if (!isBlock) {
              if (/^\$\$(.*)\$\$/.test(txt)) {
                const html = katex.renderToString(
                  txt.replace(/^\$\$(.*)\$\$/, "$1"),
                  { throwOnError: false }
                );
                return <code dangerouslySetInnerHTML={{ __html: html }} />;
              }
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }

            if (/^language-katex/i.test(className)) {
              const html = katex.renderToString(txt, { throwOnError: false });
              return (
                <div className="math-block">
                  <code dangerouslySetInnerHTML={{ __html: html }} />
                </div>
              );
            }

            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
