// Pré-comprime o build (brotli no nível máximo + gzip) uma vez só, na hora do build.
// O servidor entrega o .br/.gz direto (preCompressed), sem gastar CPU comprimindo a cada pedido.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = path.resolve(process.argv[2] || "dist");
const COMPRESSIBLE = /\.(js|mjs|css|html|svg|json|txt|xml|map|ttf|eot)$/i;
let count = 0;
let before = 0;
let after = 0;

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(file);
    else if (COMPRESSIBLE.test(ent.name)) {
      const buf = fs.readFileSync(file);
      if (buf.length < 1024) continue;
      const br = zlib.brotliCompressSync(buf, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length },
      });
      const gz = zlib.gzipSync(buf, { level: 9 });
      if (br.length < buf.length) fs.writeFileSync(file + ".br", br);
      if (gz.length < buf.length) fs.writeFileSync(file + ".gz", gz);
      count++;
      before += buf.length;
      after += br.length;
    }
  }
}

walk(root);
console.log(`pré-comprimidos: ${count} arquivos, ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB (brotli)`);
