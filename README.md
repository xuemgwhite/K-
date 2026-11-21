# K Replay Lab

一个本地优先的 K 线回放与交易复盘工具。前端使用 React 和
[TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts)，后端按需读取本地 Parquet 行情文件。

> 本项目仅用于行情回放、策略研究和交易训练，不提供投资建议，也不连接真实交易账户。

## 功能

- 隐藏未来 K 线的逐根回放、自动播放和回退
- 1 秒、15 秒、1 分钟、2 分钟、5 分钟、15 分钟、1 小时、4 小时和日线聚合
- 双周期图表及同步品种对比
- 市价单、限价单、突破单、止损、止盈和分批平仓
- 普通账户与 PF 考核账户模拟
- EOD 回撤、静态回撤、考核周期、重置和模拟出金
- EMA、FVG、SMT、VIX 区间和 ICT 时段等辅助显示
- 矩形、斐波那契、水平射线、多空仓位和流动性标记
- 盘前分析、交易理由、策略标签和交易记录
- 胜率、保本率、盈亏比、利润因子、最大回撤、平均持仓时间与资金曲线
- 回测进度保存到本地 JSON，关闭页面后可继续
- 深色与浅色主题

## 隐私与数据

仓库不包含真实交易记录、个人回测存档、API Key 或付费行情数据。随仓库提供的
`DEMO_NQ_1m.parquet` 是随机生成的合成演示数据，不代表真实市场行情。

用户自己的文件分别保存在：

- `data/processed/`：Parquet 行情数据
- `data/backtests/`：本地回测存档
- `data/raw/`：可选的原始下载文件

这些目录中的个人文件默认被 Git 忽略。

## 环境要求

- Node.js 20+
- pnpm 9+
- Python 3.10+

## 快速开始

```bash
git clone https://github.com/xuemgwhite/K-.git
cd K-

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

pnpm install
pnpm run dev
```

打开 <http://127.0.0.1:5173>。

仓库已经包含一份小型合成数据，可以直接创建演示回测。也可以重新生成：

```bash
source .venv/bin/activate
python scripts/generate_demo_data.py
```

如果 Python 虚拟环境不在项目的 `.venv` 目录，可以为 API 服务指定解释器：

```bash
PYTHON_BIN=/path/to/python pnpm run dev
```

## 使用自己的 Parquet 数据

将文件放入 `data/processed/`。数据至少需要以下字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ts_event` | timestamp | 建议使用带 UTC 时区的时间戳 |
| `open` | number | 开盘价 |
| `high` | number | 最高价 |
| `low` | number | 最低价 |
| `close` | number | 收盘价 |
| `volume` | number | 成交量 |
| `symbol` | string | 可选，品种名称 |

服务会扫描所有不以 `_` 开头的 `.parquet` 文件。以 `_` 开头的文件可作为辅助数据，
例如 `_VIX_YAHOO_1d.parquet`。

## 可选：通过 Databento 下载

先复制环境变量模板：

```bash
cp .env.example .env
```

填写 `.env`：

```env
DATABENTO_API_KEY=db-your-key
DATABENTO_DATASET=GLBX.MDP3
DATABENTO_SYMBOL=NQ.c.0
DATABENTO_START=2025-01-02
DATABENTO_END=2025-02-01
DATABENTO_SCHEMA=ohlcv-1m
```

然后执行：

```bash
source .venv/bin/activate
pnpm run download:data
```

API Key 只由本地下载脚本读取，不会发送给浏览器。请勿提交 `.env`。使用和分发市场数据前，请确认数据供应商及交易所的许可条款。

## 常用命令

```bash
pnpm run dev          # 同时启动前端和 API
pnpm run dev:web      # 只启动前端
pnpm run dev:api      # 只启动 API
pnpm run build        # 类型检查并构建生产版本
pnpm run download:data
```

默认地址：

- 前端：<http://127.0.0.1:5173>
- API：<http://127.0.0.1:8787>

## 回测模型说明

- 当前是 K 线级模拟器，不是逐笔撮合引擎。
- 同一根 K 线同时触及止损与止盈时，采用保守规则，优先判定止损。
- 连续合约换月、滑点、手续费和流动性影响需由使用者按自己的场景评估。
- 回放不会连接券商，也不会发送真实订单。

## 项目结构

```text
src/                 React 前端与图表交互
server/              本地 API 与 Parquet 分段读取
scripts/             演示数据和可选下载脚本
data/processed/      本地行情数据（默认忽略）
data/backtests/      本地回测存档（默认忽略）
```

## 安全提示

- 不要把 `.env`、API Key、真实交易记录或购买的行情文件提交到公开仓库。
- 发布或共享行情数据前，确认自己拥有相应的展示与再分发权利。
- 如果曾经把密钥提交到 Git 历史中，仅删除文件并不够，还需要吊销并重新生成密钥。
