// Reference fixtures are private local verification inputs, never release assets.
import { readFile, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import assert from 'node:assert/strict';

const [modelDirectory, fixturePath, output] = process.argv.slice(2);
if (!output) throw new Error('Usage: node scripts/verify_ranker.mjs MODEL FIXTURES OUTPUT');
const compiled = await build({entryPoints: ['app/lib/ranker-engine.ts'], bundle: true, write: false, format: 'esm', platform: 'node'});
const {RankerEngine} = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const metadata = JSON.parse(await readFile(path.join(modelDirectory, 'ranker.json'), 'utf8'));
const files = {};
for (const name of ['ease', 'liked_to_low', 'disliked_to_low', 'disliked_to_high']) files[name] = await open(path.join(modelDirectory, name + '.bin'));
const engine = new RankerEngine(metadata, async (name, row) => {
  const values = new Float32Array(metadata.item_count);
  const result = await files[name].read(values, 0, values.byteLength, row * values.byteLength);
  assert.equal(result.bytesRead, values.byteLength);
  return values;
});
const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
const rows = [];
try {
  for (const fixture of fixtures) {
    const start = performance.now();
    const result = await engine.recommend(fixture.rating_pairs ?? fixture.ratings, new Set(fixture.excluded));
    const actual = result.slice(0, 100).map(r => r.mal_id);
    const mismatches = actual.reduce((n, id, i) => n + Number(id !== fixture.expected[i]), 0);
    rows.push({name: fixture.name, mismatches, count: actual.length, milliseconds: performance.now() - start});
    if (mismatches) console.log(fixture.name, 'differences:', mismatches, 'first', actual.findIndex((id, i) => id !== fixture.expected[i]));
  }
  const summary = {passed: rows.every(r => r.mismatches === 0), profiles: rows.length, rows};
  await writeFile(output, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({passed: summary.passed, profiles: rows.length, mismatches: rows.reduce((n,r) => n+r.mismatches,0)}));
  assert.ok(summary.passed, 'Browser inference differs from frozen Python predictions');
} finally {
  await Promise.all(Object.values(files).map(file => file.close()));
}
