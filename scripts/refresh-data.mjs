import { mkdir, writeFile, readFile, rename, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const START = '20180101';
const CSI_URL = 'https://www.csindex.com.cn/csindex-home/perf/index-perf';
const indices = [
  ['000001', '上证指数', '全市场', 'official'],
  ['399001', '深证成指', '深市核心', 'tushare'],
  ['000300', '沪深300', '大盘', 'official'],
  ['000016', '上证50', '超大盘', 'official'],
  ['000688', '科创50', '科技成长', 'official'],
  ['399006', '创业板指', '成长', 'tushare'],
  ['000905', '中证500', '中盘', 'official'],
  ['000852', '中证1000', '小盘', 'official'],
  ['932000', '中证2000', '微盘', 'official'],
  ['000510', '中证A500', '核心宽基', 'official']
];

const num = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const iso = value => String(value).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');

export function weekly(rows, end) {
  const clean = [...new Map(rows.filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.d) && x.d >= '2018-01-01' && x.d <= iso(end) && Number.isFinite(x.pe) && x.pe > 0).map(x => [x.d, x])).values()].sort((a, b) => a.d.localeCompare(b.d));
  return clean.filter((_, i) => i % 5 === 0 || i === clean.length - 1);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Data source returned HTTP ${response.status}`);
  return response.json();
}

export async function buildSnapshot({ token, previous, end, request = requestJson }) {
  const output = [];
  for (const [code, name, segment, quality] of indices) {
    let rows;
    if (quality === 'official') {
      const json = await request(`${CSI_URL}?indexCode=${code}&startDate=${START}&endDate=${end}`, { headers: { Referer: 'https://www.csindex.com.cn/' } });
      if (String(json.code) !== '200' || !Array.isArray(json.data)) throw new Error(`${code}: invalid CSI response`);
      rows = json.data.map(x => ({ d: iso(x.tradeDate), pe: num(x.peg), close: num(x.close) }));
    } else {
      const json = await request('https://api.tushare.pro', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_name: 'index_dailybasic', token, params: { ts_code: `${code}.SZ`, start_date: START, end_date: end }, fields: 'ts_code,trade_date,pe,pe_ttm,pb' }) });
      if (json.code !== 0 || !Array.isArray(json.data?.items)) throw new Error(`${code}: Tushare request failed (code ${json.code})`);
      const ix = Object.fromEntries((json.data.fields || []).map((f, i) => [f, i]));
      rows = json.data.items.map(x => ({ d: iso(x[ix.trade_date]), pe: num(x[ix.pe_ttm]), close: null }));
    }
    const series = weekly(rows, end);
    const latest = series.at(-1);
    const old = previous?.indices?.find(x => x.code === code);
    if (!latest) throw new Error(`${code}: no valid PE-TTM history; keeping previous data`);
    if (old?.date && latest.d < old.date) throw new Error(`${code}: data date regressed to ${latest.d}; keeping previous data`);
    if (old?.series?.length && series[0].d > old.series[0].d) throw new Error(`${code}: history was truncated; keeping previous data`);
    const vals = series.map(x => x.pe), sorted = [...vals].sort((a, b) => a - b);
    const q = p => sorted[Math.floor((sorted.length - 1) * p)];
    output.push({ code, name, segment, source: quality === 'official' ? '中证指数有限公司' : 'Tushare index_dailybasic', quality, current: latest.pe, percentile: Math.round(sorted.filter(v => v <= latest.pe).length / sorted.length * 100), date: latest.d, mean: vals.reduce((a, b) => a + b, 0) / vals.length, low: q(.2), high: q(.8), series });
    console.log(`${code} ${name}: ${series.length} points, ${latest.d}, PE ${latest.pe}`);
  }
  return { generatedAt: new Date().toISOString(), methodology: 'PE-TTM；低估/高估线为所选区间20%/80%分位', indices: output };
}

export async function publishSnapshot(target, snapshot) {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o644 });
  try { await copyFile(target, `${target}.previous`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await rename(temporary, target);
}

async function main() {
  const target = resolve(process.env.VALUATION_OUTPUT_PATH || `${ROOT}/src/data/valuation.json`);
  const token = (await readFile(process.env.TUSHARE_TOKEN_FILE || `${ROOT}/tushare.txt`, 'utf8')).trim();
  if (!token) throw new Error('Tushare token is empty');
  let previous;
  try { previous = JSON.parse(await readFile(target, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const end = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '');
  const snapshot = await buildSnapshot({ token, previous, end });
  await publishSnapshot(target, snapshot);
  console.log(`Published ${snapshot.indices.length} indices to ${target}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Refresh failed: ${error.message}`); process.exitCode = 1; });
}
