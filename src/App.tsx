import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  HistogramSeries,
  LineSeries,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp
} from "lightweight-charts";
import type { BacktestSession, Bar, Dataset, PendingOrder, PFCycleRecord, PFState, Position, PremarketNote, Side, Strategy, Timeframe, Trade } from "./types";
import DrawingOverlay, { type Drawing, type RayDirection, type Tool } from "./DrawingOverlay";

const INITIAL_BARS = 120;
const TIMEFRAME_SECONDS: Record<Timeframe, number> = { "1s": 1, "15s": 15, "1m": 60, "2m": 120, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

function contractPointValue(dataset: string) {
  if (dataset.startsWith("ES_")) return 50;
  if (dataset.startsWith("MNQ_")) return 2;
  if (dataset.startsWith("MGC_")) return 10;
  if (dataset.toUpperCase().startsWith("XAUUSD")) return 100;
  return 1;
}

function quantityStep(dataset: string) {
  return dataset.toUpperCase().startsWith("XAUUSD") ? 0.01 : 1;
}

function normalizeQuantity(value: number, dataset: string) {
  const step = quantityStep(dataset);
  const normalized = Math.round((Number.isFinite(value) ? value : step) / step) * step;
  return Number(Math.max(step, normalized).toFixed(step < 1 ? 2 : 0));
}

function displayQuantity(value: number) {
  return Number(value.toFixed(2)).toString();
}

function aggregateBars(source: Bar[], timeframe: Timeframe) {
  const seconds = TIMEFRAME_SECONDS[timeframe];
  if (!source.length) return source;
  const result: Bar[] = [];
  for (const bar of source) {
    const bucket = Math.floor(bar.time / seconds) * seconds;
    const last = result[result.length - 1];
    if (!last || last.time !== bucket) {
      result.push({ ...bar, time: bucket });
    } else {
      last.high = Math.max(last.high, bar.high);
      last.low = Math.min(last.low, bar.low);
      last.close = bar.close;
      last.volume += bar.volume;
    }
  }
  return result;
}

function upperBoundBarTime(source: Bar[], time: number) {
  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (source[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function sixMonthsBefore(unix: number) {
  const date = new Date(unix * 1000);
  date.setUTCMonth(date.getUTCMonth() - 6);
  return Math.floor(date.getTime() / 1000);
}

function oneMonthBefore(unix: number) {
  const date = new Date(unix * 1000);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return Math.floor(date.getTime() / 1000);
}

function tradingDaysBefore(unix: number, count: number) {
  const date = new Date(unix * 1000);
  let remaining = count;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() - 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return Math.floor(date.getTime() / 1000);
}

function newYorkTradingDate(unix?: number | null) {
  if (!unix) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(unix * 1000));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function pfTradingDate(unix?: number | null) {
  if (!unix) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(unix * 1000));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const base = Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day));
  const tradingDay = Number(value.hour) >= 17 ? base + 86_400_000 : base;
  return new Date(tradingDay).toISOString().slice(0, 10);
}

function pfTradingDaysElapsed(startedAt?: number | null, endedAt?: number | null) {
  if (!startedAt || !endedAt) return 0;
  const startKey = pfTradingDate(startedAt);
  const endKey = pfTradingDate(Math.max(startedAt, endedAt));
  if (!startKey || !endKey) return 0;
  const cursor = new Date(`${startKey}T12:00:00Z`);
  const end = new Date(`${endKey}T12:00:00Z`);
  let days = 0;
  while (cursor <= end) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return Math.max(1, days);
}

function formatPrice(value?: number) {
  return value == null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatDate(time?: number) {
  return time ? new Date(time * 1000).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false
  }) : "—";
}

function formatDateWithWeekday(time?: number) {
  return time ? new Date(time * 1000).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }) : "—";
}

function tradingDateWeekday(tradingDate: string) {
  if (!tradingDate) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "UTC", weekday: "long"
  }).format(new Date(`${tradingDate}T12:00:00Z`));
}

function chartTimeDate(time: Time) {
  if (typeof time === "number") return new Date(time * 1000);
  if (typeof time === "string") return new Date(`${time}T00:00:00Z`);
  return new Date(Date.UTC(time.year, time.month - 1, time.day));
}

function chartTimeParts(time: Time) {
  return Object.fromEntries(new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(chartTimeDate(time)).map((part) => [part.type, part.value]));
}

function formatChartTime(time: Time) {
  const value = chartTimeParts(time);
  return `${value.year}/${value.month}/${value.day} ${value.weekday} ${value.hour}:${value.minute}`;
}

function formatChartTick(time: Time, tickMarkType: TickMarkType) {
  const value = chartTimeParts(time);
  if (tickMarkType === TickMarkType.Year) return value.year;
  if (tickMarkType === TickMarkType.Month) return `${value.year}/${value.month}`;
  if (tickMarkType === TickMarkType.DayOfMonth) return `${value.month}/${value.day}`;
  return `${value.hour}:${value.minute}`;
}

function calculateTradeStats(trades: Trade[], initialCapital: number) {
  const breakEvens = trades.filter((trade) => trade.isBreakEven);
  const wins = trades.filter((trade) => !trade.isBreakEven && trade.pnl > 0);
  const losses = trades.filter((trade) => !trade.isBreakEven && trade.pnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  const net = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const averageWin = wins.length ? grossProfit / wins.length : 0;
  const averageLoss = losses.length ? grossLoss / losses.length : 0;
  let runningEquity = initialCapital;
  let peakEquity = initialCapital;
  let maxDrawdown = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let winStreak = 0;
  let lossStreak = 0;
  trades.forEach((trade) => {
    runningEquity += trade.pnl;
    peakEquity = Math.max(peakEquity, runningEquity);
    maxDrawdown = Math.max(maxDrawdown, peakEquity - runningEquity);
    winStreak = !trade.isBreakEven && trade.pnl > 0 ? winStreak + 1 : 0;
    lossStreak = !trade.isBreakEven && trade.pnl < 0 ? lossStreak + 1 : 0;
    maxWinStreak = Math.max(maxWinStreak, winStreak);
    maxLossStreak = Math.max(maxLossStreak, lossStreak);
  });
  return {
    count: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakEvens: breakEvens.length,
    breakEvenRate: trades.length ? (breakEvens.length / trades.length) * 100 : 0,
    net,
    returnPct: initialCapital ? (net / initialCapital) * 100 : 0,
    winRate: wins.length + losses.length ? (wins.length / (wins.length + losses.length)) * 100 : 0,
    payoffRatio: averageLoss ? averageWin / averageLoss : averageWin ? Infinity : 0,
    profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit ? Infinity : 0,
    expectancy: trades.length ? net / trades.length : 0,
    averageHoldSeconds: trades.length
      ? trades.reduce((sum, trade) => sum + Math.max(0, trade.closedAt - trade.openedAt), 0) / trades.length
      : 0,
    averageWin,
    averageLoss,
    maxDrawdown,
    maxDrawdownPct: initialCapital ? (maxDrawdown / initialCapital) * 100 : 0,
    maxWinStreak,
    maxLossStreak
  };
}

function calculatePFStatus(session: BacktestSession | null, trades: Trade[], state: PFState, currentTime?: number | null) {
  if (!session || session.accountType !== "pf") return null;
  const initial = session.initialCapital;
  const maxDrawdown = session.pfMaxDrawdown || 0;
  const target = session.pfTarget || 0;
  const cycleTrades = trades.slice(state.cycleStartTradeIndex).sort((a, b) => a.closedAt - b.closedAt);
  let balance = initial;
  let peakEod = initial;
  let drawdownFloor = initial - maxDrawdown;
  let maxBalance = initial;
  let busted = false;
  let qualified = false;
  let staticDrawdown = false;
  const cycleStartedAt = state.currentCycleStartedAt
    || (state.cycleStartTradeIndex === 0 ? session.startTime : cycleTrades[0]?.openedAt)
    || null;
  let qualifiedAt: number | null = null;
  let tradingDate = "";
  for (const trade of cycleTrades) {
    const date = pfTradingDate(trade.closedAt);
    if (tradingDate && date !== tradingDate) {
      peakEod = Math.max(peakEod, balance);
      if (!staticDrawdown) {
        if (peakEod >= initial + maxDrawdown + 100) {
          staticDrawdown = true;
          drawdownFloor = initial + 100;
        } else {
          drawdownFloor = peakEod - maxDrawdown;
        }
      }
    }
    tradingDate = date;
    balance += trade.pnl;
    maxBalance = Math.max(maxBalance, balance);
    if (!qualified && maxBalance >= initial + target) {
      qualified = true;
      qualifiedAt = trade.closedAt;
    }
    if (balance <= drawdownFloor) busted = true;
  }
  const payoutTotal = state.payouts.reduce((sum, payout) => sum + payout.amount, 0);
  balance -= payoutTotal;
  return {
    balance,
    drawdownFloor,
    drawdownRemaining: balance - drawdownFloor,
    qualified,
    busted,
    staticDrawdown,
    payoutTotal,
    availablePayout: qualified ? Math.max(0, balance - initial) : 0,
    targetRemaining: Math.max(0, initial + target - maxBalance),
    cycleTradeCount: cycleTrades.length,
    cycleStartedAt,
    qualifiedAt,
    elapsedDays: cycleStartedAt == null ? 0 : pfTradingDaysElapsed(
      cycleStartedAt,
      qualifiedAt || currentTime || cycleTrades[cycleTrades.length - 1]?.closedAt || cycleStartedAt
    )
  };
}

function historicalPFCycleDays(session: BacktestSession, trades: Trade[], cycle: PFCycleRecord) {
  if (cycle.status !== "qualified") return null;
  const cycleTrades = trades
    .slice(cycle.startedAtTradeIndex, cycle.endedAtTradeIndex)
    .sort((a, b) => a.closedAt - b.closedAt);
  const startedAt = cycle.startedAt
    || (cycle.startedAtTradeIndex === 0 ? session.startTime : cycleTrades[0]?.openedAt);
  if (!startedAt) return cycle.daysToQualify || null;
  let balance = session.initialCapital;
  const targetBalance = session.initialCapital + (session.pfTarget || 0);
  for (const trade of cycleTrades) {
    balance += trade.pnl;
    if (balance >= targetBalance) {
      return pfTradingDaysElapsed(startedAt, trade.closedAt);
    }
  }
  return cycle.daysToQualify || null;
}

function formatRatio(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : "∞";
}

function formatDuration(seconds: number) {
  if (!seconds) return "—";
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    return minutes ? `${hours}小时 ${minutes}分` : `${hours}小时`;
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.round((seconds % 86400) / 3600);
  return hours ? `${days}天 ${hours}小时` : `${days}天`;
}

function EquityCurve({ trades, initialCapital }: { trades: Trade[]; initialCapital: number }) {
  const ordered = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  let equity = initialCapital;
  const values = [initialCapital, ...ordered.map((trade) => {
    equity += trade.pnl;
    return equity;
  })];
  const width = 700;
  const height = 190;
  const padding = { left: 8, right: 8, top: 14, bottom: 20 };
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(1, maximum - minimum);
  const x = (index: number) => padding.left + (index / Math.max(1, values.length - 1)) * (width - padding.left - padding.right);
  const y = (value: number) => padding.top + ((maximum - value) / range) * (height - padding.top - padding.bottom);
  const points = values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  const area = `${padding.left},${height - padding.bottom} ${points} ${x(values.length - 1)},${height - padding.bottom}`;
  const positive = values[values.length - 1] >= initialCapital;
  return <section className="equity-card">
    <div className="equity-card-head">
      <span><small>ACCOUNT EQUITY</small><b>账户权益曲线</b></span>
      <span><small>最低 / 最高</small><b>{formatPrice(minimum)} / {formatPrice(maximum)}</b></span>
      <span><small>当前权益</small><b className={positive ? "positive" : "negative"}>{formatPrice(values[values.length - 1])}</b></span>
    </div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="账户权益折线图">
      {[0, .25, .5, .75, 1].map((ratio) => <line key={ratio} x1={padding.left} x2={width - padding.right}
        y1={padding.top + ratio * (height - padding.top - padding.bottom)}
        y2={padding.top + ratio * (height - padding.top - padding.bottom)} />)}
      <polygon points={area} className={positive ? "positive" : "negative"} />
      <polyline points={points} className={positive ? "positive" : "negative"} />
      {values.map((value, index) => <circle key={index} cx={x(index)} cy={y(value)} r={index === values.length - 1 ? 3.5 : 2} />)}
      <text x={padding.left} y={height - 4}>起始资金 {formatPrice(initialCapital)}</text>
      <text x={width - padding.right} y={height - 4} textAnchor="end">{ordered.length} 笔已完成交易</text>
    </svg>
  </section>;
}

function PFCycleCurve({ session, trades, title }: { session: BacktestSession; trades: Trade[]; title: string }) {
  const ordered = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  const initial = session.initialCapital;
  const maxDrawdown = session.pfMaxDrawdown || 0;
  let balance = initial;
  let peakEod = initial;
  let floor = initial - maxDrawdown;
  let isStatic = false;
  let tradingDate = "";
  const balances = [balance];
  const floors = [floor];
  for (const trade of ordered) {
    const date = pfTradingDate(trade.closedAt);
    if (tradingDate && date !== tradingDate) {
      peakEod = Math.max(peakEod, balance);
      if (!isStatic && peakEod >= initial + maxDrawdown + 100) {
        isStatic = true;
        floor = initial + 100;
      } else if (!isStatic) floor = peakEod - maxDrawdown;
    }
    tradingDate = date;
    balance += trade.pnl;
    balances.push(balance);
    floors.push(floor);
  }
  const width = 620, height = 160, top = 12, bottom = 22;
  const minimum = Math.min(...balances, ...floors);
  const maximum = Math.max(...balances, ...floors);
  const range = Math.max(1, maximum - minimum);
  const x = (index: number) => 10 + index / Math.max(1, balances.length - 1) * (width - 20);
  const y = (value: number) => top + (maximum - value) / range * (height - top - bottom);
  const balancePoints = balances.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  const floorPoints = floors.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  return <section className="pf-cycle-curve">
    <div className="pf-cycle-curve-head"><b>{title}</b><span className="balance">账户 {formatPrice(balance)}</span><span className="floor">回撤线 {formatPrice(floor)}</span></div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}账户余额和回撤线对比曲线`}>
      {[0, .5, 1].map((ratio) => <line className="grid" key={ratio} x1="10" x2={width - 10} y1={top + ratio * (height - top - bottom)} y2={top + ratio * (height - top - bottom)} />)}
      <polyline className="floor-line" points={floorPoints} /><polyline className="balance-line" points={balancePoints} />
      <text x="10" y={height - 5}>起点 {formatPrice(initial)}</text><text x={width - 10} y={height - 5} textAnchor="end">{ordered.length} 笔交易</text>
    </svg>
  </section>;
}

type SecondaryIndicatorSettings = {
  vixRangeEnabled: boolean; vixInnerEnabled: boolean; vixOuterEnabled: boolean; vixInnerMultiplier: number; vixOuterMultiplier: number;
  priceActionEnabled: boolean; priceActionYshYsl: boolean; priceActionHtf: boolean; priceActionBarCount: boolean; priceActionAdaptive: boolean; priceActionStructure: boolean;
  fvgEnabled: boolean; fvg5m: boolean; fvg15m: boolean; fvg1h: boolean; fvg4h: boolean; fvg1d: boolean; fvgShowLabels: boolean;
  smtEnabled: boolean; smt5m: boolean; smt15m: boolean; smt1h: boolean; smt4h: boolean;
  ictKillzonesEnabled: boolean; ictShowBoxes: boolean; ictShowPivots: boolean; ictShowMidpoints: boolean;
  ictAsia: boolean; ictLondon: boolean; ictNyam: boolean; ictNypm: boolean; ictDwm: boolean;
};

function SecondaryChart({ bars, sourceBars, smtOtherBars, vixBars, timeframe, theme, emaEnabled, emaPeriod, emaColor, emaWidth, indicators }: {
  bars: Bar[];
  sourceBars: Bar[];
  smtOtherBars: Bar[];
  vixBars: Bar[];
  timeframe: Timeframe;
  theme: "dark" | "light";
  emaEnabled: boolean;
  emaPeriod: number;
  emaColor: string;
  emaWidth: number;
  indicators: SecondaryIndicatorSettings;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const ema = useRef<ISeriesApi<"Line"> | null>(null);
  const [chartReady, setChartReady] = useState(0);
  const rendered = useRef<{ count: number; firstTime?: number; timeframe: Timeframe }>({ count: 0, timeframe });
  const emaState = useRef<{
    count: number; firstTime?: number; timeframe: Timeframe; period: number;
    lastEma: number; beforeLastEma: number;
  }>({ count: 0, timeframe, period: emaPeriod, lastEma: 0, beforeLastEma: 0 });
  const minuteSourceBars = useMemo(() => aggregateBars(sourceBars, "1m"), [sourceBars]);

  useEffect(() => {
    if (!host.current) return;
    const light = theme === "light";
    const next = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: light ? "#526071" : "#7e8a9a" },
      localization: { locale: "zh-CN", timeFormatter: formatChartTime },
      grid: { vertLines: { color: light ? "#edf0f4" : "#141c26" }, horzLines: { color: light ? "#edf0f4" : "#141c26" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: light ? "#d5dbe3" : "#25303e" },
      timeScale: { borderColor: light ? "#d5dbe3" : "#25303e", timeVisible: true, secondsVisible: false, tickMarkFormatter: formatChartTick }
    });
    candles.current = next.addSeries(CandlestickSeries, {
      upColor: "#049981", downColor: "#F23645", borderVisible: false,
      wickUpColor: "#049981", wickDownColor: "#F23645", priceLineVisible: false
    });
    volume.current = next.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" }, priceScaleId: "", lastValueVisible: false, priceLineVisible: false
    });
    volume.current.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    ema.current = next.addSeries(LineSeries, {
      color: emaColor, lineWidth: emaWidth as 1 | 2 | 3 | 4,
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false
    });
    chart.current = next;
    setChartReady((value) => value + 1);
    rendered.current = { count: 0, timeframe };
    emaState.current = { count: 0, timeframe, period: emaPeriod, lastEma: 0, beforeLastEma: 0 };
    return () => { next.remove(); chart.current = null; };
  }, []);

  useEffect(() => {
    const light = theme === "light";
    chart.current?.applyOptions({
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: light ? "#526071" : "#7e8a9a" },
      grid: { vertLines: { color: light ? "#edf0f4" : "#141c26" }, horzLines: { color: light ? "#edf0f4" : "#141c26" } },
      rightPriceScale: { borderColor: light ? "#d5dbe3" : "#25303e" },
      timeScale: { borderColor: light ? "#d5dbe3" : "#25303e" }
    });
  }, [theme]);

  useEffect(() => {
    if (!candles.current || !volume.current) return;
    const cached = rendered.current;
    const firstTime = bars[0]?.time;
    const incremental = cached.count > 0
      && cached.timeframe === timeframe
      && cached.firstTime === firstTime
      && bars.length >= cached.count
      && bars.length - cached.count <= 10;
    if (incremental) {
      bars.slice(Math.max(0, cached.count - 1)).forEach((bar) => {
        candles.current?.update({ ...bar, time: bar.time as UTCTimestamp });
        volume.current?.update({
          time: bar.time as UTCTimestamp, value: bar.volume,
          color: bar.close >= bar.open ? "#04998138" : "#F2364538"
        });
      });
    } else {
      candles.current.setData(bars.map((bar) => ({ ...bar, time: bar.time as UTCTimestamp })));
      volume.current.setData(bars.map((bar) => ({
        time: bar.time as UTCTimestamp, value: bar.volume,
        color: bar.close >= bar.open ? "#04998138" : "#F2364538"
      })));
      chart.current?.timeScale().scrollToPosition(10, false);
    }
    rendered.current = { count: bars.length, firstTime, timeframe };
  }, [bars, timeframe]);

  useEffect(() => {
    if (!ema.current) return;
    ema.current.applyOptions({ visible: emaEnabled, color: emaColor, lineWidth: emaWidth as 1 | 2 | 3 | 4 });
    if (!emaEnabled || bars.length < emaPeriod) {
      ema.current.setData([]);
      emaState.current.count = 0;
      return;
    }
    const alpha = 2 / (emaPeriod + 1);
    const cached = emaState.current;
    const canUpdate = cached.count >= emaPeriod
      && cached.firstTime === bars[0]?.time
      && cached.timeframe === timeframe
      && cached.period === emaPeriod
      && bars.length >= cached.count
      && bars.length - cached.count <= 10;
    if (canUpdate && bars.length === cached.count) {
      const bar = bars[bars.length - 1];
      const next = bar.close * alpha + cached.beforeLastEma * (1 - alpha);
      ema.current.update({ time: bar.time as UTCTimestamp, value: next });
      emaState.current = { ...cached, lastEma: next };
      return;
    }
    if (canUpdate && bars.length > cached.count) {
      let lastEma = cached.lastEma;
      let beforeLastEma = cached.beforeLastEma;
      bars.slice(cached.count).forEach((bar) => {
        beforeLastEma = lastEma;
        lastEma = bar.close * alpha + lastEma * (1 - alpha);
        ema.current?.update({ time: bar.time as UTCTimestamp, value: lastEma });
      });
      emaState.current = {
        count: bars.length, firstTime: bars[0]?.time, timeframe, period: emaPeriod,
        lastEma, beforeLastEma
      };
      return;
    }
    let value = 0;
    let beforeLastEma = 0;
    const values: { time: UTCTimestamp; value: number }[] = [];
    bars.forEach((bar, index) => {
      if (index < emaPeriod - 1) return;
      value = index === emaPeriod - 1
        ? bars.slice(0, emaPeriod).reduce((sum, item) => sum + item.close, 0) / emaPeriod
        : bar.close * alpha + value * (1 - alpha);
      if (index === bars.length - 2) beforeLastEma = value;
      values.push({ time: bar.time as UTCTimestamp, value });
    });
    ema.current.setData(values);
    emaState.current = {
      count: bars.length, firstTime: bars[0]?.time, timeframe, period: emaPeriod,
      lastEma: value, beforeLastEma
    };
  }, [bars, timeframe, emaEnabled, emaPeriod, emaColor, emaWidth]);

  const lastTime = bars[bars.length - 1]?.time;
  const sourceEnd = lastTime == null ? 0 : upperBoundBarTime(minuteSourceBars, lastTime);
  const indicatorSource = minuteSourceBars.slice(Math.max(0, sourceEnd - 12000), sourceEnd);
  const secondaryFvgSources = [
    { seconds: 300, bars: aggregateBars(indicatorSource, "5m") },
    { seconds: 900, bars: aggregateBars(indicatorSource, "15m") },
    { seconds: 3600, bars: aggregateBars(indicatorSource, "1h") },
    { seconds: 14400, bars: aggregateBars(indicatorSource, "4h") },
    { seconds: 86400, bars: aggregateBars(indicatorSource, "1d") }
  ];

  return <div ref={host} className="secondary-chart-host">
    <DrawingOverlay
      host={host.current} chart={chart.current} series={candles.current} tool="cursor" rayDirection="right"
      drawings={[]} onDrawingsChange={() => undefined} position={null} onPositionChange={() => undefined}
      onFinishTool={() => undefined} barInterval={TIMEFRAME_SECONDS[timeframe]} lastBarTime={lastTime}
      pendingOrders={[]} onPendingOrdersChange={() => undefined} currentPrice={bars[bars.length - 1]?.close}
      pointValue={1} quantityStep={1} orderQuantity={1} onClosePosition={() => undefined} onExecutePendingOrder={() => undefined}
      visibleBars={bars.slice(-5000)} clearSelectionSignal={chartReady} vixBars={vixBars}
      vixRangeEnabled={indicators.vixRangeEnabled} vixInnerEnabled={indicators.vixInnerEnabled}
      vixOuterEnabled={indicators.vixOuterEnabled} vixInnerMultiplier={indicators.vixInnerMultiplier} vixOuterMultiplier={indicators.vixOuterMultiplier}
      priceActionEnabled={indicators.priceActionEnabled} priceActionYshYsl={indicators.priceActionYshYsl}
      priceActionHtf={indicators.priceActionHtf} priceActionBarCount={indicators.priceActionBarCount}
      priceActionAdaptive={indicators.priceActionAdaptive} priceActionStructure={indicators.priceActionStructure}
      timeframeSeconds={TIMEFRAME_SECONDS[timeframe]} fvgBars={indicatorSource} fvgSourceBars={secondaryFvgSources}
      fvgEnabled={indicators.fvgEnabled} fvg5m={indicators.fvg5m} fvg15m={indicators.fvg15m}
      fvg1h={indicators.fvg1h} fvg4h={indicators.fvg4h} fvg1d={indicators.fvg1d} fvgShowLabels={indicators.fvgShowLabels}
      smtPrimaryBars={aggregateBars(indicatorSource, "1m")} smtOtherBars={smtOtherBars}
      smtEnabled={indicators.smtEnabled} smt5m={indicators.smt5m} smt15m={indicators.smt15m} smt1h={indicators.smt1h} smt4h={indicators.smt4h}
      ictKillzonesEnabled={indicators.ictKillzonesEnabled} ictShowBoxes={indicators.ictShowBoxes}
      ictShowPivots={indicators.ictShowPivots} ictShowMidpoints={indicators.ictShowMidpoints}
      ictAsia={indicators.ictAsia} ictLondon={indicators.ictLondon} ictNyam={indicators.ictNyam}
      ictNypm={indicators.ictNypm} ictDwm={indicators.ictDwm}
    />
  </div>;
}

export default function App() {
  const chartHost = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const emaRef = useRef<ISeriesApi<"Line"> | null>(null);
  const renderedBarsRef = useRef<{ count: number; firstTime?: number; timeframe: Timeframe }>({ count: 0, timeframe: "1m" });
  const emaStateRef = useRef<{
    count: number; firstTime?: number; timeframe: Timeframe; period: number;
    lastEma: number; beforeLastEma: number;
  }>({ count: 0, timeframe: "1m", period: 20, lastEma: 0, beforeLastEma: 0 });
  const playbackOffsetRef = useRef(10);
  const [chartReady, setChartReady] = useState(0);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [dataset, setDataset] = useState("");
  const [sourceBars, setSourceBars] = useState<Bar[]>([]);
  const [historyContextBars, setHistoryContextBars] = useState<Bar[]>([]);
  const [cursor, setCursor] = useState(0);
  const [replayTime, setReplayTime] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(300);
  const [quantity, setQuantity] = useState(1);
  const [closeQuantity, setCloseQuantity] = useState(1);
  const [stopDistance, setStopDistance] = useState(20);
  const [targetDistance, setTargetDistance] = useState(40);
  const [position, setPosition] = useState<Position | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [error, setError] = useState("");
  const [tool, setTool] = useState<Tool>("cursor");
  const [rayDirection, setRayDirection] = useState<RayDirection>("right");
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [emaEnabled, setEmaEnabled] = useState(true);
  const [emaPeriod, setEmaPeriod] = useState(20);
  const [emaColor, setEmaColor] = useState("#f3c969");
  const [emaWidth, setEmaWidth] = useState(2);
  const [vixBars, setVixBars] = useState<Bar[]>([]);
  const [vixRangeEnabled, setVixRangeEnabled] = useState(true);
  const [vixInnerEnabled, setVixInnerEnabled] = useState(true);
  const [vixOuterEnabled, setVixOuterEnabled] = useState(true);
  const [vixInnerMultiplier, setVixInnerMultiplier] = useState(0.5);
  const [vixOuterMultiplier, setVixOuterMultiplier] = useState(0.8);
  const [priceActionEnabled, setPriceActionEnabled] = useState(true);
  const [priceActionYshYsl, setPriceActionYshYsl] = useState(true);
  const [priceActionHtf, setPriceActionHtf] = useState(true);
  const [priceActionBarCount, setPriceActionBarCount] = useState(true);
  const [priceActionAdaptive, setPriceActionAdaptive] = useState(true);
  const [priceActionStructure, setPriceActionStructure] = useState(true);
  const [fvgEnabled, setFvgEnabled] = useState(true);
  const [fvg5m, setFvg5m] = useState(true);
  const [fvg15m, setFvg15m] = useState(true);
  const [fvg1h, setFvg1h] = useState(true);
  const [fvg4h, setFvg4h] = useState(true);
  const [fvg1d, setFvg1d] = useState(true);
  const [fvgShowLabels, setFvgShowLabels] = useState(true);
  const [fvgUseBodyFill, setFvgUseBodyFill] = useState(false);
  const [smtEnabled, setSmtEnabled] = useState(true);
  const [smt5m, setSmt5m] = useState(true);
  const [smt15m, setSmt15m] = useState(true);
  const [smt1h, setSmt1h] = useState(true);
  const [smt4h, setSmt4h] = useState(true);
  const [smtPair, setSmtPair] = useState<{ primaryFile: string; otherFile: string; from: number; to: number; primary: Bar[]; other: Bar[] } | null>(null);
  const [smtLoading, setSmtLoading] = useState(false);
  const [ictKillzonesEnabled, setIctKillzonesEnabled] = useState(true);
  const [ictShowBoxes, setIctShowBoxes] = useState(true);
  const [ictShowPivots, setIctShowPivots] = useState(true);
  const [ictShowMidpoints, setIctShowMidpoints] = useState(false);
  const [ictAsia, setIctAsia] = useState(true);
  const [ictLondon, setIctLondon] = useState(true);
  const [ictNyam, setIctNyam] = useState(true);
  const [ictNypm, setIctNypm] = useState(true);
  const [ictDwm, setIctDwm] = useState(true);
  const [sessions, setSessions] = useState<BacktestSession[]>([]);
  const [activeSession, setActiveSession] = useState<BacktestSession | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [timeframe, setTimeframe] = useState<Timeframe>("1m");
  const [dualChartEnabled, setDualChartEnabled] = useState(false);
  const [secondaryTimeframe, setSecondaryTimeframe] = useState<Timeframe>("1h");
  const [secondaryDataset, setSecondaryDataset] = useState("");
  const [secondaryDatasetWindow, setSecondaryDatasetWindow] = useState<{ file: string; from: number; to: number; bars: Bar[] } | null>(null);
  const [secondaryDatasetLoading, setSecondaryDatasetLoading] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [entryPrice, setEntryPrice] = useState(0);
  const [stopPrice, setStopPrice] = useState(0);
  const [targetPrice, setTargetPrice] = useState(0);
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([]);
  const [crosshairPrice, setCrosshairPrice] = useState<{ price: number; y: number; axisWidth: number } | null>(null);
  const [quickMenu, setQuickMenu] = useState(false);
  const [playbackStep, setPlaybackStep] = useState<"1s" | "15s" | "1m" | "2m" | "5m" | "15m" | "1h">("1m");
  const [premarketNotes, setPremarketNotes] = useState<PremarketNote[]>([]);
  const [clearDrawingSelection, setClearDrawingSelection] = useState(0);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [strategyManagerOpen, setStrategyManagerOpen] = useState(false);
  const [newStrategyName, setNewStrategyName] = useState("");
  const [pfState, setPfState] = useState<PFState>({ cycleStartTradeIndex: 0, payouts: [], resetCount: 0 });
  const [pfPanelOpen, setPfPanelOpen] = useState(false);
  const [payoutAmount, setPayoutAmount] = useState(0);
  const seekAfterTimeframe = useRef<number | null>(null);
  const positionRef = useRef<Position | null>(null);
  const replayHistory = useRef<Array<{
    replayTime: number | null; cursor: number; position: Position | null;
    pendingOrders: PendingOrder[]; trades: Trade[];
  }>>([]);

  const isSecondDataset = dataset.includes("ohlcv-1s");
  const chartSourceBars = useMemo(() => {
    if (!isSecondDataset || timeframe === "1s" || timeframe === "15s" || !historyContextBars.length) return sourceBars;
    const firstDetailedTime = sourceBars[0]?.time ?? Number.MAX_SAFE_INTEGER;
    return [...historyContextBars.filter((bar) => bar.time < firstDetailedTime), ...sourceBars];
  }, [historyContextBars, sourceBars, isSecondDataset, timeframe]);
  const secondarySourceBars = secondaryDataset && secondaryDataset !== dataset
    ? (secondaryDatasetWindow?.file === secondaryDataset ? secondaryDatasetWindow.bars : [])
    : (secondaryTimeframe === "1s" || secondaryTimeframe === "15s" ? sourceBars : chartSourceBars);
  const secondaryIsSecondDataset = (secondaryDataset || dataset).includes("ohlcv-1s");
  const sourceMinuteBars = useMemo(() => aggregateBars(sourceBars, "1m"), [sourceBars]);
  const bars = useMemo(() => aggregateBars(chartSourceBars, timeframe), [chartSourceBars, timeframe]);
  const visibleBars = useMemo(() => {
    const visible = bars.slice(0, cursor);
    if (!visible.length || replayTime == null || timeframe === "1s" || (!isSecondDataset && timeframe === "1m")) return visible;
    const bucketStart = Math.floor(replayTime / TIMEFRAME_SECONDS[timeframe]) * TIMEFRAME_SECONDS[timeframe];
    const partialSource = sourceBars.filter((bar) => bar.time >= bucketStart && bar.time <= replayTime);
    if (!partialSource.length) return visible;
    const partial = aggregateBars(partialSource, timeframe)[0];
    const last = visible[visible.length - 1];
    return last.time === bucketStart ? [...visible.slice(0, -1), partial] : visible;
  }, [bars, cursor, replayTime, timeframe, sourceBars, isSecondDataset]);
  const current = visibleBars[visibleBars.length - 1];
  const secondaryAggregatedBars = useMemo(
    () => aggregateBars(secondarySourceBars, secondaryTimeframe),
    [secondarySourceBars, secondaryTimeframe]
  );
  const secondaryBars = useMemo(() => {
    if (replayTime == null) return [];
    const end = upperBoundBarTime(secondaryAggregatedBars, replayTime);
    const visible = secondaryAggregatedBars.slice(0, end);
    if (!visible.length || secondaryTimeframe === "1s" || (!secondaryIsSecondDataset && secondaryTimeframe === "1m")) return visible;
    const bucketStart = Math.floor(replayTime / TIMEFRAME_SECONDS[secondaryTimeframe]) * TIMEFRAME_SECONDS[secondaryTimeframe];
    const sourceStart = upperBoundBarTime(secondarySourceBars, bucketStart - 1);
    const sourceEnd = upperBoundBarTime(secondarySourceBars, replayTime);
    const partial = aggregateBars(secondarySourceBars.slice(sourceStart, sourceEnd), secondaryTimeframe)[0];
    if (!partial) return visible;
    const last = visible[visible.length - 1];
    return last.time === bucketStart ? [...visible.slice(0, -1), partial] : visible;
  }, [secondaryAggregatedBars, secondarySourceBars, replayTime, secondaryTimeframe, secondaryIsSecondDataset]);
  const secondaryCurrent = secondaryBars[secondaryBars.length - 1];
  const secondarySmtOtherBars = useMemo(() => {
    if (replayTime == null) return [];
    const end = upperBoundBarTime(sourceBars, replayTime);
    return aggregateBars(sourceBars.slice(Math.max(0, end - 12000), end), "1m");
  }, [sourceBars, replayTime]);
  const overlayWindow = useMemo(() => visibleBars.slice(-5000), [visibleBars]);
  const overlayBars = useDeferredValue(overlayWindow);
  const fvgWindow = useMemo(() => {
    if (replayTime == null) return [];
    const end = upperBoundBarTime(sourceMinuteBars, replayTime);
    return sourceMinuteBars.slice(Math.max(0, end - 8000), end);
  }, [sourceMinuteBars, replayTime]);
  const fvgBars = useDeferredValue(fvgWindow);
  const fvgSourceBars = useMemo(() => ([
    { seconds: 300, bars: aggregateBars(sourceBars, "5m") },
    { seconds: 900, bars: aggregateBars(sourceBars, "15m") },
    { seconds: 3600, bars: aggregateBars(sourceBars, "1h") },
    { seconds: 14400, bars: aggregateBars(sourceBars, "4h") },
    { seconds: 86400, bars: aggregateBars(sourceBars, "1d") }
  ]), [sourceBars]);
  const smtPrimaryBars = useMemo(() => replayTime == null || !smtPair ? []
    : smtPair.primary.slice(0, upperBoundBarTime(smtPair.primary, replayTime)), [smtPair, replayTime]);
  const smtOtherBars = useMemo(() => replayTime == null || !smtPair ? []
    : smtPair.other.slice(0, upperBoundBarTime(smtPair.other, replayTime)), [smtPair, replayTime]);
  const currentDatasetInfo = datasets.find((item) => item.id === dataset);
  const smtPrimaryDataset = datasets.find((item) => item.symbol === currentDatasetInfo?.symbol && item.id.includes("ohlcv-1m"));
  const smtCompanion = datasets.find((item) => item.symbol === "MES.c.0" || item.id.startsWith("MES_c_0_ohlcv-1m_2022-01-01_2026-01-01"));
  const progress = bars.length ? Math.round((cursor / bars.length) * 100) : 0;

  useEffect(() => {
    Promise.all([fetch("/api/datasets").then((res) => res.json()), fetch("/api/backtests").then((res) => res.json())])
      .then(([items, saved]: [Dataset[], BacktestSession[]]) => {
        setDatasets(items);
        setSessions(saved);
      })
      .catch(() => setError("无法连接本地数据 API，请确认 npm run dev 正在运行。"));
  }, []);

  useEffect(() => {
    if (!isSecondDataset || replayTime == null || !sourceBars.length) {
      setHistoryContextBars([]);
      return;
    }
    const currentDataset = datasets.find((item) => item.id === dataset);
    const minuteDataset = datasets.find((item) => item.symbol === currentDataset?.symbol && item.id.includes("ohlcv-1m"));
    if (!minuteDataset) return;
    let cancelled = false;
    const from = oneMonthBefore(replayTime);
    const to = sourceBars[0].time - 1;
    if (to <= from) return;
    const query = new URLSearchParams({ file: minuteDataset.id, from: String(from), to: String(to), limit: "50000" });
    fetch(`/api/bars?${query}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "一个月历史背景读取失败");
        return body as { bars: Bar[] };
      })
      .then((result) => {
        if (cancelled) return;
        setHistoryContextBars(result.bars);
        const combined = [...result.bars, ...sourceBars];
        const displayBars = aggregateBars(combined, timeframe);
        const firstFuture = displayBars.findIndex((bar) => bar.time > replayTime);
        setCursor(firstFuture === -1 ? displayBars.length : Math.max(1, firstFuture));
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "一个月历史背景读取失败"); });
    return () => { cancelled = true; };
  }, [isSecondDataset, dataset, datasets, sourceBars[0]?.time, activeSession?.id]);

  useEffect(() => {
    if (!dualChartEnabled || !secondaryDataset || secondaryDataset === dataset || replayTime == null) {
      if (!secondaryDataset || secondaryDataset === dataset) setSecondaryDatasetWindow(null);
      return;
    }
    const secondData = secondaryDataset.includes("ohlcv-1s");
    const historySeconds = secondData ? 3 * 86400 : 21 * 86400;
    const futureSeconds = secondData ? 86400 : 7 * 86400;
    if (secondaryDatasetWindow?.file === secondaryDataset
      && replayTime >= secondaryDatasetWindow.from + historySeconds - 3600
      && replayTime <= secondaryDatasetWindow.to - 6 * 3600) return;
    let cancelled = false;
    const from = replayTime - historySeconds;
    const to = Math.min(activeSession?.endTime || replayTime + futureSeconds, replayTime + futureSeconds);
    const query = new URLSearchParams({
      file: secondaryDataset, from: String(from), to: String(to), limit: secondData ? "300000" : "50000"
    });
    setSecondaryDatasetLoading(true);
    fetch(`/api/bars?${query}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "同步品种数据读取失败");
        return body as { bars: Bar[] };
      })
      .then((result) => {
        if (!cancelled) setSecondaryDatasetWindow({ file: secondaryDataset, from, to, bars: result.bars });
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "同步品种数据读取失败"); })
      .finally(() => { if (!cancelled) setSecondaryDatasetLoading(false); });
    return () => { cancelled = true; };
  }, [dualChartEnabled, secondaryDataset, dataset, replayTime, activeSession?.endTime, secondaryDatasetWindow]);

  useEffect(() => {
    if (!smtEnabled || !dataset.startsWith("MNQ_") || !smtPrimaryDataset || !smtCompanion || replayTime == null) {
      if (!dataset.startsWith("MNQ_")) setSmtPair(null);
      return;
    }
    if (smtPair?.primaryFile === smtPrimaryDataset.id && smtPair.otherFile === smtCompanion.id
      && replayTime >= smtPair.from + 30 * 86400 && replayTime <= smtPair.to - 6 * 3600) return;
    let cancelled = false;
    const from = replayTime - 31 * 86400;
    const to = Math.min(activeSession?.endTime || replayTime + 2 * 86400, replayTime + 2 * 86400);
    const load = (file: string) => {
      const query = new URLSearchParams({ file, from: String(from), to: String(to), limit: "50000" });
      return fetch(`/api/bars?${query}`).then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "SMT 数据读取失败");
        return body.bars as Bar[];
      });
    };
    setSmtLoading(true);
    Promise.all([load(smtPrimaryDataset.id), load(smtCompanion.id)])
      .then(([primary, other]) => {
        if (!cancelled) setSmtPair({ primaryFile: smtPrimaryDataset.id, otherFile: smtCompanion.id, from, to, primary, other });
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "SMT 数据读取失败"); })
      .finally(() => { if (!cancelled) setSmtLoading(false); });
    return () => { cancelled = true; };
  }, [smtEnabled, dataset, smtPrimaryDataset?.id, smtCompanion?.id, replayTime, activeSession?.endTime, smtPair]);

  useEffect(() => {
    if (!dataset || !activeSession) return;
    let cancelled = false;
    setHistoryContextBars([]);
    setError("");
    const resumeTime = activeSession.progress.replayTime;
    const targetReplayTime = resumeTime || activeSession.startTime;
    const secondData = dataset.includes("ohlcv-1s");
    const loadFrom = secondData ? tradingDaysBefore(targetReplayTime, 2) : sixMonthsBefore(targetReplayTime);
    const fastFrom = secondData ? loadFrom : Math.max(loadFrom, targetReplayTime - 21 * 86400);
    const query = new URLSearchParams({
      file: dataset,
      from: String(fastFrom),
      to: String(activeSession.endTime),
      limit: secondData ? "300000" : "50000"
    });
    fetch(`/api/bars?${query}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "数据读取失败");
        return body;
      })
      .then((result: { bars: Bar[]; hasMore: boolean }) => {
        if (cancelled) return;
        setSourceBars(result.bars);
        setHasMore(result.hasMore);
        const progress = activeSession.progress;
        const selectedTimeframe = progress.timeframe || (secondData ? "1s" : "1m");
        const displayBars = aggregateBars(result.bars, selectedTimeframe);
        setTimeframe(selectedTimeframe);
        setPlaybackStep(secondData ? "1s" : "1m");
        setDualChartEnabled(progress.dualChartEnabled || false);
        setSecondaryTimeframe(progress.secondaryTimeframe || "1h");
        setSecondaryDataset(progress.secondaryDatasetId || "");
        setTheme(progress.theme || "dark");
        setPendingOrders(progress.pendingOrders || []);
        setPremarketNotes(progress.premarketNotes || []);
        setPfState(progress.pfState || { cycleStartTradeIndex: 0, payouts: [], resetCount: 0 });
        const firstFuture = displayBars.findIndex((bar) => bar.time > targetReplayTime);
        const resumedCursor = firstFuture === -1 ? displayBars.length : firstFuture;
        setCursor(Math.max(1, resumedCursor));
        setReplayTime(targetReplayTime);
        setPosition(progress.position);
        setTrades(progress.trades || []);
        setDrawings(progress.drawings || []);
        setQuantity(progress.quantity || 1);
        setStopDistance(progress.stopDistance || 20);
        setTargetDistance(progress.targetDistance || 40);
        setEmaEnabled(progress.emaEnabled ?? true);
        setEmaPeriod(progress.emaPeriod || 20);
        setEmaColor(progress.emaColor || "#f3c969");
        setEmaWidth(progress.emaWidth || 2);
        setVixRangeEnabled(progress.vixRangeEnabled ?? true);
        setVixInnerEnabled(progress.vixInnerEnabled ?? true);
        setVixOuterEnabled(progress.vixOuterEnabled ?? true);
        setVixInnerMultiplier(progress.vixInnerMultiplier ?? 0.5);
        setVixOuterMultiplier(progress.vixOuterMultiplier ?? 0.8);
        setPriceActionEnabled(progress.priceActionEnabled ?? true);
        setPriceActionYshYsl(progress.priceActionYshYsl ?? true);
        setPriceActionHtf(progress.priceActionHtf ?? true);
        setPriceActionBarCount(progress.priceActionBarCount ?? true);
        setPriceActionAdaptive(progress.priceActionAdaptive ?? true);
        setPriceActionStructure(progress.priceActionStructure ?? true);
        setFvgEnabled(progress.fvgEnabled ?? true);
        setFvg5m(progress.fvg5m ?? true);
        setFvg15m(progress.fvg15m ?? true);
        setFvg1h(progress.fvg1h ?? true);
        setFvg4h(progress.fvg4h ?? true);
        setFvg1d(progress.fvg1d ?? true);
        setFvgShowLabels(progress.fvgShowLabels ?? true);
        setFvgUseBodyFill(progress.fvgUseBodyFill ?? false);
        setSmtEnabled(progress.smtEnabled ?? true);
        setSmt5m(progress.smt5m ?? true);
        setSmt15m(progress.smt15m ?? true);
        setSmt1h(progress.smt1h ?? true);
        setSmt4h(progress.smt4h ?? true);
        setIctKillzonesEnabled(progress.ictKillzonesEnabled ?? true);
        setIctShowBoxes(progress.ictShowBoxes ?? true);
        setIctShowPivots(progress.ictShowPivots ?? true);
        setIctShowMidpoints(progress.ictShowMidpoints ?? false);
        setIctAsia(progress.ictAsia ?? true);
        setIctLondon(progress.ictLondon ?? true);
        setIctNyam(progress.ictNyam ?? true);
        setIctNypm(progress.ictNypm ?? true);
        setIctDwm(progress.ictDwm ?? true);
        setHydrated(true);

        if (fastFrom > loadFrom) {
          void (async () => {
            let from = loadFrom;
            const history: Bar[] = [];
            while (!cancelled && from < fastFrom) {
              const historyQuery = new URLSearchParams({
                file: dataset,
                from: String(from),
                to: String(fastFrom - 1),
                limit: "50000"
              });
              const response = await fetch(`/api/bars?${historyQuery}`);
              const body = await response.json();
              if (!response.ok) throw new Error(body.error || "历史背景数据读取失败");
              const page = body as { bars: Bar[]; hasMore: boolean };
              if (!page.bars.length) break;
              history.push(...page.bars);
              from = page.bars[page.bars.length - 1].time + 1;
              if (!page.hasMore) break;
            }
            if (cancelled || !history.length) return;
            const selectedTimeframe = progress.timeframe || "1m";
            setSourceBars((currentBars) => {
              const firstCurrent = currentBars[0]?.time ?? Number.MAX_SAFE_INTEGER;
              const combined = [...history.filter((bar) => bar.time < firstCurrent), ...currentBars];
              const displayBars = aggregateBars(combined, selectedTimeframe);
              const firstFuture = displayBars.findIndex((bar) => bar.time > targetReplayTime);
              setCursor(firstFuture === -1 ? displayBars.length : Math.max(1, firstFuture));
              return combined;
            });
          })().catch((err) => {
            if (!cancelled) setError(err.message);
          });
        }
      })
      .catch((err) => setError(err.message));
    return () => { cancelled = true; };
  }, [dataset, activeSession?.id]);

  useEffect(() => {
    if (!activeSession) return;
    const query = new URLSearchParams({
      file: "_VIX_YAHOO_1d.parquet",
      from: String(sixMonthsBefore(activeSession.startTime) - 366 * 86400),
      to: String(activeSession.endTime + 86400),
      limit: "5000"
    });
    fetch(`/api/bars?${query}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "VIX 日线读取失败");
        return body as { bars: Bar[] };
      })
      .then((result) => setVixBars(result.bars))
      .catch((err) => setError(`Yahoo VIX：${err.message}`));
  }, [activeSession?.id]);

  useEffect(() => {
    if (!activeSession || !hasMore || loadingMore || !sourceBars.length || replayTime == null) return;
    const preloadTime = sourceBars[Math.max(0, sourceBars.length - 1000)].time;
    if (replayTime + TIMEFRAME_SECONDS[timeframe] < preloadTime) return;
    setLoadingMore(true);
    const query = new URLSearchParams({
      file: dataset,
      from: String(sourceBars[sourceBars.length - 1].time + 1),
      to: String(activeSession.endTime),
      limit: isSecondDataset ? "300000" : "50000"
    });
    fetch(`/api/bars?${query}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "下一批数据读取失败");
        return body as { bars: Bar[]; hasMore: boolean };
      })
      .then((result) => {
        const combined = [...sourceBars, ...result.bars];
        const retained = isSecondDataset && combined.length > 500000 ? combined.slice(-400000) : combined;
        setSourceBars(retained);
        if (replayTime != null) {
          const displayBars = aggregateBars(retained, timeframe);
          const firstFuture = displayBars.findIndex((bar) => bar.time > replayTime);
          setCursor(firstFuture === -1 ? displayBars.length : Math.max(1, firstFuture));
        }
        setHasMore(result.hasMore);
      })
      .catch((err) => {
        setError(err.message);
        setPlaying(false);
      })
      .finally(() => setLoadingMore(false));
  }, [cursor, replayTime, sourceBars, hasMore, loadingMore, activeSession, dataset, timeframe, isSecondDataset]);

  useEffect(() => {
    if (!chartHost.current) return;
    const chart = createChart(chartHost.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#7e8a9a",
        fontFamily: "Inter, ui-sans-serif, system-ui"
      },
      localization: {
        locale: "zh-CN",
        timeFormatter: formatChartTime
      },
      grid: {
        vertLines: { color: "#141c26" },
        horzLines: { color: "#141c26" }
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#65758b", labelBackgroundColor: "#232e3d" },
        horzLine: { color: "#65758b", labelBackgroundColor: "#232e3d" }
      },
      rightPriceScale: { borderColor: "#25303e" },
      timeScale: {
        borderColor: "#25303e", timeVisible: true, secondsVisible: false,
        tickMarkFormatter: formatChartTick
      }
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#049981",
      downColor: "#F23645",
      borderVisible: false,
      wickUpColor: "#049981",
      wickDownColor: "#F23645",
      priceLineVisible: false
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false
    });
    const ema = chart.addSeries(LineSeries, {
      color: emaColor,
      lineWidth: emaWidth as 1 | 2 | 3 | 4,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;
    emaRef.current = ema;
    renderedBarsRef.current = { count: 0, timeframe };
    emaStateRef.current = { count: 0, timeframe, period: emaPeriod, lastEma: 0, beforeLastEma: 0 };
    chart.subscribeCrosshairMove((param) => {
      if (!param.point || param.point.y < 0) {
        setCrosshairPrice(null);
        return;
      }
      const price = candles.coordinateToPrice(param.point.y);
      setCrosshairPrice(price == null ? null : {
        price,
        y: param.point.y,
        axisWidth: chart.priceScale("right").width()
      });
    });
    const clearSelectedDrawing = () => setClearDrawingSelection((value) => value + 1);
    chart.subscribeClick(clearSelectedDrawing);
    playbackOffsetRef.current = 10;
    chart.timeScale().scrollToPosition(10, false);
    setChartReady((value) => value + 1);
    return () => {
      chart.unsubscribeClick(clearSelectedDrawing);
      chart.remove();
    };
  }, [activeSession?.id]);

  useEffect(() => {
    const light = theme === "light";
    chartRef.current?.applyOptions({
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: light ? "#526071" : "#7e8a9a" },
      grid: { vertLines: { color: light ? "#edf0f4" : "#141c26" }, horzLines: { color: light ? "#edf0f4" : "#141c26" } },
      rightPriceScale: { borderColor: light ? "#d5dbe3" : "#25303e" },
      timeScale: { borderColor: light ? "#d5dbe3" : "#25303e", timeVisible: true }
    });
  }, [theme, chartReady]);

  useEffect(() => {
    if (seekAfterTimeframe.current == null || !bars.length) return;
    const index = bars.findIndex((bar) => bar.time > seekAfterTimeframe.current!);
    setCursor(index < 0 ? bars.length : Math.max(1, index));
    seekAfterTimeframe.current = null;
  }, [bars]);

  useEffect(() => {
    if (!current || position) return;
    setEntryPrice(current.close);
  }, [current?.time, position]);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    if (!activeSession || !hydrated) return;
    setSaveState("saving");
    const id = window.setTimeout(() => {
      fetch(`/api/backtests/${activeSession.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          strategies,
          progress: { cursor, replayTime, position, trades, drawings, quantity, stopDistance, targetDistance, emaEnabled, emaPeriod, emaColor, emaWidth, vixRangeEnabled, vixInnerEnabled, vixOuterEnabled, vixInnerMultiplier, vixOuterMultiplier, priceActionEnabled, priceActionYshYsl, priceActionHtf, priceActionBarCount, priceActionAdaptive, priceActionStructure, fvgEnabled, fvg5m, fvg15m, fvg1h, fvg4h, fvg1d, fvgShowLabels, fvgUseBodyFill, smtEnabled, smt5m, smt15m, smt1h, smt4h, ictKillzonesEnabled, ictShowBoxes, ictShowPivots, ictShowMidpoints, ictAsia, ictLondon, ictNyam, ictNypm, ictDwm, timeframe, dualChartEnabled, secondaryTimeframe, secondaryDatasetId: secondaryDataset, theme, pendingOrders, premarketNotes, pfState }
        })
      }).then(async (res) => {
        if (!res.ok) throw new Error("保存失败");
        const saved: BacktestSession = await res.json();
        setActiveSession(saved);
        setSessions((items) => items.map((item) => item.id === saved.id ? saved : item));
        setSaveState("saved");
      }).catch(() => setSaveState("error"));
    }, 600);
    return () => window.clearTimeout(id);
  }, [cursor, replayTime, position, trades, drawings, quantity, stopDistance, targetDistance, emaEnabled, emaPeriod, emaColor, emaWidth, vixRangeEnabled, vixInnerEnabled, vixOuterEnabled, vixInnerMultiplier, vixOuterMultiplier, priceActionEnabled, priceActionYshYsl, priceActionHtf, priceActionBarCount, priceActionAdaptive, priceActionStructure, fvgEnabled, fvg5m, fvg15m, fvg1h, fvg4h, fvg1d, fvgShowLabels, fvgUseBodyFill, smtEnabled, smt5m, smt15m, smt1h, smt4h, ictKillzonesEnabled, ictShowBoxes, ictShowPivots, ictShowMidpoints, ictAsia, ictLondon, ictNyam, ictNypm, ictDwm, timeframe, dualChartEnabled, secondaryTimeframe, secondaryDataset, theme, pendingOrders, premarketNotes, pfState, strategies, hydrated, activeSession?.id]);

  useEffect(() => {
    if (!candleRef.current || !volumeRef.current) return;
    const rendered = renderedBarsRef.current;
    const firstTime = visibleBars[0]?.time;
    const incremental = rendered.count > 0
      && rendered.timeframe === timeframe
      && rendered.firstTime === firstTime
      && visibleBars.length >= rendered.count
      && visibleBars.length - rendered.count <= 60;
    if (incremental) {
      const start = Math.max(0, rendered.count - 1);
      visibleBars.slice(start).forEach((bar) => {
        candleRef.current?.update({ ...bar, time: bar.time as UTCTimestamp });
        volumeRef.current?.update({
          time: bar.time as UTCTimestamp,
          value: bar.volume,
          color: bar.close >= bar.open ? "#04998138" : "#F2364538"
        });
      });
    } else {
      candleRef.current.setData(
        visibleBars.map((bar) => ({ ...bar, time: bar.time as UTCTimestamp }))
      );
      volumeRef.current.setData(
        visibleBars.map((bar) => ({
          time: bar.time as UTCTimestamp,
          value: bar.volume,
          color: bar.close >= bar.open ? "#04998138" : "#F2364538"
        }))
      );
    }
    renderedBarsRef.current = { count: visibleBars.length, firstTime, timeframe };
    // lightweight-charts applies series updates asynchronously. Restore the
    // user's current right offset on the next frame so newly appended bars do
    // not consume the whitespace they deliberately left on the right.
    const frame = window.requestAnimationFrame(() => {
      chartRef.current?.timeScale().scrollToPosition(playbackOffsetRef.current, false);
      chartRef.current?.clearCrosshairPosition();
      setCrosshairPrice(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visibleBars, cursor, bars.length, timeframe]);

  useEffect(() => {
    if (!emaRef.current) return;
    emaRef.current.applyOptions({
      visible: emaEnabled,
      color: emaColor,
      lineWidth: emaWidth as 1 | 2 | 3 | 4
    });
    if (!emaEnabled || emaPeriod < 1) {
      emaRef.current.setData([]);
      emaStateRef.current.count = 0;
      return;
    }
    const alpha = 2 / (emaPeriod + 1);
    const cached = emaStateRef.current;
    const canUpdate = cached.count >= emaPeriod
      && cached.firstTime === visibleBars[0]?.time
      && cached.timeframe === timeframe
      && cached.period === emaPeriod
      && visibleBars.length >= cached.count
      && visibleBars.length - cached.count <= 60;
    if (canUpdate && visibleBars.length === cached.count && visibleBars.length > emaPeriod) {
      const bar = visibleBars[visibleBars.length - 1];
      const next = bar.close * alpha + cached.beforeLastEma * (1 - alpha);
      emaRef.current.update({ time: bar.time as UTCTimestamp, value: next });
      emaStateRef.current = { ...cached, lastEma: next };
      return;
    }
    if (canUpdate && visibleBars.length > cached.count) {
      let ema = cached.lastEma;
      let beforeLast = cached.beforeLastEma;
      visibleBars.slice(cached.count).forEach((bar) => {
        beforeLast = ema;
        ema = bar.close * alpha + ema * (1 - alpha);
        emaRef.current?.update({ time: bar.time as UTCTimestamp, value: ema });
      });
      emaStateRef.current = { count: visibleBars.length, firstTime: visibleBars[0]?.time, timeframe, period: emaPeriod, lastEma: ema, beforeLastEma: beforeLast };
      return;
    }
    const values: { time: UTCTimestamp; value: number }[] = [];
    let ema = 0;
    let beforeLastEma = 0;
    visibleBars.forEach((bar, index) => {
      if (index < emaPeriod - 1) return;
      if (index === emaPeriod - 1) {
        ema = visibleBars.slice(0, emaPeriod).reduce((sum, item) => sum + item.close, 0) / emaPeriod;
      } else {
        ema = bar.close * alpha + ema * (1 - alpha);
      }
      if (index === visibleBars.length - 2) beforeLastEma = ema;
      values.push({ time: bar.time as UTCTimestamp, value: ema });
    });
    emaRef.current.setData(values);
    emaStateRef.current = {
      count: visibleBars.length, firstTime: visibleBars[0]?.time, timeframe,
      period: emaPeriod, lastEma: ema, beforeLastEma
    };
  }, [visibleBars, emaEnabled, emaPeriod, emaColor, emaWidth, chartReady, timeframe]);

  const closePosition = useCallback(
    (exit: number, closedAt: number, reason: Trade["reason"], requestedQuantity?: number) => {
      const open = positionRef.current;
      if (!open) return;
      const fillQuantity = Math.min(open.quantity, normalizeQuantity(requestedQuantity ?? open.quantity, dataset));
      const direction = open.side === "long" ? 1 : -1;
      const fill = {
        price: exit,
        quantity: fillQuantity,
        closedAt,
        reason,
        pnl: (exit - open.entry) * direction * fillQuantity * contractPointValue(dataset)
      };
      const exitFills = [...(open.exitFills || []), fill];
      const remaining = Number((open.quantity - fillQuantity).toFixed(2));
      if (remaining > 0) {
        const next = { ...open, quantity: remaining, initialQuantity: open.initialQuantity || open.quantity, exitFills };
        positionRef.current = next;
        setPosition(next);
        setCloseQuantity((value) => Math.min(value, remaining));
        return;
      }
      positionRef.current = null;
      setPosition(null);
      setCloseQuantity(quantityStep(dataset));
      const totalQuantity = open.initialQuantity || exitFills.reduce((sum, item) => sum + item.quantity, 0);
      const weightedExit = exitFills.reduce((sum, item) => sum + item.price * item.quantity, 0) / totalQuantity;
      const completed: Trade = {
        ...open, quantity: totalQuantity, initialQuantity: totalQuantity, exitFills,
        exit: weightedExit, closedAt, reason,
        pnl: exitFills.reduce((sum, item) => sum + item.pnl, 0),
        tradingDate: newYorkTradingDate(open.openedAt)
      };
      setTrades((history) => history.some((trade) => trade.id === completed.id) ? history : [...history, completed]);
    },
    [dataset]
  );

  const step = useCallback(() => {
    if (replayTime == null || !activeSession) return;
    playbackOffsetRef.current = Math.max(0, chartRef.current?.timeScale().scrollPosition() ?? playbackOffsetRef.current);
    let nextTime = Math.min(replayTime + TIMEFRAME_SECONDS[playbackStep], activeSession.endTime);
    if (nextTime <= replayTime) return setPlaying(false);
    const segmentStart = upperBoundBarTime(sourceBars, replayTime);
    const segmentEnd = upperBoundBarTime(sourceBars, nextTime);
    let segment = sourceBars.slice(segmentStart, segmentEnd);
    if (!segment.length) {
      const nextAvailable = sourceBars[segmentStart];
      if (nextAvailable && nextAvailable.time <= activeSession.endTime) {
        nextTime = nextAvailable.time;
        segment = [nextAvailable];
      } else {
        if (!hasMore) setPlaying(false);
        return;
      }
    }
    replayHistory.current.push({
      replayTime, cursor, position: positionRef.current ? { ...positionRef.current } : null,
      pendingOrders: pendingOrders.map((order) => ({ ...order })),
      trades: trades.map((trade) => ({ ...trade }))
    });
    if (replayHistory.current.length > 500) replayHistory.current.shift();

    let workingPosition = positionRef.current;
    let workingOrders = pendingOrders;
    for (const next of segment) {
      if (!workingPosition) {
        const triggered = workingOrders.find((order) => !order.draft && (
          order.type === "limit"
            ? (order.side === "long" ? next.low <= order.price : next.high >= order.price)
            : (order.side === "long" ? next.high >= order.price : next.low <= order.price)
        ));
        if (triggered) {
          workingPosition = {
            id: triggered.id, side: triggered.side, entry: triggered.price,
            stop: triggered.stop, target: triggered.target,
            quantity: triggered.quantity, initialQuantity: triggered.quantity, openedAt: next.time, exitFills: []
          };
          workingOrders = workingOrders.filter((order) => order.id !== triggered.id);
          positionRef.current = workingPosition;
          setPosition(workingPosition);
          setPendingOrders(workingOrders);
        }
      }
      if (workingPosition) {
        const hitStop = workingPosition.stop != null &&
          (workingPosition.side === "long" ? next.low <= workingPosition.stop : next.high >= workingPosition.stop);
        const hitTarget = workingPosition.target != null &&
          (workingPosition.side === "long" ? next.high >= workingPosition.target : next.low <= workingPosition.target);
        if (hitStop || hitTarget) {
          closePosition(hitStop ? workingPosition.stop! : workingPosition.target!, next.time, hitStop ? "stop" : "target");
          workingPosition = null;
        }
      }
    }
    setReplayTime(nextTime);
    const firstFuture = bars.findIndex((bar) => bar.time > nextTime);
    setCursor(firstFuture < 0 ? bars.length : Math.max(1, firstFuture));
  }, [replayTime, activeSession, playbackStep, sourceBars, hasMore, cursor, pendingOrders, trades, bars, closePosition]);

  function stepBack() {
    const previous = replayHistory.current.pop();
    if (!previous) return;
    playbackOffsetRef.current = Math.max(0, chartRef.current?.timeScale().scrollPosition() ?? playbackOffsetRef.current);
    setPlaying(false);
    setReplayTime(previous.replayTime);
    // Cursor indices become stale when older history is prepended or the
    // timeframe changes. Restore by timestamp so repeated rewind stays on the
    // same market moment instead of jumping to an unrelated logical index.
    if (previous.replayTime == null) {
      setCursor(Math.max(1, previous.cursor));
    } else {
      const firstFuture = bars.findIndex((bar) => bar.time > previous.replayTime!);
      setCursor(firstFuture < 0 ? bars.length : Math.max(1, firstFuture));
    }
    positionRef.current = previous.position;
    setPosition(previous.position);
    setPendingOrders(previous.pendingOrders);
    setTrades(previous.trades);
  }

  useEffect(() => {
    if (!playing) return;
    playbackOffsetRef.current = Math.max(0, chartRef.current?.timeScale().scrollPosition() ?? 10);
    const id = window.setInterval(step, speed);
    return () => window.clearInterval(id);
  }, [playing, speed, step]);

  function openPosition(side: Side, requestedPrice = entryPrice || current?.close) {
    if (!current || position) return;
    if (calculatePFStatus(activeSession, trades, pfState)?.busted) return setError("PF 账户已爆仓，请先重置考核周期");
    if (!requestedPrice) return setError("请填写入场价格");
    const orderQuantity = normalizeQuantity(quantity, dataset);
    const opened = {
      id: crypto.randomUUID(),
      side,
      entry: requestedPrice,
      stop: stopPrice || undefined,
      target: targetPrice || undefined,
      quantity: orderQuantity,
      initialQuantity: orderQuantity,
      openedAt: current.time,
      exitFills: []
    };
    positionRef.current = opened;
    setPosition(opened);
    setQuickMenu(false);
  }

  function placePending(side: Side, price: number) {
    if (!current) return;
    if (calculatePFStatus(activeSession, trades, pfState)?.busted) return setError("PF 账户已爆仓，请先重置考核周期");
    setPendingOrders((orders) => [...orders, {
      id: crypto.randomUUID(), side, type: "limit", price,
      stop: stopPrice || undefined,
      target: targetPrice || undefined,
      quantity: normalizeQuantity(quantity, dataset), createdAt: current.time, draft: true
    }]);
    setQuickMenu(false);
  }

  function executeDraftOrder(id: string) {
    if (!current) return;
    if (calculatePFStatus(activeSession, trades, pfState)?.busted) return setError("PF 账户已爆仓，请先重置考核周期");
    const order = pendingOrders.find((item) => item.id === id);
    if (!order) return;
    const type = order.side === "long"
      ? (order.price <= current.close ? "limit" : "stop")
      : (order.price >= current.close ? "limit" : "stop");
    setPendingOrders((orders) => orders.map((item) => item.id === id
      ? { ...item, type, draft: false, createdAt: replayTime || current.time }
      : item));
  }

  function resetReplay() {
    setPlaying(false);
    const resetTime = activeSession?.startTime || sourceBars[Math.min(INITIAL_BARS, sourceBars.length) - 1]?.time || null;
    const firstFuture = resetTime == null ? -1 : bars.findIndex((bar) => bar.time > resetTime);
    setCursor(firstFuture === -1 ? bars.length : Math.max(1, firstFuture));
    setReplayTime(resetTime);
    setPosition(null);
    setTrades([]);
    replayHistory.current = [];
  }

  const stats = useMemo(
    () => calculateTradeStats(trades, activeSession?.initialCapital || 0),
    [trades, activeSession?.initialCapital]
  );
  const pfStatus = useMemo(
    () => calculatePFStatus(activeSession, trades, pfState, replayTime),
    [activeSession, trades, pfState, replayTime]
  );

  function simulatePayout() {
    if (!pfStatus?.qualified) return setError("尚未达到 PF 考核目标");
    const amount = Number(payoutAmount);
    if (!(amount > 0) || amount > pfStatus.availablePayout) {
      return setError(`可出金金额为 ${formatPrice(pfStatus.availablePayout)}`);
    }
    setPfState((state) => ({
      ...state,
      payouts: [...state.payouts, { id: crypto.randomUUID(), amount, at: new Date().toISOString() }]
    }));
    setPayoutAmount(0);
    setError("");
  }

  function resetPFAccount() {
    if (!pfStatus) return;
    if (!window.confirm("确认重置 PF 考核账户？历史交易和策略统计会保留，只会开始新的考核周期。")) return;
    positionRef.current = null;
    setPosition(null);
    setPendingOrders([]);
    setPfState((state) => ({
      cycleStartTradeIndex: trades.length,
      payouts: [],
      resetCount: state.resetCount + 1,
      currentCycleStartedAt: replayTime || undefined,
      cycles: [
        ...(state.cycles || []),
        {
          cycle: state.resetCount + 1,
          startedAtTradeIndex: state.cycleStartTradeIndex,
          endedAtTradeIndex: trades.length,
          endedAt: new Date().toISOString(),
          status: pfStatus.busted ? "busted" : pfStatus.qualified ? "qualified" : "reset",
          finalBalance: pfStatus.balance,
          netPnl: pfStatus.balance + pfStatus.payoutTotal - activeSession!.initialCapital,
          drawdownFloor: pfStatus.drawdownFloor,
          tradeCount: pfStatus.cycleTradeCount,
          payouts: [...state.payouts],
          startedAt: pfStatus.cycleStartedAt || undefined,
          qualifiedAt: pfStatus.qualifiedAt || undefined,
          daysToQualify: pfStatus.qualified ? pfStatus.elapsedDays : undefined
        }
      ]
    }));
    setError("");
  }

  const tradingDate = newYorkTradingDate(replayTime);
  const currentPremarketNote = premarketNotes.find((note) => note.tradingDate === tradingDate);

  function updatePremarketNote(text: string) {
    if (!tradingDate || replayTime == null) return;
    setPremarketNotes((notes) => {
      const note: PremarketNote = {
        tradingDate,
        text,
        chartTimestamp: replayTime,
        savedAt: new Date().toISOString()
      };
      const exists = notes.some((item) => item.tradingDate === tradingDate);
      return exists
        ? notes.map((item) => item.tradingDate === tradingDate ? note : item)
        : [...notes, note];
    });
  }

  async function createBacktest(input: {
    strategyName: string; datasetId: string; startTime: number; endTime: number; initialCapital: number;
    accountType: "normal" | "pf"; pfMaxDrawdown?: number; pfTarget?: number;
  }) {
    setError("");
    const res = await fetch("/api/backtests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "创建回测失败");
    const session = body as BacktestSession;
    setSessions((items) => [session, ...items]);
    openSession(session);
  }

  function openSession(session: BacktestSession) {
    setPlaying(false);
    setHydrated(false);
    setTheme(session.progress.theme || "dark");
    setActiveSession(session);
    setDataset(session.datasetId);
    setStrategies(session.strategies || []);
    setPfState(session.progress.pfState || { cycleStartTradeIndex: 0, payouts: [], resetCount: 0 });
    setPfPanelOpen(false);
    setStrategyManagerOpen(false);
  }

  function addStrategy() {
    const name = newStrategyName.trim();
    if (!name || strategies.some((item) => item.name.toLowerCase() === name.toLowerCase())) return;
    setStrategies((items) => [...items, { id: crypto.randomUUID(), name, createdAt: new Date().toISOString() }]);
    setNewStrategyName("");
  }

  function removeStrategy(id: string) {
    if (trades.some((trade) => trade.strategyId === id)) return;
    setStrategies((items) => items.filter((item) => item.id !== id));
  }

  function assignTradeStrategy(tradeId: string, strategyId: string) {
    setTrades((items) => items.map((trade) => trade.id === tradeId
      ? { ...trade, strategyId: strategyId || undefined }
      : trade));
  }

  function updateTradeReason(tradeId: string, tradeReason: string) {
    setTrades((items) => items.map((trade) => trade.id === tradeId
      ? { ...trade, tradeReason: tradeReason || undefined }
      : trade));
  }

  function toggleTradeBreakEven(tradeId: string) {
    setTrades((items) => items.map((trade) => trade.id === tradeId
      ? { ...trade, isBreakEven: !trade.isBreakEven }
      : trade));
  }

  function deleteTrade(trade: Trade) {
    const confirmed = window.confirm(
      `确认删除这笔交易？\n${trade.side === "long" ? "多单" : "空单"} · ${formatDate(trade.openedAt)} · ${trade.pnl >= 0 ? "+" : ""}${formatPrice(trade.pnl)}`
    );
    if (!confirmed) return;
    setTrades((items) => items.filter((item) => item.id !== trade.id));
  }

  if (!activeSession) {
    return <BacktestHome datasets={datasets} sessions={sessions} error={error} onCreate={createBacktest} onOpen={openSession} />;
  }

  return (
    <main className={`app-shell theme-${theme}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">R</span>
          <div>
            <strong>Replay Lab</strong>
            <small>{activeSession.strategyName} · {saveState === "saving" ? "正在保存…" : saveState === "error" ? "保存失败" : "已自动保存"} · v1.30</small>
          </div>
        </div>
        <div className="top-stats">
          <span><small>净收益</small><b className={stats.net >= 0 ? "positive" : "negative"}>{formatPrice(stats.net)}</b></span>
          <span><small>胜率</small><b>{stats.winRate.toFixed(1)}%</b></span>
          <span><small>保本率</small><b>{stats.breakEvenRate.toFixed(1)}%</b></span>
          <span><small>盈亏比</small><b>{formatRatio(stats.payoffRatio)}</b></span>
          <span><small>利润因子</small><b>{formatRatio(stats.profitFactor)}</b></span>
          <span><small>最大回撤</small><b>{formatPrice(stats.maxDrawdown)} <em>{stats.maxDrawdownPct.toFixed(1)}%</em></b></span>
          <span><small>交易 / 保本 / 期望</small><b>{stats.count} / {stats.breakEvens} / {formatPrice(stats.expectancy)}</b></span>
          <span><small>账户权益</small><b>{formatPrice(activeSession.initialCapital + stats.net)}</b></span>
          {pfStatus && <span><small>PF 状态</small><b className={pfStatus.busted ? "negative" : pfStatus.qualified ? "positive" : ""}>
            {pfStatus.busted ? "已爆仓" : pfStatus.qualified ? "可出金" : "考核中"}
          </b></span>}
          {pfStatus && <button className="back-button pf-button" onClick={() => setPfPanelOpen(true)}>PF 考核信息</button>}
          <button className="back-button" onClick={() => setStrategyManagerOpen(true)}>策略管理</button>
          <button className="back-button" onClick={() => window.open(window.location.origin, "_blank", "noopener,noreferrer")}>＋ 新开回测窗口</button>
          <button className="back-button" onClick={() => setTheme((value) => value === "dark" ? "light" : "dark")}>{theme === "dark" ? "☀ 白天" : "☾ 夜间"}</button>
          <button className="back-button" onClick={() => { setPlaying(false); setActiveSession(null); setSourceBars([]); }}>回测列表</button>
        </div>
      </header>

      {pfPanelOpen && pfStatus && <div className="strategy-modal-backdrop" onPointerDown={() => setPfPanelOpen(false)}>
        <section className="strategy-modal pf-modal" onPointerDown={(event) => event.stopPropagation()}>
          <div className="strategy-modal-head">
            <div><small>PROP FIRM EVALUATION</small><h2>PF 考核信息</h2></div>
            <button onClick={() => setPfPanelOpen(false)}>×</button>
          </div>
          <div className={`pf-status-banner ${pfStatus.busted ? "busted" : pfStatus.qualified ? "qualified" : "active"}`}>
            <b>{pfStatus.busted ? "账户已爆仓" : pfStatus.qualified ? "已通过考核 · 可模拟出金" : "考核进行中"}</b>
            <span>第 {pfState.resetCount + 1} 个考核周期 · {pfStatus.cycleTradeCount} 笔交易</span>
          </div>
          <div className="pf-stat-grid">
            <span><small>账户余额</small><b>{formatPrice(pfStatus.balance)}</b></span>
            <span><small>初始账户</small><b>{formatPrice(activeSession.initialCapital)}</b></span>
            <span><small>当前回撤线</small><b className="negative">{formatPrice(pfStatus.drawdownFloor)}</b></span>
            <span><small>剩余回撤空间</small><b>{formatPrice(pfStatus.drawdownRemaining)}</b></span>
            <span><small>考核目标</small><b>{formatPrice(activeSession.initialCapital + (activeSession.pfTarget || 0))}</b></span>
            <span><small>距离目标</small><b>{formatPrice(pfStatus.targetRemaining)}</b></span>
            <span><small>{pfStatus.qualified ? "通过用时" : "已进行"}</small><b>{pfStatus.elapsedDays} 个交易日</b></span>
            <span><small>回撤规则</small><b>{pfStatus.staticDrawdown ? "静态回撤" : "EOD 跟踪"}</b></span>
            <span><small>累计出金</small><b>{formatPrice(pfStatus.payoutTotal)}</b></span>
          </div>
          <div className="pf-cycle-curves">
            <PFCycleCurve
              session={activeSession}
              trades={trades.slice(pfState.cycleStartTradeIndex)}
              title={`当前周期 · 第 ${pfState.resetCount + 1} 期`}
            />
            {(pfState.cycles || []).map((cycle) => <PFCycleCurve
              key={cycle.cycle}
              session={activeSession}
              trades={trades.slice(cycle.startedAtTradeIndex, cycle.endedAtTradeIndex)}
              title={`历史周期 · 第 ${cycle.cycle} 期`}
            />)}
          </div>
          {pfStatus.qualified && !pfStatus.busted && <div className="pf-payout">
            <label>模拟出金金额
              <input type="number" min="0" max={pfStatus.availablePayout} step="1" value={payoutAmount || ""}
                onChange={(event) => setPayoutAmount(Number(event.target.value))} />
            </label>
            <button disabled={pfStatus.availablePayout <= 0} onClick={simulatePayout}>确认出金</button>
            <small>当前最多可出金 {formatPrice(pfStatus.availablePayout)}；出金不影响历史交易和策略统计。</small>
          </div>}
          {pfState.payouts.length > 0 && <div className="pf-payout-history">
            <small>出金记录</small>
            {pfState.payouts.map((payout) => <span key={payout.id}><b>{formatPrice(payout.amount)}</b><em>{new Date(payout.at).toLocaleString("zh-CN", { hour12: false })}</em></span>)}
          </div>}
          {(pfState.cycles?.length || 0) > 0 && <div className="pf-payout-history">
            <small>历史考核周期</small>
            {pfState.cycles!.map((cycle) => {
              const daysToQualify = historicalPFCycleDays(activeSession, trades, cycle);
              return <span key={cycle.cycle}>
                <b>第 {cycle.cycle} 期 · {cycle.status === "busted" ? "爆仓" : cycle.status === "qualified" ? "通过" : "手动重置"}</b>
                <em>{cycle.tradeCount} 笔 · {cycle.netPnl >= 0 ? "+" : ""}{formatPrice(cycle.netPnl)}{daysToQualify ? ` · ${daysToQualify}个交易日通过` : ""}</em>
              </span>;
            })}
          </div>}
          <button className="pf-reset" onClick={resetPFAccount}>保存本期并重置 PF 账户</button>
          <p>规则：考核阶段按日终余额高水位追踪。50K 账户日终余额达到 52,100 后，下一交易日回撤线固定为 50,100，之后不再追踪。PF 周期独立保存，外部总账户统计持续累计。</p>
        </section>
      </div>}

      {strategyManagerOpen && <div className="strategy-modal-backdrop" onPointerDown={() => setStrategyManagerOpen(false)}>
        <section className="strategy-modal" onPointerDown={(event) => event.stopPropagation()}>
          <div className="strategy-modal-head">
            <div><small>BACKTEST STRATEGIES</small><h2>策略管理</h2></div>
            <button onClick={() => setStrategyManagerOpen(false)}>×</button>
          </div>
          <p>策略属于当前回测；右上角统计仍汇总全部策略的交易。</p>
          <div className="strategy-add">
            <input value={newStrategyName} onChange={(event) => setNewStrategyName(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") addStrategy(); }} placeholder="输入策略名称" />
            <button onClick={addStrategy}>添加策略</button>
          </div>
          <EquityCurve trades={trades} initialCapital={activeSession.initialCapital} />
          <div className="strategy-manager-list">
            {!strategies.length && <div className="empty-copy">暂时没有策略。添加后即可在交易记录中关联。</div>}
            {strategies.map((strategy) => {
              const strategyTrades = trades.filter((trade) => trade.strategyId === strategy.id);
              const strategyStats = calculateTradeStats(strategyTrades, activeSession.initialCapital);
              return <article key={strategy.id} className="strategy-stat-card">
                <div className="strategy-stat-head">
                  <span><b>{strategy.name}</b><small>{strategyStats.count} 笔 · {strategyStats.wins} 胜 / {strategyStats.losses} 负 / {strategyStats.breakEvens} 保本</small></span>
                  <button disabled={strategyStats.count > 0} title={strategyStats.count > 0 ? "已有交易关联，不能删除" : "删除策略"} onClick={() => removeStrategy(strategy.id)}>删除</button>
                </div>
                <div className="strategy-stat-grid">
                  <span><small>总利润</small><b className={strategyStats.net >= 0 ? "positive" : "negative"}>{formatPrice(strategyStats.net)}</b></span>
                  <span><small>胜率</small><b>{strategyStats.winRate.toFixed(1)}%</b></span>
                  <span><small>保本率</small><b>{strategyStats.breakEvenRate.toFixed(1)}%</b></span>
                  <span><small>盈亏比</small><b>{formatRatio(strategyStats.payoffRatio)}</b></span>
                  <span><small>利润因子</small><b>{formatRatio(strategyStats.profitFactor)}</b></span>
                  <span><small>每笔期望</small><b>{formatPrice(strategyStats.expectancy)}</b></span>
                  <span><small>最大回撤</small><b>{formatPrice(strategyStats.maxDrawdown)}</b></span>
                  <span><small>平均盈利</small><b>{formatPrice(strategyStats.averageWin)}</b></span>
                  <span><small>平均亏损</small><b>{formatPrice(strategyStats.averageLoss)}</b></span>
                  <span><small>最长连胜</small><b>{strategyStats.maxWinStreak}</b></span>
                  <span><small>最长连亏</small><b>{strategyStats.maxLossStreak}</b></span>
                  <span><small>平均持单</small><b>{formatDuration(strategyStats.averageHoldSeconds)}</b></span>
                </div>
              </article>;
            })}
          </div>
        </section>
      </div>}

      <section className="workspace">
        <nav className="draw-toolbar" aria-label="绘图工具">
          {([
            ["cursor", "⌖", "选择"],
            ["rectangle", "▭", "矩形"],
            ["fib", "≋", "斐波那契"],
            ["hline", "—", "水平线段"],
            ["bsl", "B", "BSL 射线"],
            ["ssl", "S", "SSL 射线"],
            ["buyli", "BL", "BUYLI 射线"],
            ["sellli", "SL", "SELLLI 射线"],
            ["long", "L", "多仓工具"],
            ["short", "S", "空仓工具"]
          ] as [Tool, string, string][]).map(([id, icon, label]) => (
            <button key={id} className={tool === id ? "active" : ""} title={label} onClick={() => setTool(id)}>
              <span>{icon}</span><small>{label}</small>
            </button>
          ))}
        </nav>
        <aside className="sidebar">
          <div className="section-label">数据集</div>
          <div className="dataset-lock">{datasets.find((item) => item.id === dataset)?.label || dataset}<small>本次回测的数据范围已锁定</small></div>
          {!datasets.length && <p className="empty-copy">把 Parquet 放入 <code>data/processed</code>。</p>}

          <div className="section-label">订单参数</div>
          <label>数量<input type="number" min={quantityStep(dataset)} step={quantityStep(dataset)} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} /></label>
          <label>入场价格<input type="number" step={dataset.toUpperCase().startsWith("XAUUSD") ? 0.01 : 0.25} value={entryPrice || ""} onChange={(e) => setEntryPrice(Number(e.target.value))} /></label>
          <label>止损价格<input type="number" step={dataset.toUpperCase().startsWith("XAUUSD") ? 0.01 : 0.25} value={stopPrice || ""} onChange={(e) => setStopPrice(Number(e.target.value))} /></label>
          <label>止盈价格<input type="number" step={dataset.toUpperCase().startsWith("XAUUSD") ? 0.01 : 0.25} value={targetPrice || ""} onChange={(e) => setTargetPrice(Number(e.target.value))} /></label>

          <div className="section-label">执行</div>
          <div className="order-grid">
            <button className="buy" disabled={!current || !!position} onClick={() => openPosition("long")}>做多</button>
            <button className="sell" disabled={!current || !!position} onClick={() => openPosition("short")}>做空</button>
          </div>
          {position && <div className="partial-close-row">
            <label>平仓手数<input type="number" min={quantityStep(dataset)} max={position.quantity} step={quantityStep(dataset)} value={closeQuantity}
              onChange={(event) => setCloseQuantity(Math.min(position.quantity, normalizeQuantity(Number(event.target.value), dataset)))} /></label>
            <button className="close-button" disabled={!current}
              onClick={() => current && closePosition(current.close, current.time, "manual", closeQuantity)}>
              平仓 {displayQuantity(Math.min(closeQuantity, position.quantity))} 手
            </button>
          </div>}

          <div className="position-card">
            <div><span>当前仓位</span><b>{position ? (position.side === "long" ? "多头" : "空头") : "空仓"}</b></div>
            <div><span>初始 / 剩余</span><b>{position ? `${displayQuantity(position.initialQuantity || position.quantity)} / ${displayQuantity(position.quantity)} 手` : "—"}</b></div>
            <div><span>入场</span><b>{formatPrice(position?.entry)}</b></div>
            <div><span>止损 / 止盈</span><b>{formatPrice(position?.stop)} / {formatPrice(position?.target)}</b></div>
            {!!position?.exitFills?.length && <div><span>已实现盈亏</span><b className={position.exitFills.reduce((sum, fill) => sum + fill.pnl, 0) >= 0 ? "positive" : "negative"}>{formatPrice(position.exitFills.reduce((sum, fill) => sum + fill.pnl, 0))}</b></div>}
          </div>
          {!!pendingOrders.length && <div className="pending-list">
            {pendingOrders.map((order) => <div key={order.id}>
              <span>{order.type === "limit" ? "限价" : "突破"} · {order.side === "long" ? "多" : "空"} @ {formatPrice(order.price)}</span>
              <button onClick={() => setPendingOrders((items) => items.filter((item) => item.id !== order.id))}>×</button>
            </div>)}
          </div>}

          <div className="section-label">指标</div>
          <div className="indicator-card">
            <div className="indicator-head">
              <label className="switch-label"><input type="checkbox" checked={emaEnabled} onChange={(e) => setEmaEnabled(e.target.checked)} /> EMA</label>
              <span style={{ background: emaColor }} />
            </div>
            <label>周期<input type="number" min="1" max="500" value={emaPeriod} onChange={(e) => setEmaPeriod(Math.max(1, Number(e.target.value)))} /></label>
            <div className="indicator-row">
              <label>颜色<input type="color" value={emaColor} onChange={(e) => setEmaColor(e.target.value)} /></label>
              <label>线宽<select value={emaWidth} onChange={(e) => setEmaWidth(Number(e.target.value))}>
                <option value={1}>1</option><option value={2}>2</option><option value={3}>3</option><option value={4}>4</option>
              </select></label>
            </div>
          </div>
          <div className="indicator-card">
            <div className="indicator-head">
              <label className="switch-label"><input type="checkbox" checked={priceActionEnabled} onChange={(e) => setPriceActionEnabled(e.target.checked)} /> V_PriceAction</label>
              <small>PA 结构</small>
            </div>
            <p className="indicator-note">已忽略重复的 EMA 与 VIX 区间模块</p>
            <div className="indicator-checks">
              <label><input type="checkbox" checked={priceActionYshYsl} onChange={(e) => setPriceActionYshYsl(e.target.checked)} /> 昨日高低 YSH/YSL</label>
              <label><input type="checkbox" checked={priceActionHtf} onChange={(e) => setPriceActionHtf(e.target.checked)} /> 右侧高周期 K 线</label>
              <label><input type="checkbox" checked={priceActionBarCount} onChange={(e) => setPriceActionBarCount(e.target.checked)} /> 日内 K 线编号</label>
              <label><input type="checkbox" checked={priceActionAdaptive} onChange={(e) => setPriceActionAdaptive(e.target.checked)} /> 自适应高低线</label>
              <label><input type="checkbox" checked={priceActionStructure} onChange={(e) => setPriceActionStructure(e.target.checked)} /> HL/LL 双底双顶</label>
            </div>
          </div>
          <div className="indicator-card">
            <div className="indicator-head">
              <label className="switch-label"><input type="checkbox" checked={vixRangeEnabled} onChange={(e) => setVixRangeEnabled(e.target.checked)} /> VIX 日区间</label>
              <small>Yahoo ^VIX</small>
            </div>
            <p className="indicator-note">使用前一交易日收盘，无未来数据</p>
            <div className="indicator-row">
              <label><input type="checkbox" checked={vixInnerEnabled} onChange={(e) => setVixInnerEnabled(e.target.checked)} /> 内圈
                <input type="number" min="0.1" max="3" step="0.1" value={vixInnerMultiplier} onChange={(e) => setVixInnerMultiplier(Math.max(0.1, Number(e.target.value)))} />
              </label>
              <label><input type="checkbox" checked={vixOuterEnabled} onChange={(e) => setVixOuterEnabled(e.target.checked)} /> 外圈
                <input type="number" min="0.1" max="3" step="0.1" value={vixOuterMultiplier} onChange={(e) => setVixOuterMultiplier(Math.max(0.1, Number(e.target.value)))} />
              </label>
            </div>
          </div>
          <div className="indicator-card">
            <div className="indicator-head">
              <label className="switch-label"><input type="checkbox" checked={fvgEnabled} onChange={(e) => setFvgEnabled(e.target.checked)} /> 多周期 FVG</label>
              <small>5m · 15m · 1H · 4H · D</small>
            </div>
            <p className="indicator-note">仅使用已收盘源周期 K 线；实体收盘越过远端边界后失效</p>
            <div className="indicator-checks fvg-periods">
              <label><input type="checkbox" checked={fvg5m} onChange={(e) => setFvg5m(e.target.checked)} /> 5分钟</label>
              <label><input type="checkbox" checked={fvg15m} onChange={(e) => setFvg15m(e.target.checked)} /> 15分钟</label>
              <label><input type="checkbox" checked={fvg1h} onChange={(e) => setFvg1h(e.target.checked)} /> 1小时</label>
              <label><input type="checkbox" checked={fvg4h} onChange={(e) => setFvg4h(e.target.checked)} /> 4小时</label>
              <label><input type="checkbox" checked={fvg1d} onChange={(e) => setFvg1d(e.target.checked)} /> 日线</label>
              <label><input type="checkbox" checked={fvgShowLabels} onChange={(e) => setFvgShowLabels(e.target.checked)} /> 显示标签</label>
            </div>
          </div>
          <div className="indicator-card">
            <div className="indicator-head">
              <label className="switch-label"><input type="checkbox" checked={smtEnabled} onChange={(e) => setSmtEnabled(e.target.checked)} /> NQ / ES SMT</label>
              <small>{smtLoading ? "读取中…" : smtCompanion ? "MNQ 对比 MES" : "缺少 MES 数据"}</small>
            </div>
            <p className="indicator-note">比较相邻周期高低点；仅用回放时刻之前的数据，1分钟突破后失效</p>
            <div className="indicator-checks fvg-periods">
              <label><input type="checkbox" checked={smt5m} onChange={(e) => setSmt5m(e.target.checked)} /> 5分钟</label>
              <label><input type="checkbox" checked={smt15m} onChange={(e) => setSmt15m(e.target.checked)} /> 15分钟</label>
              <label><input type="checkbox" checked={smt1h} onChange={(e) => setSmt1h(e.target.checked)} /> 1小时</label>
              <label><input type="checkbox" checked={smt4h} onChange={(e) => setSmt4h(e.target.checked)} /> 4小时</label>
            </div>
          </div>
          <div className="indicator-card">
            <div className="indicator-head">
              <label className="switch-label"><input type="checkbox" checked={ictKillzonesEnabled} onChange={(e) => setIctKillzonesEnabled(e.target.checked)} /> ICT Killzones</label>
              <small>纽约时区</small>
            </div>
            <p className="indicator-note">30分钟及以下显示；区间高低线触及后停止延伸</p>
            <div className="indicator-checks">
              <label><input type="checkbox" checked={ictShowBoxes} onChange={(e) => setIctShowBoxes(e.target.checked)} /> Killzone 区域</label>
              <label><input type="checkbox" checked={ictShowPivots} onChange={(e) => setIctShowPivots(e.target.checked)} /> 区间高低点</label>
              <label><input type="checkbox" checked={ictShowMidpoints} onChange={(e) => setIctShowMidpoints(e.target.checked)} /> 区间中点</label>
              <label><input type="checkbox" checked={ictAsia} onChange={(e) => setIctAsia(e.target.checked)} /> 亚洲 20:00–00:00</label>
              <label><input type="checkbox" checked={ictLondon} onChange={(e) => setIctLondon(e.target.checked)} /> 伦敦 02:00–05:00</label>
              <label><input type="checkbox" checked={ictNyam} onChange={(e) => setIctNyam(e.target.checked)} /> NYAM 09:30–11:00</label>
              <label><input type="checkbox" checked={ictNypm} onChange={(e) => setIctNypm(e.target.checked)} /> NYPM 13:30–16:00</label>
              <label><input type="checkbox" checked={ictDwm} onChange={(e) => setIctDwm(e.target.checked)} /> PD/PW/PM 高低点</label>
            </div>
          </div>
        </aside>

        <section className={`chart-panel ${dualChartEnabled ? "dual-chart" : ""}`}>
          <div className="chart-toolbar">
            <div className="instrument">
              <strong>{datasets.find((item) => item.id === dataset)?.label || "NO DATA"}</strong>
              <select className="timeframe-select" value={timeframe} onChange={(e) => {
                seekAfterTimeframe.current = replayTime;
                setTimeframe(e.target.value as Timeframe);
              }}>
                {isSecondDataset && <><option value="1s">1秒</option><option value="15s">15秒</option></>}
                <option value="1m">1分钟</option><option value="2m">2分钟</option><option value="5m">5分钟</option><option value="15m">15分钟</option>
                <option value="1h">1小时</option><option value="4h">4小时</option><option value="1d">日线</option>
              </select>
              <button className={`chart-layout-button ${dualChartEnabled ? "active" : ""}`}
                onClick={() => setDualChartEnabled((value) => !value)}>
                {dualChartEnabled ? "关闭同步副图" : "＋ 同步品种"}
              </button>
              <span>{formatDateWithWeekday(current?.time)}</span>
            </div>
            <div className="ohlc">
              <span>O {formatPrice(current?.open)}</span>
              <span>H {formatPrice(current?.high)}</span>
              <span>L {formatPrice(current?.low)}</span>
              <span>C {formatPrice(current?.close)}</span>
            </div>
          </div>
          <div ref={chartHost} className="chart-host">
            <DrawingOverlay
              host={chartHost.current}
              chart={chartRef.current}
              series={candleRef.current}
              tool={tool}
              rayDirection={rayDirection}
              drawings={drawings}
              onDrawingsChange={setDrawings}
              position={position}
              onPositionChange={(next) => { positionRef.current = next; setPosition(next); }}
              onFinishTool={() => setTool("cursor")}
              barInterval={TIMEFRAME_SECONDS[timeframe]}
              lastBarTime={current?.time}
              pendingOrders={pendingOrders}
              onPendingOrdersChange={setPendingOrders}
              currentPrice={current?.close}
              pointValue={contractPointValue(dataset)}
              quantityStep={quantityStep(dataset)}
              orderQuantity={quantity}
              onClosePosition={() => current && closePosition(current.close, replayTime || current.time, "manual")}
              onExecutePendingOrder={executeDraftOrder}
              visibleBars={overlayBars}
              clearSelectionSignal={clearDrawingSelection}
              vixBars={vixBars}
              vixRangeEnabled={vixRangeEnabled}
              vixInnerEnabled={vixInnerEnabled}
              vixOuterEnabled={vixOuterEnabled}
              vixInnerMultiplier={vixInnerMultiplier}
              vixOuterMultiplier={vixOuterMultiplier}
              priceActionEnabled={priceActionEnabled}
              priceActionYshYsl={priceActionYshYsl}
              priceActionHtf={priceActionHtf}
              priceActionBarCount={priceActionBarCount}
              priceActionAdaptive={priceActionAdaptive}
              priceActionStructure={priceActionStructure}
              timeframeSeconds={TIMEFRAME_SECONDS[timeframe]}
              fvgBars={fvgBars}
              fvgSourceBars={fvgSourceBars}
              fvgEnabled={fvgEnabled}
              fvg5m={fvg5m}
              fvg15m={fvg15m}
              fvg1h={fvg1h}
              fvg4h={fvg4h}
              fvg1d={fvg1d}
              fvgShowLabels={fvgShowLabels}
              smtPrimaryBars={smtPrimaryBars}
              smtOtherBars={smtOtherBars}
              smtEnabled={smtEnabled && dataset.startsWith("MNQ_")}
              smt5m={smt5m}
              smt15m={smt15m}
              smt1h={smt1h}
              smt4h={smt4h}
              ictKillzonesEnabled={ictKillzonesEnabled}
              ictShowBoxes={ictShowBoxes}
              ictShowPivots={ictShowPivots}
              ictShowMidpoints={ictShowMidpoints}
              ictAsia={ictAsia}
              ictLondon={ictLondon}
              ictNyam={ictNyam}
              ictNypm={ictNypm}
              ictDwm={ictDwm}
            />
            {crosshairPrice && !position && !pendingOrders.length && <div className="quick-order-anchor" style={{ top: crosshairPrice.y, right: crosshairPrice.axisWidth }}>
              <button
                onPointerMove={(event) => {
                  if (!chartHost.current || !candleRef.current) return;
                  const y = event.clientY - chartHost.current.getBoundingClientRect().top;
                  const price = candleRef.current.coordinateToPrice(y);
                  if (price != null) setCrosshairPrice({ ...crosshairPrice, price, y });
                }}
                onClick={() => { setEntryPrice(crosshairPrice.price); setQuickMenu((value) => !value); }}
              >＋</button>
              {quickMenu && <div className="quick-order-menu">
                <strong>{crosshairPrice.price.toFixed(2)}</strong>
                <div><button className="quick-buy" onClick={() => placePending("long", crosshairPrice.price)}>Buy</button><button className="quick-sell" onClick={() => placePending("short", crosshairPrice.price)}>Sell</button></div>
              </div>}
            </div>}
          </div>
          {dualChartEnabled && <>
            <div className="chart-toolbar secondary-toolbar">
              <div className="instrument">
                <select className="instrument-select" value={secondaryDataset}
                  onChange={(event) => {
                    const nextDataset = event.target.value;
                    setSecondaryDataset(nextDataset);
                    setSecondaryDatasetWindow(null);
                    if (!(nextDataset || dataset).includes("ohlcv-1s") && (secondaryTimeframe === "1s" || secondaryTimeframe === "15s")) setSecondaryTimeframe("1m");
                  }}>
                  <option value="">同品种</option>
                  {datasets.filter((item) => item.id !== dataset).map((item) =>
                    <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
                <select className="timeframe-select" value={secondaryTimeframe}
                  onChange={(event) => setSecondaryTimeframe(event.target.value as Timeframe)}>
                  {secondaryIsSecondDataset && <><option value="1s">1秒</option><option value="15s">15秒</option></>}
                  <option value="1m">1分钟</option><option value="2m">2分钟</option><option value="5m">5分钟</option><option value="15m">15分钟</option>
                  <option value="1h">1小时</option><option value="4h">4小时</option><option value="1d">日线</option>
                </select>
                {secondaryDatasetLoading && <small>同步读取中…</small>}
                <span>{formatDateWithWeekday(secondaryCurrent?.time)}</span>
              </div>
              <div className="ohlc">
                <span>O {formatPrice(secondaryCurrent?.open)}</span>
                <span>H {formatPrice(secondaryCurrent?.high)}</span>
                <span>L {formatPrice(secondaryCurrent?.low)}</span>
                <span>C {formatPrice(secondaryCurrent?.close)}</span>
              </div>
            </div>
            <SecondaryChart bars={secondaryBars} sourceBars={secondarySourceBars}
              smtOtherBars={smtPrimaryBars.length ? smtPrimaryBars : secondarySmtOtherBars}
              vixBars={vixBars} timeframe={secondaryTimeframe} theme={theme}
              emaEnabled={emaEnabled} emaPeriod={emaPeriod} emaColor={emaColor} emaWidth={emaWidth}
              indicators={{
                vixRangeEnabled, vixInnerEnabled, vixOuterEnabled, vixInnerMultiplier, vixOuterMultiplier,
                priceActionEnabled, priceActionYshYsl, priceActionHtf, priceActionBarCount, priceActionAdaptive, priceActionStructure,
                fvgEnabled, fvg5m, fvg15m, fvg1h, fvg4h, fvg1d, fvgShowLabels,
                smtEnabled: smtEnabled && ((dataset.startsWith("MNQ_") && (secondaryDataset || dataset).startsWith("MES_")) || (dataset.startsWith("MES_") && (secondaryDataset || dataset).startsWith("MNQ_"))),
                smt5m, smt15m, smt1h, smt4h,
                ictKillzonesEnabled, ictShowBoxes, ictShowPivots, ictShowMidpoints, ictAsia, ictLondon, ictNyam, ictNypm, ictDwm
              }} />
          </>}
          {error && <div className="error-banner">{error}</div>}
          <div className="replay-bar">
            <button onClick={resetReplay}>↺</button>
            <button onClick={stepBack} disabled={!replayHistory.current.length}>│◀</button>
            <button onClick={step} disabled={!replayTime || replayTime >= activeSession.endTime}>│▶</button>
            <button className="play" onClick={() => setPlaying((value) => !value)} disabled={!bars.length}>
              {playing ? "暂停" : "播放"}
            </button>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              <option value={800}>0.5×</option>
              <option value={400}>1×</option>
              <option value={180}>2×</option>
              <option value={70}>5×</option>
            </select>
            <select value={playbackStep} onChange={(e) => setPlaybackStep(e.target.value as "1s" | "15s" | "1m" | "2m" | "5m" | "15m" | "1h")}>
              {isSecondDataset && <><option value="1s">每步 1秒</option><option value="15s">每步 15秒</option></>}
              <option value="1m">每步 1分钟</option><option value="2m">每步 2分钟</option><option value="5m">每步 5分钟</option>
              <option value="15m">每步 15分钟</option><option value="1h">每步 1小时</option>
            </select>
            <div className="progress"><i style={{ width: `${progress}%` }} /></div>
            <span>{cursor.toLocaleString()} / {bars.length.toLocaleString()}{loadingMore ? " · 加载中" : hasMore ? " · 分批" : ""}</span>
          </div>
        </section>

        <aside className="journal">
          <div className="section-label">盘前分析</div>
          <div className="premarket-card">
            <div className="premarket-date">
              <b>{tradingDate ? `${tradingDate} · ${tradingDateWeekday(tradingDate)}` : "—"}</b>
              <span>纽约交易日</span>
            </div>
            <textarea
              value={currentPremarketNote?.text || ""}
              onChange={(event) => updatePremarketNote(event.target.value)}
              placeholder="记录当天方向预期、关键流动性、DOL、等待模型和需要回避的情景…"
            />
            <small>{currentPremarketNote
              ? `图表时间：${formatDate(currentPremarketNote.chartTimestamp)} · 已自动保存`
              : "内容会按当前图表交易日保存，并与当天交易关联。"}</small>
          </div>
          <div className="section-label">交易记录</div>
          {!trades.length && <p className="empty-copy">回放过程中开仓，已完成的交易会出现在这里。</p>}
          <div className="trade-list">
            {[...trades].reverse().map((trade) => (
              <article key={trade.id} className={trade.isBreakEven ? "break-even-trade" : ""}>
                <div>
                  <b className={trade.side === "long" ? "positive" : "negative"}>{trade.side === "long" ? "LONG" : "SHORT"}</b>
                  <small>{formatDate(trade.openedAt)}</small>
                </div>
                <div><span>{formatPrice(trade.entry)} → {formatPrice(trade.exit)}</span><strong className={trade.isBreakEven ? "break-even-value" : trade.pnl >= 0 ? "positive" : "negative"}>{trade.isBreakEven && <em className="break-even-badge">保本</em>}{trade.pnl >= 0 ? "+" : ""}{formatPrice(trade.pnl)}</strong></div>
                {(trade.exitFills?.length || 0) > 1 && <div className="exit-fill-list">
                  <small>分批平仓明细</small>
                  {trade.exitFills!.map((fill, index) => <span key={`${fill.closedAt}-${index}`}>
                    <em>第 {index + 1} 次 · {fill.quantity}手 @ {formatPrice(fill.price)}</em>
                    <b className={fill.pnl >= 0 ? "positive" : "negative"}>{fill.pnl >= 0 ? "+" : ""}{formatPrice(fill.pnl)}</b>
                  </span>)}
                </div>}
                <div className="trade-meta">
                  <small>{trade.reason === "target" ? "止盈" : trade.reason === "stop" ? "止损" : "手动平仓"}</small>
                  <div className="trade-actions">
                    <select aria-label="交易策略" value={trade.strategyId || ""} onChange={(event) => assignTradeStrategy(trade.id, event.target.value)}>
                      <option value="">未分类策略</option>
                      {strategies.map((strategy) => <option key={strategy.id} value={strategy.id}>{strategy.name}</option>)}
                    </select>
                    <button className={`trade-break-even ${trade.isBreakEven ? "active" : ""}`} onClick={() => toggleTradeBreakEven(trade.id)} title={trade.isBreakEven ? "取消保本标记" : "标记为保本单"}>{trade.isBreakEven ? "取消保本" : "标记保本"}</button>
                    <button className="trade-delete" onClick={() => deleteTrade(trade)} title="删除这笔交易">删除</button>
                  </div>
                </div>
                <textarea
                  className="trade-reason"
                  value={trade.tradeReason || ""}
                  onChange={(event) => updateTradeReason(trade.id, event.target.value)}
                  placeholder="交易理由（选填）"
                  aria-label="交易理由"
                />
              </article>
            ))}
          </div>
        </aside>
      </section>
    </main>
  );
}

function localDateTime(unix: number) {
  const date = new Date(unix * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function BacktestHome({
  datasets,
  sessions,
  error,
  onCreate,
  onOpen
}: {
  datasets: Dataset[];
  sessions: BacktestSession[];
  error: string;
  onCreate: (input: {
    strategyName: string; datasetId: string; startTime: number; endTime: number; initialCapital: number;
    accountType: "normal" | "pf"; pfMaxDrawdown?: number; pfTarget?: number;
  }) => Promise<void>;
  onOpen: (session: BacktestSession) => void;
}) {
  const [strategyName, setStrategyName] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [capital, setCapital] = useState(100000);
  const [accountType, setAccountType] = useState<"normal" | "pf">("normal");
  const [pfMaxDrawdown, setPfMaxDrawdown] = useState(2500);
  const [pfTarget, setPfTarget] = useState(3000);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");
  const selected = datasets.find((item) => item.id === datasetId);

  useEffect(() => {
    if (!datasets.length || datasetId) return;
    const first = datasets[0];
    setDatasetId(first.id);
    setStart(localDateTime(first.startTime));
    setEnd(localDateTime(Math.min(first.endTime, first.startTime + 31 * 86400)));
  }, [datasets, datasetId]);

  function changeDataset(id: string) {
    setDatasetId(id);
    const item = datasets.find((entry) => entry.id === id);
    if (item) {
      setStart(localDateTime(item.startTime));
      setEnd(localDateTime(Math.min(item.endTime, item.startTime + 31 * 86400)));
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setFormError("");
    const startTime = Math.floor(new Date(start).getTime() / 1000);
    const endTime = Math.floor(new Date(end).getTime() / 1000);
    if (endTime <= startTime) return setFormError("终止时间必须晚于起始时间");
    setCreating(true);
    try {
      await onCreate({
        strategyName, datasetId, startTime, endTime, initialCapital: capital,
        accountType,
        pfMaxDrawdown: accountType === "pf" ? pfMaxDrawdown : undefined,
        pfTarget: accountType === "pf" ? pfTarget : undefined
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return <main className="project-home">
    <header className="project-header">
      <div className="brand"><span className="brand-mark">R</span><div><strong>Replay Lab</strong><small>Parquet market replay workspace</small></div></div>
      <span>{datasets.length} 个 Parquet 数据集 · {sessions.length} 次回测</span>
    </header>
    <section className="project-content">
      <div className="project-intro"><small>BACKTEST WORKSPACE</small><h1>创建、保存并继续你的回测</h1><p>每次回测可以管理多个策略，并共享数据范围、账户资金、图表进度与总统计。</p></div>
      <div className="project-grid">
        <form className="create-card" onSubmit={submit}>
          <div className="section-label">新建回测</div>
          <label>回测名称<input required placeholder="例如：2022—2024 ES 回测" value={strategyName} onChange={(e) => setStrategyName(e.target.value)} /></label>
          <label>Parquet 数据集<select required value={datasetId} onChange={(e) => changeDataset(e.target.value)}>
            {datasets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select></label>
          {selected && <p className="dataset-meta">{selected.rowCount.toLocaleString()} 根 · {formatDate(selected.startTime)} 至 {formatDate(selected.endTime)}</p>}
          <div className="form-row">
            <label>起始时间<input required type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label>
            <label>终止时间<input required type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
          </div>
          <label>账户类型<select value={accountType} onChange={(event) => setAccountType(event.target.value as "normal" | "pf")}>
            <option value="normal">普通账户</option>
            <option value="pf">PF 考核账户</option>
          </select></label>
          <label>账户起始资金<input required type="number" min="1" step="1" value={capital} onChange={(e) => setCapital(Number(e.target.value))} /></label>
          {accountType === "pf" && <div className="form-row">
            <label>最大回撤（EOD）<input required type="number" min="1" step="1" value={pfMaxDrawdown} onChange={(e) => setPfMaxDrawdown(Number(e.target.value))} /></label>
            <label>考核盈利目标<input required type="number" min="1" step="1" value={pfTarget} onChange={(e) => setPfTarget(Number(e.target.value))} /></label>
          </div>}
          {(formError || error) && <p className="form-error">{formError || error}</p>}
          <button className="create-button" disabled={creating || !datasets.length}>{creating ? "正在创建…" : "创建并进入回测"}</button>
        </form>
        <section className="session-card">
          <div className="section-label">继续回测</div>
          {!sessions.length && <div className="empty-session"><b>还没有保存的回测</b><span>左侧创建后，进度会在操作时自动保存。</span></div>}
          <div className="session-list">{sessions.map((session) => <button key={session.id} onClick={() => onOpen(session)}>
            <div><strong>{session.strategyName}</strong><span>{session.accountType === "pf" ? "PF考核 · " : ""}{session.strategies?.length || 0} 个策略 · {datasets.find((item) => item.id === session.datasetId)?.symbol || "DATA"} · {formatDate(session.startTime)} — {formatDate(session.endTime)}</span></div>
            <div><b>{session.progress.cursor.toLocaleString()} 根</b><small>{new Date(session.updatedAt).toLocaleString("zh-CN", { hour12: false })}</small></div>
          </button>)}</div>
        </section>
      </div>
    </section>
  </main>;
}
