import * as echarts from 'echarts/core';
import { LineChart as ELineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, MarkLineComponent, GraphicComponent, DataZoomComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { createIcons, Search, RefreshCw, Database, Info, LineChart } from 'lucide';
import bundledData from './data/valuation.json';
import './styles.css';
import './lookup.css';
import './thresholds.css';

const fmt = v => v == null ? '—' : Number(v).toFixed(2);
const fmtDate = value => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const state = { selected: '000300', range: 8, query: '', sort: 'default', lookupText: '', lookupItems: [], lookupSelected: null, lookupResult: null, lookupLoading: false, lookupError: '' };
const app = document.querySelector('#app');
let chart;
let lookupChart;
let data = bundledData;
let refreshing = false;
let refreshError = '';
const API_BASE = '/market-valuation-api';
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
echarts.use([ELineChart, GridComponent, TooltipComponent, MarkLineComponent, GraphicComponent, DataZoomComponent, CanvasRenderer]);

function rangeSeries(item) {
  if (!item.series.length) return [];
  const cutoff = new Date(item.series.at(-1).d); cutoff.setFullYear(cutoff.getFullYear() - state.range);
  return item.series.filter(x => new Date(x.d) >= cutoff);
}
function stats(item) {
  const s = rangeSeries(item), vals = s.map(x => x.pe).sort((a,b)=>a-b), current = s.at(-1)?.pe ?? item.current;
  const q = p => vals.length ? vals[Math.floor((vals.length - 1) * p)] : null;
  return { current, reasonable:q(.5), low:q(.2), high:q(.8), pct: vals.length ? Math.round(vals.filter(v=>v<=current).length/vals.length*100) : null };
}
function thresholds(rows, metric){const vals=rows.map(x=>Number(x[metric])).filter(Number.isFinite).sort((a,b)=>a-b),q=p=>vals.length?vals[Math.floor((vals.length-1)*p)]:null;return{low:q(.2),reasonable:q(.5),high:q(.8)}}
function zone(p) { return p == null ? ['暂无趋势','neutral'] : p < 20 ? ['历史低位','low'] : p > 80 ? ['历史高位','high'] : ['历史中枢','fair']; }

function render() {
  const item = data.indices.find(x => x.code === state.selected) || data.indices[0];
  const st = stats(item), [label,tone] = zone(st.pct);
  app.innerHTML = `
    <header class="topbar"><a class="brand" href="#"><span class="brand-mark"><i data-lucide="line-chart"></i></span><span>A股估值温度计<small>MARKET VALUATION</small></span></a><div class="asof"><span class="live-dot"></span>数据截至 ${item.date}</div><button class="icon-button ${refreshing ? 'spinning' : ''}" id="refresh" aria-label="刷新数据" title="获取最新已发布数据" ${refreshing ? 'disabled' : ''}><i data-lucide="refresh-cw"></i></button></header>
    <main>
      ${refreshError ? `<p role="status" class="lookup-error">${esc(refreshError)}</p>` : ''}
      <section class="intro"><div><p class="eyebrow">CHINA A-SHARE · PE-TTM</p><h1>现在，市场贵不贵？</h1><p>把十个关键宽基放在同一把历史标尺上。估值不预测涨跌，只回答价格处在怎样的位置。</p></div><div class="trust"><i data-lucide="database"></i><div><b>可追溯数据</b><span>官网优先 · 来源逐项标注 · 口径透明</span></div></div></section>
      ${renderLookup()}
      <section class="overview-head"><div><h2>估值全景</h2><span>${data.indices.length} 个关键指数</span></div><label class="search"><i data-lucide="search"></i><input id="search" value="${state.query}" placeholder="筛选下方指数" aria-label="筛选下方指数"></label></section>
      <section class="cards" id="cards">${renderCards()}</section>
      <section class="detail">
        <div class="detail-head"><div><p class="eyebrow">${item.code} · ${item.segment}</p><h2>${item.name}<span class="tag ${tone}">${label}</span></h2><p>${item.series.length ? `当前 PE-TTM 为 ${fmt(st.current)} 倍，位于近 ${state.range} 年 ${st.pct}% 历史分位。` : `国证指数网当前快照为 ${fmt(item.current)} 倍；免费官方历史序列暂不可得，未使用估算值补齐。`}</p></div><div class="range" role="group" aria-label="时间范围">${[3,5,8].map(n=>`<button data-range="${n}" class="${state.range===n?'active':''}">${n}年</button>`).join('')}</div></div>
        <div class="metrics"><div><span>当前 PE</span><b>${fmt(st.current)}</b></div><div><span>20% · 历史低位</span><b>${fmt(st.low)}</b></div><div><span>50% · 历史中枢</span><b>${fmt(st.reasonable)}</b></div><div><span>80% · 历史高位</span><b>${fmt(st.high)}</b></div><div><span>历史分位</span><b>${st.pct == null ? '—' : st.pct+'%'}</b></div></div>
        <div id="chart" role="img" aria-label="${item.name}市盈率趋势图"></div>
        <div class="chart-note"><span><i class="dot pe"></i>PE-TTM 趋势</span><span><i class="dot lowline"></i>历史低位 · 20%</span><span><i class="dot mean"></i>历史中枢 · 50%</span><span><i class="dot highline"></i>历史高位 · 80%</span></div>
      </section>
      <section class="source-panel"><div><i data-lucide="info"></i><div><h3>数据口径与可信度</h3><p>统一展示滚动市盈率（PE-TTM）。中证系列直接调用中证指数有限公司官网；深证成指和创业板指使用 Tushare 历史序列。不同来源的估值口径可能存在差异。数据在收盘后定时更新，日期以各来源最新交易日为准。历史低位与历史高位是所选区间的 20% / 80% 历史分位，不代表投资结论。</p></div></div><a href="https://www.csindex.com.cn/" target="_blank" rel="noreferrer">访问中证指数官网 ↗</a></section>
    </main><footer>数据仅供研究，不构成投资建议 <span>·</span> 最近生成 ${new Date(data.generatedAt).toLocaleString('zh-CN',{hour12:false})}</footer>`;
  createIcons({icons:{Search,RefreshCw,Database,Info,LineChart}});
  bind(); draw(item, st); drawLookup();
}

function renderLookup() {
  const result = state.lookupResult;
  return `<section class="lookup-panel">
    <div class="lookup-copy"><p class="eyebrow">SECURITY LOOKUP</p><h2>查询任一个股、ETF 或指数</h2><p>输入名称或代码，选择年份范围，查看对应估值序列。</p></div>
    <div class="lookup-form">
      <div class="lookup-search-wrap"><label for="lookup-input">证券代码、名称或拼音首字母</label><div class="lookup-input"><i data-lucide="search"></i><input id="lookup-input" value="${esc(state.lookupText)}" placeholder="例如：600519、贵州茅台、gzmt、AAPL" autocomplete="off"></div><div id="lookup-results" class="lookup-results" ${state.lookupItems.length?'':'hidden'}>${lookupResultsHtml()}</div></div>
      <label class="year-field">查询近几年<input id="lookup-years" type="number" min="1" max="30" value="${result?.years ?? 8}"><small>从今年往前推</small></label>
      <button id="lookup-submit" class="lookup-submit" ${!state.lookupSelected||state.lookupLoading?'disabled':''}>${state.lookupLoading?'查询中…':'查询估值'}</button>
    </div>
    ${state.lookupSelected ? `<div class="selected-security"><span>${esc(state.lookupSelected.typeLabel)}</span><b>${esc(state.lookupSelected.name)}</b><small>${esc(state.lookupSelected.code)}</small></div>`:''}
    ${state.lookupError ? `<p class="lookup-error">${esc(state.lookupError)}</p>`:''}
    ${result ? (()=>{const t=thresholds(result.rows,result.metric);return `<div class="lookup-chart-head"><div><span>${esc(result.instrument.typeLabel)} · ${esc(result.instrument.code)}</span><h3>${esc(result.instrument.name)} — ${esc(result.metricLabel)}</h3><p>${esc(result.source)}${result.instrument.trackedIndex?` · 跟踪指数 ${esc(result.instrument.trackedLabel)}（${esc(result.instrument.trackedIndex)}）`:''}</p></div><div><b>${fmt(result.rows.at(-1)?.[result.metric])}</b><span>最新值</span></div></div><div class="threshold-strip"><div class="threshold-low"><span>20% · 历史低位</span><b>${fmt(t.low)}</b></div><div class="threshold-fair"><span>50% · 历史中枢</span><b>${fmt(t.reasonable)}</b></div><div class="threshold-high"><span>80% · 历史高位</span><b>${fmt(t.high)}</b></div></div><div id="lookup-chart" role="img" aria-label="${esc(result.instrument.name)}估值趋势"></div>`})():''}
  </section>`;
}

function renderCards() {
  let items = data.indices.filter(x => `${x.name}${x.code}`.toLowerCase().includes(state.query.toLowerCase()));
  return items.map(item => { const st=stats(item), [label,tone]=zone(st.pct), sourceLabel=item.quality==='official'?'官网':item.quality==='tushare'?'Tushare':'交叉验证'; return `<button class="index-card ${item.code===state.selected?'selected':''}" data-code="${item.code}"><div class="card-top"><span>${item.segment}</span><em class="${tone}">${label}</em></div><h3>${item.name}</h3><small>${item.code}</small><div class="pe"><b>${fmt(st.current)}</b><span>倍</span></div><div class="percentile"><span style="width:${st.pct ?? 0}%"></span></div><div class="card-foot"><span>${st.pct == null?'仅当前快照':`历史分位 ${st.pct}%`}</span><span class="source-quality ${item.quality}">${sourceLabel}</span></div></button>`}).join('') || '<p class="empty">没有匹配的指数</p>';
}
function bind() {
  document.querySelectorAll('[data-code]').forEach(el=>el.onclick=()=>{state.selected=el.dataset.code;render()});
  document.querySelectorAll('[data-range]').forEach(el=>el.onclick=()=>{state.range=Number(el.dataset.range);render()});
  document.querySelector('#search').oninput=e=>{state.query=e.target.value;document.querySelector('#cards').innerHTML=renderCards();bindCards()};
  document.querySelector('#refresh').onclick=refreshData;
  const lookupInput=document.querySelector('#lookup-input'); let lookupTimer;
  lookupInput.oninput=e=>{state.lookupText=e.target.value;state.lookupSelected=null;clearTimeout(lookupTimer);lookupTimer=setTimeout(()=>searchLookup(state.lookupText),250)};
  bindLookupResults();
  const submit=document.querySelector('#lookup-submit'); if(submit) submit.onclick=runLookup;
}

function lookupResultsHtml(){return state.lookupItems.map(x=>`<button data-lookup-code="${esc(x.code)}" data-lookup-type="${esc(x.type)}"><b>${esc(x.name)}</b><span>${esc(x.symbol)} · ${esc(x.typeLabel)}</span></button>`).join('')}
function updateLookupResults(){const el=document.querySelector('#lookup-results');if(!el)return;el.innerHTML=lookupResultsHtml();el.hidden=!state.lookupItems.length;bindLookupResults()}
function bindLookupResults(){document.querySelectorAll('[data-lookup-code]').forEach(el=>el.onclick=()=>{state.lookupSelected=state.lookupItems.find(x=>x.code===el.dataset.lookupCode&&x.type===el.dataset.lookupType);state.lookupText=state.lookupSelected?.name||state.lookupText;state.lookupItems=[];render()})}
async function readApiResponse(response){
  const text=await response.text();
  if(!text.trim())throw new Error(response.ok?'查询服务响应为空，请重试':`查询服务暂不可用（HTTP ${response.status}）`);
  try{return JSON.parse(text)}catch{throw new Error(`查询服务返回的数据不完整，请重试（HTTP ${response.status}）`)}
}
async function searchLookup(q){
  if(q.trim().length<2){state.lookupItems=[];updateLookupResults();return}
  try{const res=await fetch(`${API_BASE}/search?q=${encodeURIComponent(q.trim())}`);const body=await readApiResponse(res);if(!res.ok)throw new Error(body.error||`搜索失败（HTTP ${res.status}）`);if(q.trim()!==state.lookupText.trim())return;state.lookupItems=body.items||[];state.lookupError='';updateLookupResults()}catch(error){state.lookupError=error.message||'查询服务暂不可用';state.lookupItems=[];updateLookupResults()}
}
async function runLookup(){
  const years=document.querySelector('#lookup-years').value;state.lookupLoading=true;state.lookupError='';render();
  try{const params=new URLSearchParams({code:state.lookupSelected.code,type:state.lookupSelected.type,years});const res=await fetch(`${API_BASE}/valuation?${params}`);const body=await readApiResponse(res);if(!res.ok)throw new Error(body.error||`查询失败（HTTP ${res.status}）`);state.lookupResult=body}
  catch(error){state.lookupResult=null;state.lookupError=error.message}finally{state.lookupLoading=false;render()}
}
function bindCards(){document.querySelectorAll('[data-code]').forEach(el=>el.onclick=()=>{state.selected=el.dataset.code;render()})}
function draw(item, st) {
  chart?.dispose(); const el=document.querySelector('#chart'); chart=echarts.init(el); const s=rangeSeries(item);
  if(!s.length){chart.setOption({graphic:{type:'text',left:'center',top:'middle',style:{text:'暂无可信历史序列\n已保留官方当前快照',textAlign:'center',fill:'#64748b',font:'15px sans-serif',lineHeight:26}}});return}
  chart.setOption({animationDuration:500,grid:{left:58,right:34,top:26,bottom:92},tooltip:{trigger:'axis',backgroundColor:'#10233d',borderWidth:0,textStyle:{color:'#fff'},formatter:p=>`${fmtDate(p[0].axisValue)}<br/>PE-TTM　<b>${fmt(p[0].value[1])} 倍</b>`},dataZoom:[{type:'inside',xAxisIndex:0,filterMode:'filter',zoomOnMouseWheel:true,moveOnMouseMove:true,moveOnMouseWheel:false},{type:'slider',xAxisIndex:0,bottom:10,height:28,borderColor:'#d9e2ec',backgroundColor:'#f4f7fa',fillerColor:'rgba(35,116,216,.16)',dataBackground:{lineStyle:{color:'#8db7e8',width:1},areaStyle:{color:'rgba(35,116,216,.12)'}},selectedDataBackground:{lineStyle:{color:'#2374d8',width:1.5},areaStyle:{color:'rgba(35,116,216,.22)'}},handleStyle:{color:'#fff',borderColor:'#2374d8',borderWidth:2},moveHandleStyle:{color:'#2374d8'},textStyle:{color:'#64748b',fontSize:10},labelFormatter:value=>fmtDate(value),brushSelect:false}],xAxis:{type:'time',axisLine:{lineStyle:{color:'#cbd5e1'}},axisLabel:{color:'#64748b',formatter:value=>fmtDate(value)}},yAxis:{type:'value',name:'PE-TTM',scale:true,splitLine:{lineStyle:{color:'#e8edf3'}},axisLabel:{color:'#2374d8',formatter:'{value}x'}},series:[{name:'PE-TTM',type:'line',data:s.map(x=>[x.d,x.pe]),showSymbol:false,smooth:.18,lineStyle:{color:'#2374d8',width:2.5},areaStyle:{color:new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:'rgba(35,116,216,.12)'},{offset:1,color:'rgba(35,116,216,0)'}])},markLine:{symbol:'none',silent:true,label:{formatter:p=>`${p.name}  ${Number(p.value).toFixed(2)}`,position:'insideEndTop',fontSize:10,padding:[3,6],borderRadius:4},data:[{name:'历史低位 · 20%',yAxis:st.low,lineStyle:{color:'#23866b',type:'dashed',width:1.4},label:{color:'#17644f',backgroundColor:'#e3f3ee'}},{name:'历史中枢 · 50%',yAxis:st.reasonable,lineStyle:{color:'#d6a91c',type:'dashed',width:1.4},label:{color:'#7b5d05',backgroundColor:'#f7f0d7'}},{name:'历史高位 · 80%',yAxis:st.high,lineStyle:{color:'#d64b3d',type:'dashed',width:1.4},label:{color:'#9e3026',backgroundColor:'#f8e5e2'}}]}}]});
  window.addEventListener('resize',()=>chart.resize(),{once:true});
}
function drawLookup(){
  lookupChart?.dispose();const result=state.lookupResult,el=document.querySelector('#lookup-chart');if(!result||!el)return;lookupChart=echarts.init(el);const metric=result.metric,rows=result.rows,dataRows=rows.map(x=>[`${String(x.trade_date).slice(0,4)}-${String(x.trade_date).slice(4,6)}-${String(x.trade_date).slice(6,8)}`,x[metric]]),t=thresholds(rows,metric);
  lookupChart.setOption({grid:{left:58,right:34,top:30,bottom:92},tooltip:{trigger:'axis',backgroundColor:'#10233d',borderWidth:0,textStyle:{color:'#fff'},formatter:p=>`${fmtDate(p[0].axisValue)}<br/>${esc(result.metricLabel)}　<b>${fmt(p[0].value[1])}</b>`},dataZoom:[{type:'inside',xAxisIndex:0},{type:'slider',xAxisIndex:0,bottom:10,height:28,labelFormatter:value=>fmtDate(value),fillerColor:'rgba(35,116,216,.16)',borderColor:'#d9e2ec',handleStyle:{color:'#fff',borderColor:'#2374d8'}}],xAxis:{type:'time',axisLabel:{color:'#64748b',formatter:v=>fmtDate(v)}},yAxis:{type:'value',name:result.metricLabel,scale:true,axisLabel:{color:'#2374d8'},splitLine:{lineStyle:{color:'#e8edf3'}}},series:[{name:result.metricLabel,type:'line',data:dataRows,showSymbol:false,smooth:.12,lineStyle:{color:'#2374d8',width:2.4},areaStyle:{color:'rgba(35,116,216,.05)'},markLine:{symbol:'none',silent:true,label:{formatter:p=>`${p.name}  ${fmt(p.value)}`,position:'insideEndTop',fontSize:10,padding:[3,6],borderRadius:4},data:[{name:'历史低位 · 20%',yAxis:t.low,lineStyle:{color:'#23866b',type:'dashed',width:1.4},label:{color:'#17644f',backgroundColor:'#e3f3ee'}},{name:'历史中枢 · 50%',yAxis:t.reasonable,lineStyle:{color:'#d6a91c',type:'dashed',width:1.4},label:{color:'#7b5d05',backgroundColor:'#f7f0d7'}},{name:'历史高位 · 80%',yAxis:t.high,lineStyle:{color:'#d64b3d',type:'dashed',width:1.4},label:{color:'#9e3026',backgroundColor:'#f8e5e2'}}]}}]});window.addEventListener('resize',()=>lookupChart.resize(),{once:true})
}
async function refreshData() {
  if (refreshing) return;
  refreshing = true;
  refreshError = '';
  render();
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}data/valuation.json`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('数据服务暂不可用');
    const latest = await response.json();
    if (!latest.generatedAt || !Array.isArray(latest.indices) || latest.indices.length !== bundledData.indices.length || !bundledData.indices.every(old => latest.indices.some(item => item.code === old.code && Number.isFinite(item.current) && item.current > 0 && Array.isArray(item.series) && item.series.length && item.series.at(-1).d === item.date && item.series.at(-1).pe === item.current))) throw new Error('数据不完整');
    if (latest.indices.some(item => item.date < data.indices.find(old => old.code === item.code)?.date)) throw new Error('数据日期异常');
    data = latest;
  } catch {
    refreshError = '暂时无法获取最新数据，正在显示上一次有效数据；请稍后刷新。';
  } finally {
    refreshing = false;
    render();
  }
}
refreshData();
