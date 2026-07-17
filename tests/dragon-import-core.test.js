/*
 * Dependency-free tests for js/dragon-import-core.js.
 * Run with: node tests/dragon-import-core.test.js
 * No network calls, no API keys required — all "AI responses" here are
 * hand-written mocks, exactly as the project spec requires.
 */
const assert = require('assert');
const Core = require('../js/dragon-import-core.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  -', name);
  } catch (e) {
    failed++;
    console.log('  FAIL -', name);
    console.log('        ', e.message);
  }
}

console.log('sanitizeAiResponse');

test('valid well-formed response passes through with no forced review', () => {
  const mock = {
    dragons: [{
      name: 'Vhagar', dragonId: null, starRank: 6, level: 34, maxLevel: 50,
      confidence: { name: 0.97, starRank: 0.9, level: 0.95, maxLevel: 0.8 },
      needsReview: false, reviewNotes: [],
    }],
  };
  const { dragons, errors } = Core.sanitizeAiResponse(mock, 'shot1.png');
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(dragons.length, 1);
  assert.strictEqual(dragons[0].name, 'Vhagar');
  assert.strictEqual(dragons[0].starRank, 6);
  assert.strictEqual(dragons[0].level, 34);
  assert.strictEqual(dragons[0].needsReview, false);
});

test('malformed JSON string is rejected, not thrown', () => {
  const { dragons, errors } = Core.sanitizeAiResponse('{not valid json', 'shot.png');
  assert.strictEqual(dragons.length, 0);
  assert.ok(errors[0].toLowerCase().includes('not valid json'));
});

test('response missing the dragons array is rejected', () => {
  const { dragons, errors } = Core.sanitizeAiResponse({ foo: 'bar' }, 'shot.png');
  assert.strictEqual(dragons.length, 0);
  assert.ok(errors.length > 0);
});

test('missing name/star/level are flagged needsReview, not silently dropped', () => {
  const mock = { dragons: [{ name: null, starRank: null, level: 42 }] };
  const { dragons } = Core.sanitizeAiResponse(mock, 'shot.png');
  assert.strictEqual(dragons[0].needsReview, true);
  assert.ok(dragons[0].reviewNotes.some((n) => n.includes('name')));
  assert.ok(dragons[0].reviewNotes.some((n) => n.includes('Star rank')));
});

test('low-confidence present values are flagged for review', () => {
  const mock = { dragons: [{ name: 'Syrax', starRank: 3, level: 36, confidence: { name: 0.3, starRank: 0.9, level: 0.9 } }] };
  const { dragons } = Core.sanitizeAiResponse(mock, 'shot.png');
  assert.strictEqual(dragons[0].needsReview, true);
});

test('out-of-range numeric values are dropped to null, not clamped-and-trusted', () => {
  const mock = { dragons: [{ name: 'X', starRank: 999, level: -5 }] };
  const { dragons } = Core.sanitizeAiResponse(mock, 'shot.png');
  assert.strictEqual(dragons[0].starRank, null);
  assert.strictEqual(dragons[0].level, null);
});

test('no dragon detected produces an empty, valid result with an error note', () => {
  const { dragons, errors } = Core.sanitizeAiResponse({ dragons: [] }, 'empty.png');
  assert.strictEqual(dragons.length, 0);
  assert.ok(errors[0].toLowerCase().includes('no dragon'));
});

test('multiple dragons in one screenshot each become a separate result', () => {
  const mock = { dragons: [{ name: 'A', starRank: 1, level: 1 }, { name: 'B', starRank: 2, level: 2 }] };
  const { dragons } = Core.sanitizeAiResponse(mock, 'shot.png');
  assert.strictEqual(dragons.length, 2);
});

console.log('\nmatchDragon');

const roster = [
  { id: 'd1', name: 'Vhagar', star: 3, reign: 15 },
  { id: 'd2', name: 'Malachite', star: 2, reign: 15 },
  { id: 'd3', name: 'Sheepstealer', star: 1, reign: 15 },
];

test('exact name match', () => {
  const m = Core.matchDragon({ name: 'Vhagar' }, roster);
  assert.strictEqual(m.matchType, 'exact');
  assert.strictEqual(m.dragon.id, 'd1');
});

test('case-insensitive match', () => {
  const m = Core.matchDragon({ name: 'vhagar' }, roster);
  assert.strictEqual(m.matchType, 'case-insensitive');
  assert.strictEqual(m.dragon.id, 'd1');
});

test('conservative fuzzy match (one-character typo)', () => {
  const m = Core.matchDragon({ name: 'Vhagr' }, roster); // missing an 'a'
  assert.strictEqual(m.matchType, 'fuzzy');
  assert.strictEqual(m.dragon.id, 'd1');
});

test('fuzzy match does NOT fire on a genuinely different name', () => {
  const m = Core.matchDragon({ name: 'Completely Different Dragon' }, roster);
  assert.strictEqual(m.matchType, 'none');
  assert.strictEqual(m.dragon, null);
});

test('dragonId takes priority over name when both are present', () => {
  const m = Core.matchDragon({ name: 'wrong name entirely', dragonId: 'd2' }, roster);
  assert.strictEqual(m.matchType, 'id');
  assert.strictEqual(m.dragon.id, 'd2');
});

test('no match returns matchType none', () => {
  const m = Core.matchDragon({ name: 'Nonexistent' }, roster);
  assert.strictEqual(m.matchType, 'none');
});

console.log('\nfindBatchDuplicates');

test('detects two rows in the same batch with the same normalized name', () => {
  const dups = Core.findBatchDuplicates([{ name: 'Vhagar' }, { name: 'Malachite' }, { name: 'vhagar' }]);
  assert.ok(dups.has(2));
  assert.ok(!dups.has(0));
  assert.ok(!dups.has(1));
});

console.log('\napplyImportRow / applyImportBatch');

test('adding a new dragon appends it with reviewed star/level', () => {
  const row = { action: 'add', name: 'Newdragon', starRank: 4, level: 20 };
  const { roster: next, result } = Core.applyImportRow(row, roster, { makeId: () => 'new-1' });
  assert.strictEqual(next.length, roster.length + 1);
  assert.strictEqual(next[next.length - 1].name, 'Newdragon');
  assert.strictEqual(next[next.length - 1].star, 4);
  assert.strictEqual(next[next.length - 1].reign, 20);
  assert.strictEqual(result.action, 'added');
});

test('adding a dragon with no name throws (caught by batch, not silently ignored)', () => {
  assert.throws(() => Core.applyImportRow({ action: 'add', name: null }, roster));
});

test('updating an existing dragon changes only star/level, preserves everything else', () => {
  const withExtra = [{ id: 'd1', name: 'Vhagar', star: 3, reign: 15, power: 34880, notes: 'keep me', abilities: 'taunt' }];
  const row = { action: 'update', matchedDragonId: 'd1', starRank: 6, level: 34 };
  const { roster: next } = Core.applyImportRow(row, withExtra);
  assert.strictEqual(next[0].star, 6);
  assert.strictEqual(next[0].reign, 34);
  assert.strictEqual(next[0].power, 34880, 'power must be untouched');
  assert.strictEqual(next[0].notes, 'keep me', 'notes must be untouched');
  assert.strictEqual(next[0].abilities, 'taunt', 'abilities must be untouched');
});

test('a null reviewed value never overwrites a valid existing value', () => {
  const withExtra = [{ id: 'd1', name: 'Vhagar', star: 3, reign: 15 }];
  const row = { action: 'update', matchedDragonId: 'd1', starRank: null, level: null };
  const { roster: next } = Core.applyImportRow(row, withExtra);
  assert.strictEqual(next[0].star, 3, 'star should be unchanged since reviewed value was null');
  assert.strictEqual(next[0].reign, 15, 'reign should be unchanged since reviewed value was null');
});

test('updating with no matching id throws', () => {
  assert.throws(() => Core.applyImportRow({ action: 'update', matchedDragonId: 'nope', starRank: 1, level: 1 }, roster));
});

test('skip makes no changes to the roster', () => {
  const { roster: next, result } = Core.applyImportRow({ action: 'skip', name: 'Whatever' }, roster);
  assert.strictEqual(next.length, roster.length);
  assert.strictEqual(result.action, 'skipped');
});

test('invalid action is rejected', () => {
  assert.throws(() => Core.applyImportRow({ action: 'explode' }, roster));
});

test('batch import: one bad row fails without blocking or corrupting the good rows', () => {
  const rows = [
    { action: 'add', name: 'GoodOne', starRank: 5, level: 20 },
    { action: 'update', matchedDragonId: 'does-not-exist', starRank: 1, level: 1 }, // bad
    { action: 'add', name: 'GoodTwo', starRank: 2, level: 10 },
  ];
  const { roster: finalRoster, results, failures } = Core.applyImportBatch(rows, roster, { makeId: (() => { let n = 0; return () => 'batch-' + (n++); })() });
  assert.strictEqual(failures.length, 1);
  assert.strictEqual(results.length, 2);
  assert.strictEqual(finalRoster.length, roster.length + 2, 'the two good adds must still have applied');
  assert.ok(finalRoster.some((d) => d.name === 'GoodOne'));
  assert.ok(finalRoster.some((d) => d.name === 'GoodTwo'));
});

console.log('\nbuildExportJson / exportFilename');

test('export JSON matches the required schema', () => {
  const results = [
    { name: 'Vhagar', dragonId: 'd1', starRank: 6, level: 34, maxLevel: 50, action: 'updated' },
    { name: 'NewOne', dragonId: 'new-1', starRank: 2, level: 10, maxLevel: null, action: 'added' },
  ];
  const json = Core.buildExportJson(results, '2026-07-17T00:00:00.000Z');
  assert.strictEqual(json.schemaVersion, '1.0');
  assert.strictEqual(json.source, 'dragon-screenshot-import');
  assert.strictEqual(json.exportedAt, '2026-07-17T00:00:00.000Z');
  assert.strictEqual(json.dragons.length, 2);
  assert.strictEqual(json.dragons[0].action, 'updated');
  assert.strictEqual(json.dragons[1].maxLevel, null);
});

test('export filename matches the required pattern', () => {
  const name = Core.exportFilename(new Date('2026-07-17T09:05:03Z'));
  assert.ok(/^dragons-import-\d{4}-\d{2}-\d{2}-\d{6}\.json$/.test(name), name);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
