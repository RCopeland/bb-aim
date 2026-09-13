#!/usr/bin/env node
/**
 * Generates aim/WIN98_scoped.css from node_modules/98.css/dist/98.css.
 *
 * 98.css uses name-generic classes (`.window`, `.title-bar`, `button`, ...)
 * that would leak into the rest of bb-app if imported raw. This script mirrors
 * make-xp-scoped.mjs but for the Windows 98 era baseline (jdan/98.css):
 *   1. Prefixes every selector with `.aim-xp ` so no rule escapes the plugin.
 *   2. Inlines the two ms-sans-serif fonts (.woff + .woff2) as base64 data:
 *      URIs so the stylesheet is fully self-contained.
 *
 * Unlike XP.css, 98.css defines no @keyframes and no PerfectDOS terminal font,
 * so those substitutions are not needed here.
 *
 * Regenerate after any 98.css bump:
 *     node scripts/make-98-scoped.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url))); // plugin root
const dist = join(root, "node_modules/98.css/dist");
const source = readFileSync(join(dist, "98.css"), "utf8");

// Fonts to inline (base64).
const FONT_FILES = [
  "ms_sans_serif.woff2",
  "ms_sans_serif.woff",
  "ms_sans_serif_bold.woff2",
  "ms_sans_serif_bold.woff",
];

function fontDataUri(filename, ext) {
  const b64 = readFileSync(join(dist, filename)).toString("base64");
  return `url("data:font/${ext};base64,${b64}")`;
}

/**
 * Prefix every rule selector with `.aim-xp `. Handles normal rules, @font-face,
 * @keyframes (keyframe selectors left untouched), and @media/@supports (via
 * recursion). Works on minified CSS and is brace/string/comment aware.
 */
function prefixDoc(src) {
  const n = src.length;
  let i = 0;
  let out = "";
  const fail = (m) => {
    throw new Error(`Win98 scope: ${m} at ${i}`);
  };
  const eof = () => i >= n;
  const char = () => src[i];

  function readString() {
    const q = char();
    let s = q;
    i++;
    while (i < n) {
      const c = char();
      if (c === "\\") {
        s += c;
        i++;
        if (i < n) {
          s += char();
          i++;
        }
        continue;
      }
      if (c === q) {
        s += c;
        i++;
        return s;
      }
      s += c;
      i++;
    }
    fail("unterminated string");
  }

  function skipWsComments() {
    for (;;) {
      while (i < n && /[ \t\r\n]/.test(char())) i++;
      if (!eof() && char() === "/" && src[i + 1] === "*") {
        const e = src.indexOf("*/", i + 2);
        if (e < 0) fail("unterminated comment");
        i = e + 2;
      } else break;
    }
  }

  function readUntil(stops) {
    let s = "";
    while (i < n) {
      const c = char();
      if (c === '"' || c === "'") {
        s += readString();
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        const e = src.indexOf("*/", i + 2);
        if (e < 0) fail("unterminated comment");
        s += src.slice(i, e + 2);
        i = e + 2;
        continue;
      }
      if (stops.includes(c)) return s;
      s += c;
      i++;
    }
    return s;
  }

  // Returns the full balanced block text (with braces); src[i] must be '{'.
  function readRawBalanced() {
    if (char() !== "{") fail("expected {");
    const start = i;
    i++;
    let depth = 1;
    while (i < n) {
      const c = char();
      if (c === '"' || c === "'") {
        readString();
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        const e = src.indexOf("*/", i + 2);
        if (e < 0) fail("unterminated comment");
        i = e + 2;
        continue;
      }
      if (c === "{") {
        depth++;
        i++;
        continue;
      }
      if (c === "}") {
        depth--;
        i++;
        if (depth === 0) return src.slice(start, i);
        continue;
      }
      i++;
    }
    fail("unbalanced block");
  }

  function readIdent() {
    let s = "";
    while (i < n && /[0-9a-zA-Z_-]/.test(char())) {
      s += char();
      i++;
    }
    return s;
  }

  function splitTopLevel(text) {
    const parts = [];
    let buf = "";
    let depth = 0;
    for (let k = 0; k < text.length; k++) {
      const ch = text[k];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        parts.push(buf);
        buf = "";
        continue;
      }
      buf += ch;
    }
    parts.push(buf);
    return parts;
  }

  function prefixSelectorList(sel) {
    // Drop unreachable global-tag selectors that can never be descendants of
    // `.aim-xp` (the desktop root is a <div>): bare `body` would be dead weight.
    // Everything else (bare tag selectors like button/input/h1/pre/code, and
    // all class/attribute/pseudo selectors) is scoped under `.aim-xp` so it
    // applies only inside the AIM desktop.
    const parts = splitTopLevel(sel.trim())
      .map((p) => p.trim())
      .filter(
        (t) =>
          t &&
          t.toLowerCase() !== "body" &&
          t.toLowerCase() !== "html" &&
          !t.startsWith(":host") &&
          !t.startsWith("::root"),
      );
    if (parts.length === 0) return null;
    return parts.map((t) => `.aim-xp ${t}`).join(", ");
  }

  (function loop() {
    for (;;) {
      skipWsComments();
      if (eof()) break;
      const c = char();
      if (c === "@") {
        i++;
        const at = "@" + readIdent();
        if (at === "@font-face") {
          const pre = readUntil(["{", ";"]);
          if (!eof() && char() === "{") {
            out += at + pre + readRawBalanced();
          } else {
            out += at + pre;
          }
        } else if (at === "@keyframes") {
          const pre = readUntil(["{", ";"]);
          if (!eof() && char() === "{") {
            out += at + pre + readRawBalanced();
          } else {
            out += at + pre;
          }
        } else {
          const pre = readUntil(["{", ";"]);
          if (!eof() && char() === ";") {
            i++;
            out += at + pre + ";";
          } else if (!eof() && char() === "{") {
            const block = readRawBalanced();
            out += at + pre + "{" + prefixDoc(block.slice(1, -1)) + "}";
          } else {
            fail("unterminated at-rule");
          }
        }
      } else {
        const sel = readUntil(["{", ";"]);
        if (!eof() && char() === "{") {
          const scopedSel = prefixSelectorList(sel);
          if (scopedSel) {
            out += scopedSel + readRawBalanced();
          } else {
            readRawBalanced();
          }
        } else {
          fail("expected { after selector");
        }
      }
    }
  })();

  return out;
}

const scoped = prefixDoc(source).replace(/}\s*$/, "}\n");

const header = `/* bb-aim scoped 98.css (Windows 98 base) — generated by scripts/make-98-scoped.mjs.
   Source: 98.css@0.1.21 (MIT, jdan/98.css). All rules are scoped under
   .aim-xp so nothing leaks into the host app. Fonts inlined as base64.
   NOTE: this is the OS chrome baseline; the AIM 3.0 palette overrides live in
   aim.css on top. DO NOT EDIT BY HAND. */\n`;

const withFonts = scoped
  .replace(/url\(ms_sans_serif\.woff2\)/g, fontDataUri("ms_sans_serif.woff2", "woff2"))
  .replace(/url\(ms_sans_serif\.woff\)/g, fontDataUri("ms_sans_serif.woff", "woff"))
  .replace(/url\(ms_sans_serif_bold\.woff2\)/g, fontDataUri("ms_sans_serif_bold.woff2", "woff2"))
  .replace(/url\(ms_sans_serif_bold\.woff\)/g, fontDataUri("ms_sans_serif_bold.woff", "woff"))
  // Safety: drop any lingering non-inlined font url() references.
  .replace(/url\(ms_sans_serif[^)]*\)/g, "");

writeFileSync(join(root, "aim/WIN98_scoped.css"), header + withFonts);
console.log("wrote aim/WIN98_scoped.css", (header + withFonts).length, "bytes");