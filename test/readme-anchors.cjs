// Validate README anchors: every in-page link must resolve to a heading or an
// explicit <a id>. Catches a table-of-contents entry that points nowhere.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = ['README.md', 'README.zh.md'];

// GitHub's heading slug: lowercase, drop anything that is not a word character,
// a space or a hyphen — parentheses and slashes vanish, so "Viewport sizes
// (phone / desktop / custom)" becomes "viewport-sizes-phone--desktop--custom".
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\w\u4e00-\u9fa5 -]/g, '')
    .replace(/ /g, '-');

let failures = 0;
for (const f of files) {
  const text = fs.readFileSync(path.join(root, f), 'utf8');
  const lines = text.split(/\r?\n/);
  const ids = new Set();
  for (const m of text.matchAll(/<a id="([^"]+)"/g)) ids.add(m[1]);
  for (const line of lines) {
    const h = /^(#{2,3}) (.*)$/.exec(line);
    if (h) ids.add(slug(h[2]));
  }
  const links = [...text.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
  const missing = links.filter((l) => !ids.has(l));
  console.log(`${f}: ${lines.length} lines, ${ids.size} anchors, ${links.length} in-page links`);
  if (missing.length > 0) {
    console.error(`  MISSING anchors: ${missing.join(', ')}`);
    failures++;
  }
  // Report the new section is present and non-trivial.
  const idx = text.indexOf('## Compatibility');
  const idxZh = text.indexOf('## 版本适配');
  const start = idx >= 0 ? idx : idxZh;
  if (start < 0) {
    console.error(`  MISSING the compatibility section`);
    failures++;
  } else {
    const rest = text.slice(start);
    const next = rest.slice(3).search(/^## /m);
    const body = next < 0 ? rest : rest.slice(0, next + 3);
    console.log(`  compatibility section: ${body.split(/\r?\n/).length} lines`);
  }
}
process.exit(failures === 0 ? 0 : 1);
