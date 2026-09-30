import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { weekly, buildSnapshot, publishSnapshot } from './refresh-data.mjs';

const end = '20260930';
const request = async url => url.includes('tushare')
  ? { code: 0, data: { fields: ['trade_date', 'pe_ttm'], items: [['20260930', 30], ['20260929', 29], ['20260928', 28]] } }
  : { code: '200', data: [{ tradeDate: '20260930', peg: 30, close: 3000 }, { tradeDate: '20260928', peg: 28, close: 2800 }, { tradeDate: '20260929', peg: 29, close: 2900 }] };

test('descending source rows still retain the newest trading day after sampling', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ d: `2026-09-${String(30 - i).padStart(2, '0')}`, pe: 30 - i }));
  const result = weekly([...rows, { d: '2026-10-01', pe: 100 }, { d: '2026-09-18', pe: null }], end);
  assert.equal(result.at(-1).d, '2026-09-30');
  assert.equal(result.at(-1).pe, 30);
  assert.equal(result[0].d, '2026-09-19');
});

test('all ten indices use their actual latest date, value and chronological history', async () => {
  const data = await buildSnapshot({ token: 'fixture', end, request });
  assert.equal(data.indices.length, 10);
  for (const item of data.indices) {
    assert.equal(item.date, '2026-09-30');
    assert.equal(item.current, 30);
    assert.equal(item.series.at(-1).pe, item.current);
    assert.equal(item.series[0].d, '2026-09-28');
  }
  assert.equal(data.indices.find(x => x.code === '399006').quality, 'tushare');
});

test('source outage, empty response and date regression preserve the published file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'valuation-test-'));
  const target = join(dir, 'valuation.json');
  const original = '{"lastGood":true}';
  await writeFile(target, original);
  try {
    for (const failing of [async () => { throw new Error('timeout'); }, async () => ({ code: 200, data: [] })]) {
      await assert.rejects(async () => publishSnapshot(target, await buildSnapshot({ token: 'fixture', end, request: failing })));
      assert.equal(await readFile(target, 'utf8'), original);
    }
    await assert.rejects(buildSnapshot({ token: 'fixture', end, request, previous: { indices: [{ code: '000001', date: '2026-10-01' }] } }), /regressed/);
    await assert.rejects(buildSnapshot({ token: 'fixture', end, request, previous: { indices: [{ code: '000001', date: '2026-09-29', series: [{ d: '2018-01-02', pe: 10 }] }] } }), /truncated/);
    assert.equal(await readFile(target, 'utf8'), original);
    await publishSnapshot(target, { lastGood: 'new' });
    assert.equal(await readFile(`${target}.previous`, 'utf8'), original);
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { lastGood: 'new' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
