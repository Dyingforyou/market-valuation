import { mkdir, writeFile, readFile } from 'node:fs/promises';

const START = '20180101';
const end = new Date().toISOString().slice(0, 10).replaceAll('-', '');
const CSI_URL = 'https://www.csindex.com.cn/csindex-home/perf/index-perf';
const CNI_URL = 'https://www.cnindex.com.cn/index/indexList?channelCode=-1&rows=2000&pageNum=1';

const indices = [
  ['000001', '上证指数', '全市场', '中证指数有限公司', 'official'],
  ['399001', '深证成指', '深市核心', 'Tushare index_dailybasic', 'tushare'],
  ['000300', '沪深300', '大盘', '中证指数有限公司', 'official'],
  ['000016', '上证50', '超大盘', '中证指数有限公司', 'official'],
  ['000688', '科创50', '科技成长', '中证指数有限公司', 'official'],
  ['399006', '创业板指', '成长', '海龟投资（源自公开指数数据）', 'secondary'],
  ['000905', '中证500', '中盘', '中证指数有限公司', 'official'],
  ['000852', '中证1000', '小盘', '中证指数有限公司', 'official'],
  ['932000', '中证2000', '微盘', '中证指数有限公司', 'official'],
  ['000510', '中证A500', '核心宽基', '中证指数有限公司', 'official']
];

const num = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
const iso = (s) => `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
const weekly = (rows) => rows.filter((_, i) => i === rows.length - 1 || i % 5 === 0);

async function csi(code) {
  const url = `${CSI_URL}?indexCode=${code}&startDate=${START}&endDate=${end}`;
  const json = await fetch(url, { headers: { Referer: 'https://www.csindex.com.cn/' } }).then(r => r.json());
  return weekly((json.data || []).map(x => ({ d: iso(x.tradeDate), pe: num(x.peg), close: num(x.close) })).filter(x => x.pe && x.pe > 0));
}

async function chinext() {
  const url = 'https://www.haiguitouzi.com/pages/api/csindex_daily.php?index_code=399006';
  const json = await fetch(url).then(r => r.json());
  return weekly((json.data || []).filter(x => x.trade_date >= '2018-01-01').map(x => ({ d: x.trade_date, pe: num(x.peg), close: num(x.close) })).filter(x => x.pe && x.pe > 0));
}

async function tushareIndex(code) {
  const token = (await readFile(new URL('../tushare.txt', import.meta.url), 'utf8')).trim();
  const suffix = code.startsWith('399') ? '.SZ' : '.SH';
  const json = await fetch('https://api.tushare.pro', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({api_name:'index_dailybasic',token,params:{ts_code:`${code}${suffix}`,start_date:START,end_date:end},fields:'ts_code,trade_date,pe,pe_ttm,pb'})}).then(r=>r.json());
  if (json.code !== 0) throw new Error(json.msg || 'Tushare request failed');
  const fields = json.data?.fields || [], rows = json.data?.items || [], ix = Object.fromEntries(fields.map((f,i)=>[f,i]));
  return weekly(rows.map(row=>({d:iso(String(row[ix.trade_date])),pe:num(row[ix.pe_ttm]),close:null})).filter(x=>x.pe&&x.pe>0).sort((a,b)=>a.d.localeCompare(b.d)));
}

const cniJson = await fetch(CNI_URL).then(r => r.json());
const cni = new Map((cniJson.data?.rows || []).map(x => [x.indexcode, x]));
const output = [];
for (const [code, name, segment, source, quality] of indices) {
  let series = [];
  try { series = quality === 'official' ? await csi(code) : quality === 'secondary' ? await chinext() : quality === 'tushare' ? await tushareIndex(code) : []; }
  catch (error) { console.warn(`${code} refresh failed: ${error.message}`); }
  const snap = cni.get(code);
  const current = series.at(-1)?.pe ?? num(snap?.peDynamic);
  const vals = series.map(x => x.pe);
  const sorted = [...vals].sort((a,b) => a-b);
  const q = p => sorted.length ? sorted[Math.floor((sorted.length - 1) * p)] : null;
  const percentile = sorted.length && current != null ? Math.round(sorted.filter(v => v <= current).length / sorted.length * 100) : null;
  output.push({ code, name, segment, source, quality, current, percentile, date: series.at(-1)?.d || cniJson.data?.date || '2026-08-28', mean: vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null, low: q(.2), high: q(.8), series });
  console.log(`${code} ${name}: ${series.length} points, PE ${current ?? 'N/A'}`);
}
await mkdir(new URL('../src/data/', import.meta.url), { recursive: true });
await writeFile(new URL('../src/data/valuation.json', import.meta.url), JSON.stringify({ generatedAt: new Date().toISOString(), methodology: 'PE-TTM；低估/高估线为所选区间20%/80%分位', indices: output }));
