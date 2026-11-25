import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const b64 = (f) => readFileSync(join(root, 'fonts', f)).toString('base64');

const out = `// @ts-check
// Comic Neue © The Comic Neue Project Authors, SIL Open Font License 1.1 (fonts/OFL.txt).
var Fonts = (() => {
  const FAMILY = 'Imgtr Comic';
  const FACES = /** @type {const} */ ([
    ['700', '${b64('comic-neue-700.woff2')}'],
    ['400', '${b64('comic-neue-400.woff2')}'],
  ]);
  let done = false;

  /** @param {string} s */
  function bytes(s) {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }

  function ensure() {
    if (done) return;
    done = true;
    try {
      for (const [weight, data] of FACES) {
        const face = new FontFace(FAMILY, bytes(data), { weight, style: 'normal', display: 'swap' });
        document.fonts.add(face);
        face.load().catch(() => {});
      }
    } catch {}
  }

  return { ensure, FAMILY };
})();
`;
writeFileSync(join(root, 'content', 'font.js'), out);
console.log('wrote content/font.js', out.length, 'bytes');
