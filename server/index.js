import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, extname } from "node:path";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.API_PORT || 8787);
const DATA_DIR = new URL("../data/processed/", import.meta.url);
const BACKTEST_DIR = new URL("../data/backtests/", import.meta.url);
const PARQUET_READER = new URL("./read_parquet.py", import.meta.url);
const PYTHON = process.env.PYTHON_BIN || new URL("../.venv/bin/python", import.meta.url).pathname;

function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(JSON.stringify(body));
}

async function jsonBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 5_000_000) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function parquet(command, fileName, options = {}) {
  if (!fileName.endsWith(".parquet") || fileName.includes("/") || fileName.includes("\\")) {
    throw new Error("非法 Parquet 文件名");
  }
  const args = [
    PARQUET_READER.pathname,
    command,
    new URL(fileName, DATA_DIR).pathname,
    JSON.stringify(options)
  ];
  const { stdout } = await execFileAsync(PYTHON, args, { maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function datasets() {
  const files = await readdir(DATA_DIR, { withFileTypes: true }).catch(() => []);
  return Promise.all(
    files
      .filter((file) => file.isFile() && extname(file.name) === ".parquet" && !file.name.startsWith("_"))
      .map(async (file) => {
        const info = await stat(new URL(file.name, DATA_DIR));
        const metadata = await parquet("metadata", file.name);
        return {
          id: file.name,
          label: basename(file.name, ".parquet"),
          bytes: info.size,
          modifiedAt: info.mtime.toISOString(),
          ...metadata
        };
      })
  );
}

function backtestFile(id) {
  if (!/^[a-f0-9-]+$/i.test(id)) throw new Error("非法回测 ID");
  return new URL(`${id}.json`, BACKTEST_DIR);
}

async function listBacktests() {
  await mkdir(BACKTEST_DIR, { recursive: true });
  const files = await readdir(BACKTEST_DIR, { withFileTypes: true });
  const sessions = await Promise.all(files.filter((file) => file.isFile() && file.name.endsWith(".json")).map(async (file) => {
    try {
      return JSON.parse(await readFile(new URL(file.name, BACKTEST_DIR), "utf8"));
    } catch {
      return null;
    }
  }));
  return sessions.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function saveBacktest(session) {
  await mkdir(BACKTEST_DIR, { recursive: true });
  await writeFile(backtestFile(session.id), JSON.stringify(session, null, 2), "utf8");
  return session;
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/api/datasets") return send(res, 200, await datasets());
    if (req.method === "GET" && url.pathname === "/api/bars") {
      const file = url.searchParams.get("file");
      if (!file) return send(res, 400, { error: "缺少 file 参数" });
      const from = Number(url.searchParams.get("from") || 0);
      const to = Number(url.searchParams.get("to") || Number.MAX_SAFE_INTEGER);
      const limit = Math.min(Number(url.searchParams.get("limit") || 20000), 300000);
      return send(res, 200, await parquet("bars", file, { from, to, limit }));
    }
    if (req.method === "GET" && url.pathname === "/api/backtests") return send(res, 200, await listBacktests());
    if (req.method === "POST" && url.pathname === "/api/backtests") {
      const body = await jsonBody(req);
      if (!body.strategyName || !body.datasetId || !body.startTime || !body.endTime || !body.initialCapital) {
        return send(res, 400, { error: "回测名称、数据集、起止时间和起始资金都必须填写" });
      }
      const accountType = body.accountType === "pf" ? "pf" : "normal";
      if (accountType === "pf" && (!(Number(body.pfMaxDrawdown) > 0) || !(Number(body.pfTarget) > 0))) {
        return send(res, 400, { error: "PF 账户必须填写最大回撤和考核目标" });
      }
      const now = new Date().toISOString();
      const session = {
        id: randomUUID(),
        strategyName: String(body.strategyName).trim(),
        strategies: [],
        datasetId: body.datasetId,
        startTime: Number(body.startTime),
        endTime: Number(body.endTime),
        initialCapital: Number(body.initialCapital),
        accountType,
        pfMaxDrawdown: accountType === "pf" ? Number(body.pfMaxDrawdown) : undefined,
        pfTarget: accountType === "pf" ? Number(body.pfTarget) : undefined,
        createdAt: now,
        updatedAt: now,
        progress: {
          cursor: 120, replayTime: null, position: null, trades: [], drawings: [],
          quantity: 1, stopDistance: 20, targetDistance: 40,
          emaEnabled: true, emaPeriod: 20, emaColor: "#f3c969", emaWidth: 2,
          vixRangeEnabled: true, vixInnerEnabled: true, vixOuterEnabled: true,
          vixInnerMultiplier: 0.5, vixOuterMultiplier: 0.8,
          priceActionEnabled: true, priceActionYshYsl: true, priceActionHtf: true,
          priceActionBarCount: true, priceActionAdaptive: true, priceActionStructure: true,
          timeframe: String(body.datasetId).includes("ohlcv-1s") ? "1s" : "1m", theme: "dark", pendingOrders: [], premarketNotes: [],
          pfState: {
            cycleStartTradeIndex: 0, payouts: [], resetCount: 0, cycles: [],
            currentCycleStartedAt: Number(body.startTime)
          }
        }
      };
      return send(res, 201, await saveBacktest(session));
    }
    const match = url.pathname.match(/^\/api\/backtests\/([a-f0-9-]+)$/i);
    if (match && req.method === "GET") {
      return send(res, 200, JSON.parse(await readFile(backtestFile(match[1]), "utf8")));
    }
    if (match && req.method === "PATCH") {
      const current = JSON.parse(await readFile(backtestFile(match[1]), "utf8"));
      const body = await jsonBody(req);
      const updated = {
        ...current,
        ...body,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
        progress: body.progress ? { ...current.progress, ...body.progress } : current.progress
      };
      return send(res, 200, await saveBacktest(updated));
    }
    send(res, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send(res, message.includes("ENOENT") ? 404 : 500, { error: message });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Replay Lab API: http://127.0.0.1:${PORT}`);
});
