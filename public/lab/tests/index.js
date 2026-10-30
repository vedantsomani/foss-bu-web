// Entry so that `node --test public/lab/tests/` (a directory argument) runs every *.test.js here.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('.', import.meta.url));
for (const f of readdirSync(dir).filter(f => f.endsWith('.test.js')).sort()) await import('./' + f);
