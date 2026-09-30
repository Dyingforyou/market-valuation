from __future__ import annotations

import json
import re
import threading
from datetime import date
from pathlib import Path

import pandas as pd
import requests
import tushare as ts
from flask import Flask, jsonify, request
from pypinyin import Style, lazy_pinyin

ROOT = Path(__file__).resolve().parent
TOKEN = (ROOT / "tushare.txt").read_text(encoding="utf-8").strip()
if not TOKEN:
    raise RuntimeError("tushare.txt is empty")

pro = ts.pro_api(TOKEN)
app = Flask(__name__)
catalog_lock = threading.Lock()
catalog: list[dict] | None = None

INDEX_FALLBACK = {
    "000001.SH": "上证指数", "399001.SZ": "深证成指", "000300.SH": "沪深300",
    "000016.SH": "上证50", "000688.SH": "科创50", "399006.SZ": "创业板指",
    "000905.SH": "中证500", "000852.SH": "中证1000", "932000.CSI": "中证2000",
    "000510.SH": "中证A500",
}
BENCHMARK_INDEX = {
    "沪深300": "000300.SH", "上证50": "000016.SH", "科创50": "000688.SH",
    "创业板指": "399006.SZ", "中证500": "000905.SH", "中证1000": "000852.SH",
    "中证2000": "932000.CSI", "中证A500": "000510.SH", "深证成指": "399001.SZ",
}


def pinyin_initials(value: str) -> str:
    return "".join(lazy_pinyin(str(value or ""), style=Style.FIRST_LETTER)).lower()


def clean_records(df: pd.DataFrame, date_col: str, value_cols: list[str]) -> list[dict]:
    if df.empty:
        return []
    df = df.copy().sort_values(date_col)
    for col in value_cols:
        if col in df:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    # Float columns keep NaN when replacing directly; cast to object first so
    # Flask emits standards-compliant JSON null instead of JavaScript-invalid NaN.
    df = df.astype(object).where(pd.notna(df), None)
    rows = df.to_dict("records")
    if len(rows) > 1200:
        step = max(1, len(rows) // 1200)
        rows = rows[::step]
        if rows[-1][date_col] != df.iloc[-1][date_col]:
            last = df.iloc[-1].astype(object).where(pd.notna(df.iloc[-1]), None)
            rows.append(last.to_dict())
    return rows


def load_catalog() -> list[dict]:
    global catalog
    if catalog is not None:
        return catalog
    with catalog_lock:
        if catalog is not None:
            return catalog
        items: list[dict] = []
        stocks = pro.stock_basic(exchange="", list_status="L", fields="ts_code,symbol,name,industry")
        for x in stocks.to_dict("records"):
            items.append({"code": x["ts_code"], "symbol": x["symbol"], "name": x["name"], "initials": pinyin_initials(x["name"]), "type": "stock", "typeLabel": "个股", "extra": x.get("industry") or ""})
        funds = pro.fund_basic(market="E", status="L", fields="ts_code,name,fund_type,invest_type,benchmark")
        for x in funds.to_dict("records"):
            if "ETF" in str(x.get("fund_type", "")).upper() or "ETF" in str(x.get("name", "")).upper():
                items.append({"code": x["ts_code"], "symbol": x["ts_code"].split(".")[0], "name": x["name"], "initials": pinyin_initials(x["name"]), "type": "etf", "typeLabel": "ETF", "extra": x.get("benchmark") or ""})
        try:
            us_stocks = pro.us_basic(fields="ts_code,name,enname,classify,list_date")
            for x in us_stocks.to_dict("records"):
                symbol = str(x.get("ts_code", "")).upper()
                if symbol and re.fullmatch(r"[A-Z]{1,5}", symbol):
                    items.append({"code": symbol, "symbol": symbol, "name": x.get("name") or x.get("enname") or symbol, "initials": "", "type": "us_stock", "typeLabel": "美股", "extra": x.get("enname") or ""})
        except Exception:
            pass
        seen = set()
        for market in ("SSE", "SZSE", "CSI"):
            try:
                frame = pro.index_basic(market=market, fields="ts_code,name,fullname")
                for x in frame.to_dict("records"):
                    if x["ts_code"] not in seen:
                        seen.add(x["ts_code"])
                        items.append({"code": x["ts_code"], "symbol": x["ts_code"].split(".")[0], "name": x["name"], "initials": pinyin_initials(x["name"]), "type": "index", "typeLabel": "指数", "extra": x.get("fullname") or ""})
            except Exception:
                continue
        for code, name in INDEX_FALLBACK.items():
            if code not in seen:
                items.append({"code": code, "symbol": code.split(".")[0], "name": name, "initials": pinyin_initials(name), "type": "index", "typeLabel": "指数", "extra": ""})
        catalog = items
        return catalog


def fetch_index(code: str, start: str, end: str) -> tuple[list[dict], str]:
    frame = pro.index_dailybasic(ts_code=code, start_date=start, end_date=end, fields="ts_code,trade_date,pe,pe_ttm,pb")
    source = "Tushare index_dailybasic"
    if frame.empty:
        raw = code.split(".")[0]
        response = requests.get("https://www.csindex.com.cn/csindex-home/perf/index-perf", params={"indexCode": raw, "startDate": start, "endDate": end}, timeout=20)
        values = response.json().get("data") or []
        frame = pd.DataFrame([{"trade_date": x.get("tradeDate"), "pe_ttm": x.get("peg"), "pe": x.get("peg"), "pb": None} for x in values])
        source = "中证指数有限公司官网"
    return clean_records(frame, "trade_date", ["pe", "pe_ttm", "pb"]), source


def resolve_etf_index(benchmark: str) -> str | None:
    for label, code in BENCHMARK_INDEX.items():
        if label in benchmark:
            return code
    return None


@app.get("/health")
def health():
    return jsonify({"ok": True, "service": "market-valuation"})


@app.get("/search")
def search():
    query = request.args.get("q", "").strip().lower()
    if not query:
        return jsonify({"items": []})
    exact, fuzzy = [], []
    for item in load_catalog():
        text = f'{item["symbol"]} {item["code"]} {item["name"]} {item.get("initials", "")}'.lower()
        if query == item["symbol"].lower() or query == item["code"].lower() or query == item["name"].lower() or query == item.get("initials", ""):
            exact.append(item)
        elif query in text:
            fuzzy.append(item)
    return jsonify({"items": (exact + fuzzy)[:12]})


@app.get("/valuation")
def valuation():
    code = request.args.get("code", "").strip().upper()
    kind = request.args.get("type", "").strip().lower()
    years = max(1, min(30, int(request.args.get("years", 8))))
    end_year = date.today().year
    start_year = end_year - years
    item = next((x for x in load_catalog() if x["code"] == code and x["type"] == kind), None)
    if not item:
        return jsonify({"error": "未找到该证券代码"}), 404
    start, end = f"{start_year}0101", f"{end_year}1231"
    if kind == "us_stock":
        return jsonify({"error": "已识别为美股代码，但当前 Tushare Token 未开通美股日线/估值的单独权限"}), 403
    if kind == "stock":
        frame = pro.daily_basic(ts_code=code, start_date=start, end_date=end, fields="ts_code,trade_date,close,pe,pe_ttm,pb,ps_ttm,dv_ttm")
        rows = clean_records(frame, "trade_date", ["close", "pe", "pe_ttm", "pb", "ps_ttm", "dv_ttm"])
        metric, label, source = "pe_ttm", "PE-TTM", "Tushare daily_basic"
    elif kind == "index":
        rows, source = fetch_index(code, start, end)
        metric, label = "pe_ttm", "PE-TTM"
    elif kind == "etf":
        tracked = resolve_etf_index(item.get("extra", ""))
        if tracked:
            rows, source = fetch_index(tracked, start, end)
            metric, label = "pe_ttm", "底层指数 PE-TTM"
            item = {**item, "trackedIndex": tracked, "trackedLabel": next((v for k, v in INDEX_FALLBACK.items() if k == tracked), tracked)}
        else:
            frame = pro.fund_nav(ts_code=code, start_date=start, end_date=end, fields="ts_code,nav_date,unit_nav,accum_nav,adj_nav")
            rows = clean_records(frame, "nav_date", ["unit_nav", "accum_nav", "adj_nav"])
            for row in rows:
                row["trade_date"] = row.pop("nav_date")
            metric, label, source = "adj_nav", "复权单位净值", "Tushare fund_nav（无法识别底层指数，未展示PE）"
    else:
        return jsonify({"error": "不支持的证券类型"}), 400
    rows = [x for x in rows if x.get(metric) is not None and x.get(metric, 0) > 0]
    if not rows:
        return jsonify({"error": "所选年份没有可用数据"}), 404
    return jsonify({"instrument": item, "metric": metric, "metricLabel": label, "source": source, "years": years, "startYear": start_year, "endYear": end_year, "rows": rows})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8030, threaded=True)
