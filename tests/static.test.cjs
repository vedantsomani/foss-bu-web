// Keeps game.js's download list, version strings and files on disk in step.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.join(__dirname, '..', 'public');
const game = fs.readFileSync(path.join(pub, 'game.js'), 'utf8');
const version = /const VERSION = '([^']+)'/.exec(game)[1];

for (const [, file, bytes] of game.matchAll(/file: '([^']+)', bytes: (\d+)/g)) {
    assert.equal(fs.statSync(path.join(pub, file)).size, Number(bytes), `${file} size in game.js DOWNLOADS`);
}
for (const page of ['index.html', 'credits.html']) {
    const html = fs.readFileSync(path.join(pub, page), 'utf8');
    for (const [, v] of html.matchAll(/\?v=([\w.]+)/g)) assert.equal(v, version, `${page} asset version`);
    for (const [, ref] of html.matchAll(/(?:src|href)="(?![a-z]+:)([^"#?]+)[^"]*"/g)) {
        if (ref !== '/') assert.ok(fs.existsSync(path.join(pub, ref)), `${page} references missing ${ref}`);
    }
}
const ids = [...fs.readFileSync(path.join(pub, 'index.html'), 'utf8').matchAll(/id="([^"]+)"/g)].map(m => m[1]);
for (const [, id] of game.matchAll(/\$\('([\w-]+)'\)/g)) assert.ok(ids.includes(id), `game.js uses missing #${id}`);
assert.equal(new Set(ids).size, ids.length, 'duplicate ids in index.html');
console.log(`Static checks passed (version ${version})`);
