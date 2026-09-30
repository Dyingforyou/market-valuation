# A股估值温度计

`npm ci && npm run build` 构建前端，入口为 `/market-valuation/`。

页面在打开及点击刷新时，以 `no-store` 读取 `data/valuation.json`。构建包包含一份有效数据作为网络故障时的备用数据，并显示实际数据日期和失败提示。定时更新独立的数据文件，不需要重新构建前端。

## 数据更新

服务器保留受控的 `tushare.txt`，不提交 Git。中证系列使用中证官方历史数据，深证成指及创业板指使用 Tushare `index_dailybasic` 的完整 PE-TTM 历史序列。所有序列先按日期排序，再抽样，并始终保留最新交易日。原始源的不同估值口径可能存在差异。

```bash
npm run refresh-data
node --test scripts/refresh-data.test.mjs
```

默认更新 `src/data/valuation.json`；生产任务设置 `VALUATION_OUTPUT_PATH=/var/www/html/market-valuation/data/valuation.json`。可通过 `TUSHARE_TOKEN_FILE` 指定现有凭据文件路径。全部十个指数成功且日期、历史覆盖范围没有倒退才原子替换数据；保留 `.previous` 备份。失败会返回非零状态并保留线上数据，详见 systemd 日志。

## 现有 ECS 部署

代码路径 `/home/admin/market-valuation`，前端目录 `/var/www/html/market-valuation`，查询 API 由原有 `market-valuation.service` 在 `127.0.0.1:8030` 运行。

发布前备份前端目录及运行数据，从 Git 拉取确定版本并构建。复制新 assets，最后替换 index.html；后续发布须保留较新的运行数据，避免用旧构建快照覆盖。不要删除仍可能被已打开页面引用的旧 assets。

首次安装更新任务时，创建归 admin 所有的前端 `data/` 目录，放入已验证的完整数据，然后安装 `deploy/` 下两个 systemd 文件：

```bash
sudo install -m 644 deploy/market-valuation-refresh.service deploy/market-valuation-refresh.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now market-valuation-refresh.timer
sudo systemctl start market-valuation-refresh.service
sudo journalctl -u market-valuation-refresh.service -n 30
```

北京时间工作日 16:30、18:30、22:30 更新，每天 08:30 重试延迟发布的数据。假日保留数据源最新交易日，不虚构当日数据。现有 Nginx 的 `/market-valuation/` 路由已设置 `Cache-Control: no-store`，无需修改其他项目路由或 API 服务。
