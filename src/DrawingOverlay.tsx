import { useEffect, useMemo, useRef, useState } from "react";
import type { IChartApi, ISeriesApi, Time, UTCTimestamp } from "lightweight-charts";
import type { Bar, Drawing, PendingOrder, Point, Position, RayDirection, Side } from "./types";
import { calculateSMTSignals } from "./smt";

export type Tool = "cursor" | "rectangle" | "fib" | "hline" | "bsl" | "ssl" | "buyli" | "sellli" | "long" | "short";
export type { Drawing, RayDirection };

type Props = {
  host: HTMLDivElement | null;
  chart: IChartApi | null;
  series: ISeriesApi<"Candlestick"> | null;
  tool: Tool;
  rayDirection: RayDirection;
  drawings: Drawing[];
  onDrawingsChange: (drawings: Drawing[]) => void;
  position: Position | null;
  onPositionChange: (position: Position | null) => void;
  onFinishTool: () => void;
  barInterval: number;
  lastBarTime?: number;
  pendingOrders: PendingOrder[];
  onPendingOrdersChange: (orders: PendingOrder[]) => void;
  currentPrice?: number;
  pointValue: number;
  quantityStep: number;
  orderQuantity: number;
  onClosePosition: () => void;
  onExecutePendingOrder: (id: string) => void;
  visibleBars: Bar[];
  clearSelectionSignal: number;
  vixBars: Bar[];
  vixRangeEnabled: boolean;
  vixInnerEnabled: boolean;
  vixOuterEnabled: boolean;
  vixInnerMultiplier: number;
  vixOuterMultiplier: number;
  priceActionEnabled: boolean;
  priceActionYshYsl: boolean;
  priceActionHtf: boolean;
  priceActionBarCount: boolean;
  priceActionAdaptive: boolean;
  priceActionStructure: boolean;
  timeframeSeconds: number;
  fvgBars: Bar[];
  fvgSourceBars: Array<{ seconds: number; bars: Bar[] }>;
  fvgEnabled: boolean;
  fvg5m: boolean;
  fvg15m: boolean;
  fvg1h: boolean;
  fvg4h: boolean;
  fvg1d: boolean;
  fvgShowLabels: boolean;
  smtPrimaryBars: Bar[];
  smtOtherBars: Bar[];
  smtEnabled: boolean;
  smt5m: boolean;
  smt15m: boolean;
  smt1h: boolean;
  smt4h: boolean;
  ictKillzonesEnabled: boolean;
  ictShowBoxes: boolean;
  ictShowPivots: boolean;
  ictShowMidpoints: boolean;
  ictAsia: boolean;
  ictLondon: boolean;
  ictNyam: boolean;
  ictNypm: boolean;
  ictDwm: boolean;
};

const FIB_LEVELS = [0, 0.5, 0.618, 1, 1.5, 2];
const PA_NY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});
const PA_TIME_CACHE = new Map<number, { date: string; minutes: number; weekday: string }>();

function priceActionTimeInfo(time: number) {
  const cached = PA_TIME_CACHE.get(time);
  if (cached) return cached;
  const value = Object.fromEntries(PA_NY_FORMATTER.formatToParts(new Date(time * 1000)).map((part) => [part.type, part.value]));
  const result = {
    date: `${value.year}-${value.month}-${value.day}`,
    minutes: Number(value.hour) * 60 + Number(value.minute),
    weekday: value.weekday
  };
  PA_TIME_CACHE.set(time, result);
  return result;
}

function timeNumber(time: Time | null): number | null {
  return typeof time === "number" ? Number(time) : null;
}

export default function DrawingOverlay(props: Props) {
  const { host, chart, series, tool, rayDirection, drawings, onDrawingsChange, position, onPositionChange, onFinishTool, barInterval, lastBarTime, pendingOrders, onPendingOrdersChange, currentPrice, pointValue, quantityStep, orderQuantity, onClosePosition, onExecutePendingOrder, visibleBars, clearSelectionSignal, vixBars, vixRangeEnabled, vixInnerEnabled, vixOuterEnabled, vixInnerMultiplier, vixOuterMultiplier, priceActionEnabled, priceActionYshYsl, priceActionHtf, priceActionBarCount, priceActionAdaptive, priceActionStructure, timeframeSeconds, fvgBars, fvgSourceBars, fvgEnabled, fvg5m, fvg15m, fvg1h, fvg4h, fvg1d, fvgShowLabels, smtPrimaryBars, smtOtherBars, smtEnabled, smt5m, smt15m, smt1h, smt4h, ictKillzonesEnabled, ictShowBoxes, ictShowPivots, ictShowMidpoints, ictAsia, ictLondon, ictNyam, ictNypm, ictDwm } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const draftRef = useRef<Point | null>(null);
  const [draft, setDraft] = useState<Point | null>(null);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [draggingLine, setDraggingLine] = useState<string | null>(null);

  useEffect(() => {
    if (!chart || !host) return;
    const rerender = () => setRevision((value) => value + 1);
    chart.timeScale().subscribeVisibleLogicalRangeChange(rerender);
    const resize = new ResizeObserver(rerender);
    resize.observe(host);
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(rerender);
      resize.disconnect();
    };
  }, [chart, host]);

  useEffect(() => {
    const remove = (event: KeyboardEvent) => {
      if (!selected || (event.key !== "Delete" && event.key !== "Backspace")) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      onDrawingsChange(drawings.filter((item) => item.id !== selected));
      setSelected(null);
    };
    window.addEventListener("keydown", remove);
    return () => window.removeEventListener("keydown", remove);
  }, [selected, drawings, onDrawingsChange]);

  useEffect(() => {
    setSelected(null);
  }, [clearSelectionSignal]);

  const size = useMemo(() => ({ width: host?.clientWidth || 0, height: host?.clientHeight || 0 }), [host, revision]);
  const nonUsSessionRanges = useMemo(() => {
    const isUsSession = (time: number) => {
      const values = priceActionTimeInfo(time + barInterval / 2);
      return values.weekday !== "Sat" && values.weekday !== "Sun" && values.minutes >= 570 && values.minutes < 960;
    };
    const ranges: Array<{ start: number; end: number }> = [];
    let start: number | null = null;
    visibleBars.forEach((bar, index) => {
      const outside = !isUsSession(bar.time);
      if (outside && start == null) start = bar.time;
      if (!outside && start != null) {
        ranges.push({ start, end: bar.time });
        start = null;
      }
      if (index === visibleBars.length - 1 && start != null) ranges.push({ start, end: bar.time + barInterval });
    });
    return ranges;
  }, [visibleBars, barInterval]);

  const vixRanges = useMemo(() => {
    if (!vixRangeEnabled || !visibleBars.length || !vixBars.length) return [];
    const parts = (time: number) => priceActionTimeInfo(time + barInterval / 2);
    const dateKey = (value: { date: string }) => value.date;
    const vixByDate = vixBars
      .map((bar) => {
        const value = parts(bar.time);
        return { date: dateKey(value), close: bar.close };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
    const sessions = new Map<string, { start: number; end: number; open: number }>();
    for (const bar of visibleBars) {
      const value = parts(bar.time);
      if (value.weekday === "Sat" || value.weekday === "Sun" || value.minutes < 570 || value.minutes >= 960) continue;
      const date = dateKey(value);
      const session = sessions.get(date);
      if (!session) sessions.set(date, { start: bar.time, end: bar.time + barInterval, open: bar.open });
      else session.end = bar.time + barInterval;
    }
    return [...sessions.entries()].slice(-120).flatMap(([date, session]) => {
      const prior = [...vixByDate].reverse().find((item) => item.date < date);
      if (!prior) return [];
      const sigma = session.open * (prior.close / 100) / Math.sqrt(252);
      return [{
        date, ...session, vixClose: prior.close,
        innerHigh: session.open + sigma * vixInnerMultiplier,
        innerLow: session.open - sigma * vixInnerMultiplier,
        outerHigh: session.open + sigma * vixOuterMultiplier,
        outerLow: session.open - sigma * vixOuterMultiplier
      }];
    });
  }, [vixRangeEnabled, visibleBars, vixBars, barInterval, vixInnerMultiplier, vixOuterMultiplier]);

  const fvgZones = useMemo(() => {
    if (!fvgEnabled || lastBarTime == null) return [];
    type Zone = {
      id: string; timeframe: string; seconds: number; bullish: boolean;
      start: number; top: number; bottom: number;
    };
    const settings = [
      { seconds: 300, timeframe: "5m", enabled: fvg5m, maximum: 12, calcBars: 3000 },
      { seconds: 900, timeframe: "15m", enabled: fvg15m, maximum: 16, calcBars: 3000 },
      { seconds: 3600, timeframe: "1H", enabled: fvg1h, maximum: 24, calcBars: 3000 },
      { seconds: 14400, timeframe: "4H", enabled: fvg4h, maximum: 24, calcBars: 3000 },
      { seconds: 86400, timeframe: "D", enabled: fvg1d, maximum: 24, calcBars: 1500 }
    ].filter((item) => item.enabled);
    const result: Zone[] = [];
    for (const setting of settings) {
      const aggregated = fvgSourceBars.find((item) => item.seconds === setting.seconds)?.bars || [];
      let low = 0;
      let high = aggregated.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (aggregated[middle].time + setting.seconds <= lastBarTime) low = middle + 1;
        else high = middle;
      }
      const confirmed = aggregated.slice(Math.max(0, low - setting.calcBars), low);
      let active: Zone[] = [];
      for (let index = 2; index < confirmed.length; index++) {
        const first = confirmed[index - 2];
        const middle = confirmed[index - 1];
        const third = confirmed[index];

        // 与 Pine 版本一致：已有区域只能被所属源周期的已确认实体收盘
        // 越过远端边界后删除，低周期影线触碰不会使其失效。
        active = active.filter((zone) => zone.bullish
          ? third.close >= zone.bottom
          : third.close <= zone.top);
        if (third.low > first.high) {
          active.push({
            id: `${setting.timeframe}-${third.time}-bull`, timeframe: setting.timeframe,
            seconds: setting.seconds, bullish: true, start: middle.time,
            top: third.low, bottom: first.high
          });
        }
        if (third.high < first.low) {
          active.push({
            id: `${setting.timeframe}-${third.time}-bear`, timeframe: setting.timeframe,
            seconds: setting.seconds, bullish: false, start: middle.time,
            top: first.low, bottom: third.high
          });
        }
        if (active.length > setting.maximum) active = active.slice(-setting.maximum);
      }
      result.push(...active);
    }
    return result;
  }, [fvgEnabled, fvgSourceBars, lastBarTime, fvg5m, fvg15m, fvg1h, fvg4h, fvg1d]);

  const smtSignals = useMemo(() => smtEnabled
    ? calculateSMTSignals(smtPrimaryBars, smtOtherBars, {
      "5m": smt5m, "15m": smt15m, "1H": smt1h, "4H": smt4h
    })
    : [], [smtEnabled, smtPrimaryBars, smtOtherBars, smt5m, smt15m, smt1h, smt4h]);

  const ictData = useMemo(() => {
    if (!ictKillzonesEnabled || timeframeSeconds > 1800 || !fvgBars.length) return null;
    type Session = {
      id: string; title: string; kind: string; start: number; end: number;
      high: number; low: number; highTime: number; lowTime: number;
      highEnd: number; lowEnd: number;
    };
    const definitions = [
      { title: "ASIA", kind: "asia", from: 1200, to: 1440, enabled: ictAsia },
      { title: "LNDN", kind: "london", from: 120, to: 300, enabled: ictLondon },
      { title: "NYAM", kind: "nyam", from: 570, to: 660, enabled: ictNyam },
      { title: "NYPM", kind: "nypm", from: 810, to: 960, enabled: ictNypm }
    ].filter((item) => item.enabled);
    const sessions: Session[] = [];
    for (const definition of definitions) {
      const grouped = new Map<string, Session>();
      for (const bar of fvgBars) {
        const info = priceActionTimeInfo(bar.time);
        if (info.minutes < definition.from || info.minutes >= definition.to) continue;
        const id = `${definition.kind}-${info.date}`;
        const existing = grouped.get(id);
        if (!existing) {
          grouped.set(id, {
            id, title: definition.title, kind: definition.kind,
            start: bar.time, end: bar.time + 60,
            high: bar.high, low: bar.low, highTime: bar.time, lowTime: bar.time,
            highEnd: bar.time + 60, lowEnd: bar.time + 60
          });
        } else {
          existing.end = bar.time + 60;
          if (bar.high > existing.high) { existing.high = bar.high; existing.highTime = bar.time; }
          if (bar.low < existing.low) { existing.low = bar.low; existing.lowTime = bar.time; }
        }
      }
      const recent = [...grouped.values()].slice(-3);
      for (const session of recent) {
        const after = fvgBars.filter((bar) => bar.time >= session.end);
        const highHit = after.find((bar) => bar.high > session.high);
        const lowHit = after.find((bar) => bar.low < session.low);
        const currentEnd = lastBarTime == null ? session.end : lastBarTime + barInterval;
        session.highEnd = highHit?.time ?? currentEnd;
        session.lowEnd = lowHit?.time ?? currentEnd;
        sessions.push(session);
      }
    }

    type Period = { key: string; start: number; end: number; high: number; low: number };
    type DwmLevel = { id: string; label: string; kind: string; start: number; end: number; price: number; midpoint?: boolean };
    const levels: DwmLevel[] = [];
    if (ictDwm) {
      const mondayKey = (date: string) => {
        const value = new Date(`${date}T12:00:00Z`);
        const weekday = value.getUTCDay() || 7;
        value.setUTCDate(value.getUTCDate() - weekday + 1);
        return value.toISOString().slice(0, 10);
      };
      const families = [
        { kind: "day", prefix: "PD", key: (bar: Bar) => priceActionTimeInfo(bar.time).date },
        { kind: "week", prefix: "PW", key: (bar: Bar) => mondayKey(priceActionTimeInfo(bar.time).date) },
        { kind: "month", prefix: "PM", key: (bar: Bar) => priceActionTimeInfo(bar.time).date.slice(0, 7) }
      ];
      for (const family of families) {
        const periods: Period[] = [];
        for (const bar of fvgBars) {
          const key = family.key(bar);
          const last = periods[periods.length - 1];
          if (!last || last.key !== key) periods.push({ key, start: bar.time, end: bar.time + 60, high: bar.high, low: bar.low });
          else {
            last.end = bar.time + 60;
            last.high = Math.max(last.high, bar.high);
            last.low = Math.min(last.low, bar.low);
          }
        }
        for (let index = Math.max(1, periods.length - 3); index < periods.length; index++) {
          const previous = periods[index - 1];
          const current = periods[index];
          const end = index + 1 < periods.length ? periods[index + 1].start : (lastBarTime ?? current.end) + barInterval;
          levels.push(
            { id: `${family.kind}-${current.key}-h`, label: `${family.prefix}H`, kind: family.kind, start: current.start, end, price: previous.high },
            { id: `${family.kind}-${current.key}-l`, label: `${family.prefix}L`, kind: family.kind, start: current.start, end, price: previous.low },
            { id: `${family.kind}-${current.key}-m`, label: `${family.prefix}M`, kind: family.kind, start: current.start, end, price: (previous.high + previous.low) / 2, midpoint: true }
          );
        }
      }
    }
    return { sessions, levels };
  }, [ictKillzonesEnabled, timeframeSeconds, fvgBars, ictAsia, ictLondon, ictNyam, ictNypm, ictDwm, lastBarTime, barInterval]);

  const priceActionData = useMemo(() => {
    if (!priceActionEnabled || !visibleBars.length) return null;
    const paBars = visibleBars.slice(-5000);
    const info = priceActionTimeInfo;
    const previousDate = (date: string) => {
      const value = new Date(`${date}T12:00:00Z`);
      value.setUTCDate(value.getUTCDate() - 1);
      return value.toISOString().slice(0, 10);
    };
    const sessionKey = (bar: Bar) => {
      const value = info(bar.time);
      return value.minutes >= 1080 ? value.date : previousDate(value.date);
    };

    const dayMap = new Map<string, { date: string; high: number; low: number; highTime: number; lowTime: number; end: number }>();
    for (const bar of paBars) {
      const date = info(bar.time).date;
      const day = dayMap.get(date);
      if (!day) dayMap.set(date, { date, high: bar.high, low: bar.low, highTime: bar.time, lowTime: bar.time, end: bar.time + barInterval });
      else {
        if (bar.high > day.high) { day.high = bar.high; day.highTime = bar.time; }
        if (bar.low < day.low) { day.low = bar.low; day.lowTime = bar.time; }
        day.end = bar.time + barInterval;
      }
    }
    const days = [...dayMap.values()];
    const yshYsl = days.slice(0, -1).slice(-5);

    let countDate = "", runningCount = 0;
    const barCounts = paBars.map((bar) => {
      const date = info(bar.time).date;
      if (date !== countDate) { countDate = date; runningCount = 1; } else runningCount += 1;
      return runningCount % 3 === 0 ? { bar, count: runningCount } : null;
    }).filter(Boolean).slice(-350) as Array<{ bar: Bar; count: number }>;

    const left = 5, right = 5, breakBars = 3;
    let adaptiveHigh: { price: number; time: number } | null = null;
    let adaptiveLow: { price: number; time: number } | null = null;
    let highBreak = 0, lowBreak = 0;
    const pivotsHigh = new Map<number, number>();
    const pivotsLow = new Map<number, number>();
    for (let confirmed = left + right; confirmed < paBars.length; confirmed++) {
      const pivotIndex = confirmed - right;
      const window = paBars.slice(pivotIndex - left, pivotIndex + right + 1);
      const candidate = paBars[pivotIndex];
      if (candidate.high === Math.max(...window.map((bar) => bar.high))) pivotsHigh.set(confirmed, pivotIndex);
      if (candidate.low === Math.min(...window.map((bar) => bar.low))) pivotsLow.set(confirmed, pivotIndex);
    }
    for (let index = 0; index < paBars.length; index++) {
      const bar = paBars[index];
      const highPivot = pivotsHigh.get(index);
      const lowPivot = pivotsLow.get(index);
      if (highPivot != null) { adaptiveHigh = { price: paBars[highPivot].high, time: paBars[highPivot].time }; highBreak = 0; }
      if (lowPivot != null) { adaptiveLow = { price: paBars[lowPivot].low, time: paBars[lowPivot].time }; lowBreak = 0; }
      if (adaptiveHigh) {
        highBreak = bar.close > adaptiveHigh.price ? highBreak + 1 : 0;
        if (highBreak >= breakBars) {
          const recent = paBars.slice(index - breakBars + 1, index + 1);
          const peak = recent.reduce((best, item) => item.high > best.high ? item : best);
          adaptiveHigh = { price: peak.high, time: peak.time }; highBreak = 0;
        }
      }
      if (adaptiveLow) {
        lowBreak = bar.close < adaptiveLow.price ? lowBreak + 1 : 0;
        if (lowBreak >= breakBars) {
          const recent = paBars.slice(index - breakBars + 1, index + 1);
          const trough = recent.reduce((best, item) => item.low < best.low ? item : best);
          adaptiveLow = { price: trough.low, time: trough.time }; lowBreak = 0;
        }
      }
    }

    const trueRanges = paBars.map((bar, index) => index === 0
      ? bar.high - bar.low
      : Math.max(bar.high - bar.low, Math.abs(bar.high - paBars[index - 1].close), Math.abs(bar.low - paBars[index - 1].close)));
    const atrAt = (index: number) => {
      const start = Math.max(0, index - 13);
      const values = trueRanges.slice(start, index + 1);
      return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    };
    type StructureLine = { a: Point; b: Point; label: string; kind: "bull" | "bear" | "sweepBull" | "sweepBear" };
    const structures: StructureLine[] = [];
    let activeSession = "";
    let prevLow: { price: number; time: number } | null = null;
    let prevHigh: { price: number; time: number } | null = null;
    let lowRecovery: { previous: Point; broken: Point; expires: number } | null = null;
    let highRecovery: { previous: Point; broken: Point; expires: number } | null = null;
    for (let index = 0; index < paBars.length; index++) {
      const bar = paBars[index];
      const key = sessionKey(bar);
      if (key !== activeSession) {
        activeSession = key; prevLow = null; prevHigh = null; lowRecovery = null; highRecovery = null;
      }
      const lowPivot = pivotsLow.get(index);
      const highPivot = pivotsHigh.get(index);
      if (lowPivot != null && sessionKey(paBars[lowPivot]) === key) {
        const current = { price: paBars[lowPivot].low, time: paBars[lowPivot].time };
        const atr = atrAt(index);
        if (prevLow && current.price > prevLow.price && current.price - prevLow.price >= atr * 0.3) {
          structures.push({ a: { time: prevLow.time, price: prevLow.price }, b: { time: current.time, price: current.price }, label: "HL DB", kind: "bull" });
        } else if (prevLow && current.price < prevLow.price && prevLow.price - current.price >= atr * 0.15) {
          lowRecovery = { previous: { time: prevLow.time, price: prevLow.price }, broken: { time: current.time, price: current.price }, expires: index + 5 };
        }
        prevLow = current;
      }
      if (highPivot != null && sessionKey(paBars[highPivot]) === key) {
        const current = { price: paBars[highPivot].high, time: paBars[highPivot].time };
        const atr = atrAt(index);
        if (prevHigh && current.price < prevHigh.price && prevHigh.price - current.price >= atr * 0.3) {
          structures.push({ a: { time: prevHigh.time, price: prevHigh.price }, b: { time: current.time, price: current.price }, label: "LH DT", kind: "bear" });
        } else if (prevHigh && current.price > prevHigh.price && current.price - prevHigh.price >= atr * 0.15) {
          highRecovery = { previous: { time: prevHigh.time, price: prevHigh.price }, broken: { time: current.time, price: current.price }, expires: index + 5 };
        }
        prevHigh = current;
      }
      if (lowRecovery && index <= lowRecovery.expires && bar.close >= lowRecovery.previous.price + atrAt(index) * 0.1) {
        structures.push({ a: lowRecovery.previous, b: lowRecovery.broken, label: "LL DB", kind: "sweepBull" }); lowRecovery = null;
      } else if (lowRecovery && index > lowRecovery.expires) lowRecovery = null;
      if (highRecovery && index <= highRecovery.expires && bar.close <= highRecovery.previous.price - atrAt(index) * 0.1) {
        structures.push({ a: highRecovery.previous, b: highRecovery.broken, label: "HH DT", kind: "sweepBear" }); highRecovery = null;
      } else if (highRecovery && index > highRecovery.expires) highRecovery = null;
    }

    const autoSeconds = timeframeSeconds <= 60 ? [300, 900, 3600]
      : timeframeSeconds <= 300 ? [900, 3600]
        : timeframeSeconds <= 900 ? [3600, 28800]
          : [28800];
    const htfGroups = autoSeconds.map((seconds) => {
      const aggregated: Bar[] = [];
      for (const bar of paBars) {
        const bucket = Math.floor(bar.time / seconds) * seconds;
        const last = aggregated[aggregated.length - 1];
        if (!last || last.time !== bucket) aggregated.push({ ...bar, time: bucket });
        else {
          last.high = Math.max(last.high, bar.high); last.low = Math.min(last.low, bar.low);
          last.close = bar.close; last.volume += bar.volume;
        }
      }
      return { seconds, bars: aggregated.slice(seconds === 300 ? -10 : seconds === 900 ? -8 : -4) };
    });
    return { yshYsl, barCounts, adaptiveHigh, adaptiveLow, structures: structures.slice(-120), htfGroups };
  }, [priceActionEnabled, visibleBars, barInterval, timeframeSeconds]);

  function pointFromClient(clientX: number, clientY: number): Point | null {
    if (!svgRef.current || !chart || !series) return null;
    const bounds = svgRef.current.getBoundingClientRect();
    const x = clientX - bounds.left;
    let time = timeNumber(chart.timeScale().coordinateToTime(x));
    if (time == null && lastBarTime != null) {
      const lastX = chart.timeScale().timeToCoordinate(lastBarTime as UTCTimestamp);
      const logical = chart.timeScale().coordinateToLogical(x);
      const lastLogical = lastX == null ? null : chart.timeScale().coordinateToLogical(lastX);
      if (logical != null && lastLogical != null) {
        time = Math.round(lastBarTime + (logical - lastLogical) * barInterval);
      } else if (lastX != null) {
        const spacing = chart.timeScale().options().barSpacing || 6;
        time = Math.round(lastBarTime + ((x - lastX) / spacing) * barInterval);
      }
    }
    const price = series.coordinateToPrice(clientY - bounds.top);
    return time == null || price == null ? null : { time, price };
  }

  function pointFromEvent(event: React.PointerEvent): Point | null {
    return pointFromClient(event.clientX, event.clientY);
  }

  function coords(point: Point) {
    if (!chart || !series) return null;
    let x: number | null = chart.timeScale().timeToCoordinate(point.time as UTCTimestamp);
    if (x == null && lastBarTime != null) {
      const lastX = chart.timeScale().timeToCoordinate(lastBarTime as UTCTimestamp);
      if (lastX != null) {
        const spacing = chart.timeScale().options().barSpacing || 6;
        x = lastX + ((point.time - lastBarTime) / barInterval) * spacing;
      }
    }
    const y = series.priceToCoordinate(point.price);
    return x == null || y == null ? null : { x, y };
  }

  function timeCoordinate(time: number) {
    if (!chart) return null;
    let x: number | null = chart.timeScale().timeToCoordinate(time as UTCTimestamp);
    if (x == null && lastBarTime != null) {
      const lastX = chart.timeScale().timeToCoordinate(lastBarTime as UTCTimestamp);
      if (lastX != null) {
        const spacing = chart.timeScale().options().barSpacing || 6;
        x = lastX + ((time - lastBarTime) / barInterval) * spacing;
      }
    }
    return x;
  }

  function replace(id: string, update: (drawing: Drawing) => Drawing) {
    onDrawingsChange(drawings.map((drawing) => drawing.id === id ? update(drawing) : drawing));
  }

  function startDrag(event: React.PointerEvent, drawing: Drawing, handle: "body" | "a" | "b" | "stop" = "body") {
    if (tool !== "cursor") return;
    event.preventDefault();
    event.stopPropagation();
    setSelected(drawing.id);
    const origin = pointFromEvent(event);
    if (!origin) return;
    const original = structuredClone(drawing);
    const move = (moveEvent: PointerEvent) => {
      const now = pointFromClient(moveEvent.clientX, moveEvent.clientY);
      if (!now) return;
      const dt = now.time - origin.time;
      const dp = now.price - origin.price;
      replace(drawing.id, () => {
        if (original.kind === "hline" && original.b) {
          if (handle === "a") return {
            ...original,
            a: { time: now.time, price: now.price },
            b: { ...original.b, price: now.price }
          };
          if (handle === "b") return {
            ...original,
            a: { ...original.a, price: now.price },
            b: { time: now.time, price: now.price }
          };
          return {
            ...original,
            a: { time: original.a.time + dt, price: original.a.price + dp },
            b: { time: original.b.time + dt, price: original.b.price + dp }
          };
        }
        if (handle === "a") return { ...original, a: now };
        if (handle === "b" && "b" in original) return { ...original, b: now };
        if (handle === "stop" && original.kind === "position") return { ...original, stop: now.price };
        if (original.kind === "hline" || original.kind === "liquidity") return { ...original, a: { time: original.a.time + dt, price: original.a.price + dp } };
        const moved = {
          ...original,
          a: { time: original.a.time + dt, price: original.a.price + dp },
          b: { time: original.b.time + dt, price: original.b.price + dp }
        };
        return original.kind === "position" ? { ...moved, stop: original.stop + dp } : moved;
      });
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function begin(event: React.PointerEvent<SVGSVGElement>) {
    if (tool === "cursor") {
      if (event.target === svgRef.current) setSelected(null);
      return;
    }
    const point = pointFromEvent(event);
    if (!point) return;
    draftRef.current = point;
    setDraft(point);
    svgRef.current?.setPointerCapture(event.pointerId);
  }

  function end(event: React.PointerEvent<SVGSVGElement>) {
    const a = draftRef.current;
    const b = pointFromEvent(event);
    draftRef.current = null;
    setDraft(null);
    if (!a || !b) return;
    const liquidityTool = tool === "bsl" || tool === "ssl" || tool === "buyli" || tool === "sellli";
    if (!liquidityTool && Math.abs(a.time - b.time) < 1) return;
    const id = crypto.randomUUID();
    let drawing: Drawing | null = null;
    if (tool === "hline") drawing = { id, kind: "hline", a, b: { time: b.time, price: a.price } };
    if (liquidityTool) drawing = { id, kind: "liquidity", a, label: tool.toUpperCase() as "BSL" | "SSL" | "BUYLI" | "SELLLI" };
    if (tool === "rectangle") drawing = { id, kind: "rectangle", a, b };
    if (tool === "fib") drawing = { id, kind: "fib", a, b };
    if (tool === "long" || tool === "short") {
      const side: Side = tool;
      const risk = Math.max(Math.abs(b.price - a.price) / 2, 0.25);
      drawing = { id, kind: "position", side, a, b, stop: side === "long" ? a.price - risk : a.price + risk };
    }
    if (drawing) {
      onDrawingsChange([...drawings, drawing]);
      setSelected(id);
    }
    onFinishTool();
  }

  function remove(event: React.PointerEvent, id: string) {
    event.preventDefault();
    event.stopPropagation();
    onDrawingsChange(drawings.filter((item) => item.id !== id));
    setSelected(null);
  }

  function handles(drawing: Drawing) {
    if (selected !== drawing.id) return null;
    const a = coords(drawing.a);
    const b = "b" in drawing && drawing.b ? coords(drawing.b) : null;
    if (!a) return null;
    return <>
      <circle cx={a.x} cy={a.y} r={5} className="drawing-handle" onPointerDown={(e) => startDrag(e, drawing, "a")} />
      {b && <circle cx={b.x} cy={b.y} r={5} className="drawing-handle" onPointerDown={(e) => startDrag(e, drawing, "b")} />}
      {drawing.kind === "position" && series && (() => {
        const stopY = series.priceToCoordinate(drawing.stop);
        return stopY == null ? null : <circle cx={b?.x ?? a.x} cy={stopY} r={5} className="drawing-handle stop-handle" onPointerDown={(e) => startDrag(e, drawing, "stop")} />;
      })()}
      <g className="drawing-delete" onPointerDown={(e) => remove(e, drawing.id)}>
        <circle cx={Math.min(size.width - 12, (b?.x ?? a.x) + 14)} cy={Math.max(12, Math.min(a.y, b?.y ?? a.y) - 14)} r={9} />
        <text x={Math.min(size.width - 12, (b?.x ?? a.x) + 14)} y={Math.max(12, Math.min(a.y, b?.y ?? a.y) - 14) + 3}>×</text>
      </g>
    </>;
  }

  function renderDrawing(drawing: Drawing) {
    const active = selected === drawing.id;
    if (drawing.kind === "hline") {
      const p = coords(drawing.a);
      if (!p) return null;
      if (drawing.b) {
        const end = coords(drawing.b);
        if (!end) return null;
        const x1 = Math.min(p.x, end.x);
        const x2 = Math.max(p.x, end.x);
        return <g key={drawing.id}>
          <line x1={x1} x2={x2} y1={p.y} y2={p.y} className={`drawing-line ${active ? "selected" : ""}`} onPointerDown={(e) => startDrag(e, drawing)} />
          <text x={Math.min(size.width - 58, Math.max(5, x2 + 6))} y={p.y - 6} className="drawing-label">{drawing.a.price.toFixed(2)}</text>
          {handles(drawing)}
        </g>;
      }
      const x1 = drawing.direction === "right" ? p.x : 0;
      const x2 = drawing.direction === "left" ? p.x : size.width;
      return <g key={drawing.id}>
        <line x1={x1} x2={x2} y1={p.y} y2={p.y} className={`drawing-line ${active ? "selected" : ""}`} onPointerDown={(e) => startDrag(e, drawing)} />
        <text x={Math.min(size.width - 58, Math.max(5, p.x + 6))} y={p.y - 6} className="drawing-label direction-toggle"
          onPointerDown={(e) => { e.stopPropagation(); replace(drawing.id, (item) => item.kind === "hline" ? { ...item, direction: item.direction === "right" ? "both" : item.direction === "both" ? "left" : "right" } : item); }}>
          {drawing.a.price.toFixed(2)} · {drawing.direction === "left" ? "←" : drawing.direction === "right" ? "→" : "↔"}
        </text>
        {handles(drawing)}
      </g>;
    }
    if (drawing.kind === "liquidity") {
      const p = coords(drawing.a);
      if (!p) return null;
      return <g key={drawing.id}>
        <line x1={p.x} x2={size.width} y1={p.y} y2={p.y}
          className={`liquidity-ray ${active ? "selected" : ""}`}
          onPointerDown={(event) => startDrag(event, drawing)} />
        <text x={size.width - 10} y={p.y - 6} textAnchor="end" className="liquidity-ray-label"
          onPointerDown={(event) => startDrag(event, drawing)}>{drawing.label}</text>
        {handles(drawing)}
      </g>;
    }
    const a = coords(drawing.a);
    const b = coords(drawing.b);
    if (!a || !b) return null;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const width = Math.abs(a.x - b.x), height = Math.abs(a.y - b.y);
    if (drawing.kind === "rectangle") return <g key={drawing.id}>
      <rect x={x} y={y} width={width} height={height} className={`drawing-rectangle ${active ? "selected" : ""}`} onPointerDown={(e) => startDrag(e, drawing)} />
      {handles(drawing)}
    </g>;
    if (drawing.kind === "fib") return <g key={drawing.id}>
      <g onPointerDown={(e) => startDrag(e, drawing)}>
        {FIB_LEVELS.map((level) => {
          const lineY = a.y + (b.y - a.y) * level;
          return <g key={level}><line x1={x} x2={x + width} y1={lineY} y2={lineY} className={`fib-line ${active ? "selected" : ""}`} /><text x={x + 4} y={lineY - 4} className="drawing-label">{level}</text></g>;
        })}
      </g>
      {handles(drawing)}
    </g>;
    const stopY = series?.priceToCoordinate(drawing.stop);
    if (stopY == null) return null;
    const risk = Math.abs(drawing.a.price - drawing.stop);
    const reward = Math.abs(drawing.b.price - drawing.a.price);
    const direction = drawing.side === "long" ? 1 : -1;
    const quantity = Math.max(quantityStep, orderQuantity || quantityStep);
    const targetPnl = (drawing.b.price - drawing.a.price) * direction * quantity * pointValue;
    const stopPnl = (drawing.stop - drawing.a.price) * direction * quantity * pointValue;
    const signedUsd = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)} USD`;
    return <g key={drawing.id}>
      <g onPointerDown={(e) => startDrag(e, drawing)}>
        <rect x={x} width={Math.max(width, 100)} y={Math.min(a.y, b.y)} height={Math.abs(a.y - b.y)} className="reward-zone" />
        <rect x={x} width={Math.max(width, 100)} y={Math.min(a.y, stopY)} height={Math.abs(a.y - stopY)} className="risk-zone" />
        <line x1={x} x2={Math.min(size.width, x + Math.max(width, 100))} y1={a.y} y2={a.y} className="entry-line" />
        <text x={x + 6} y={a.y - 6} className="position-label">
          {drawing.side === "long" ? "多仓" : "空仓"} · 入场 {drawing.a.price.toFixed(2)} · {quantity}手 · RR {risk ? (reward / risk).toFixed(2) : "0.00"}
        </text>
        <text x={x + 6} y={b.y - 6} className="position-label success">
          止盈 {drawing.b.price.toFixed(2)} · {signedUsd(targetPnl)}
        </text>
        <text x={x + 6} y={stopY - 6} className="position-label danger">
          止损 {drawing.stop.toFixed(2)} · {signedUsd(stopPnl)}
        </text>
      </g>
      {handles(drawing)}
    </g>;
  }

  function dragPrice(event: React.PointerEvent, onPrice: (price: number) => void, onEnd?: () => void) {
    event.stopPropagation();
    if (!svgRef.current || !series) return;
    const bounds = svgRef.current.getBoundingClientRect();
    const move = (moveEvent: PointerEvent) => {
      const price = series.coordinateToPrice(moveEvent.clientY - bounds.top);
      if (price != null) onPrice(price);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      onEnd?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function livePosition() {
    if (!position || !series) return null;
    const entryY = series.priceToCoordinate(position.entry);
    const stopY = position.stop == null ? null : series.priceToCoordinate(position.stop);
    const targetY = position.target == null ? null : series.priceToCoordinate(position.target);
    if (entryY == null) return null;
    const direction = position.side === "long" ? 1 : -1;
    const pnl = currentPrice == null ? 0 : (currentPrice - position.entry) * direction * position.quantity * pointValue;
    const stopPnl = position.stop == null ? 0 : (position.stop - position.entry) * direction * position.quantity * pointValue;
    const targetPnl = position.target == null ? 0 : (position.target - position.entry) * direction * position.quantity * pointValue;
    const axisWidth = chart?.priceScale("right").width() || 70;
    const controlX = Math.max(130, size.width - axisWidth - 244);
    return <g className="live-position">
      <line x1={0} x2={size.width} y1={entryY} y2={entryY} className={`live-entry-line ${pnl >= 0 ? "profit" : "loss"}`} />
      <text x={8} y={entryY - 7} className="entry-price-label">{position.side === "long" ? "BUY" : "SELL"} · {position.entry.toFixed(2)}</text>
      {position.target == null && <g className="position-add-button" onPointerDown={(e) => {
        setDraggingLine(`${position.id}:target`);
        dragPrice(e, (price) => onPositionChange({ ...position, target: price }), () => setDraggingLine(null));
      }}>
        <rect x={controlX - 116} y={entryY - 14} width={54} height={25} /><text x={controlX - 89} y={entryY + 2}>＋TP</text>
      </g>}
      {position.stop == null && <g className="position-add-button sl" onPointerDown={(e) => {
        setDraggingLine(`${position.id}:stop`);
        dragPrice(e, (price) => onPositionChange({ ...position, stop: price }), () => setDraggingLine(null));
      }}>
        <rect x={controlX - 58} y={entryY - 14} width={54} height={25} /><text x={controlX - 31} y={entryY + 2}>＋SL</text>
      </g>}
      <g className={`floating-pnl ${pnl >= 0 ? "profit" : "loss"}`}>
        <rect x={controlX} y={entryY - 14} width={200} height={25} /><text x={controlX + 100} y={entryY + 2}>{position.quantity} · {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)} USD</text>
      </g>
      <g className="position-close" onPointerDown={(e) => { e.stopPropagation(); onClosePosition(); }}>
        <rect x={controlX + 204} y={entryY - 14} width={32} height={25} /><text x={controlX + 220} y={entryY + 3}>×</text>
      </g>
      {stopY != null && <>
        <line x1={0} x2={size.width} y1={stopY} y2={stopY} className="stop-line drag-line" onPointerDown={(e) => dragPrice(e, (price) => onPositionChange({ ...position, stop: price }))} />
        <text x={8} y={stopY - 7} className="position-label danger">SL · {position.stop!.toFixed(2)}</text>
        <g className="projected-pnl loss" onPointerDown={(e) => dragPrice(e, (price) => onPositionChange({ ...position, stop: price }))}>
          <rect x={controlX} y={stopY - 14} width={200} height={25} /><text x={controlX + 100} y={stopY + 2}>{position.quantity} · {stopPnl >= 0 ? "+" : ""}{stopPnl.toFixed(2)} USD</text>
        </g>
        <g className="line-remove loss" onPointerDown={(e) => { e.stopPropagation(); onPositionChange({ ...position, stop: undefined }); }}>
          <rect x={controlX + 204} y={stopY - 14} width={32} height={25} /><text x={controlX + 220} y={stopY + 3}>×</text>
        </g>
      </>}
      {targetY != null && <>
        <line x1={0} x2={size.width} y1={targetY} y2={targetY} className="target-line drag-line" onPointerDown={(e) => dragPrice(e, (price) => onPositionChange({ ...position, target: price }))} />
        <text x={8} y={targetY - 7} className="position-label success">TP · {position.target!.toFixed(2)}</text>
        <g className="projected-pnl profit" onPointerDown={(e) => dragPrice(e, (price) => onPositionChange({ ...position, target: price }))}>
          <rect x={controlX} y={targetY - 14} width={200} height={25} /><text x={controlX + 100} y={targetY + 2}>{position.quantity} · {targetPnl >= 0 ? "+" : ""}{targetPnl.toFixed(2)} USD</text>
        </g>
        <g className="line-remove profit" onPointerDown={(e) => { e.stopPropagation(); onPositionChange({ ...position, target: undefined }); }}>
          <rect x={controlX + 204} y={targetY - 14} width={32} height={25} /><text x={controlX + 220} y={targetY + 3}>×</text>
        </g>
      </>}
    </g>;
  }

  function pendingOrderLines() {
    if (!series) return null;
    return pendingOrders.map((order) => {
      const entryY = series.priceToCoordinate(order.price);
      const stopY = order.stop == null ? null : series.priceToCoordinate(order.stop);
      const targetY = order.target == null ? null : series.priceToCoordinate(order.target);
      if (entryY == null) return null;
      const update = (field: "price" | "stop" | "target", value: number) =>
        onPendingOrdersChange(pendingOrders.map((item) => item.id === order.id ? { ...item, [field]: value } : item));
      const updateQuantity = (quantity: number) =>
        onPendingOrdersChange(pendingOrders.map((item) => item.id === order.id ? { ...item, quantity: Math.max(quantityStep, quantity) } : item));
      const remove = () => onPendingOrdersChange(pendingOrders.filter((item) => item.id !== order.id));
      const direction = order.side === "long" ? 1 : -1;
      const stopPnl = order.stop == null ? 0 : (order.stop - order.price) * direction * order.quantity * pointValue;
      const targetPnl = order.target == null ? 0 : (order.target - order.price) * direction * order.quantity * pointValue;
      const axisWidth = chart?.priceScale("right").width() || 70;
      const controlX = Math.max(130, size.width - axisWidth - 332);
      return <g key={order.id} className="pending-order-lines">
        <line x1={0} x2={size.width} y1={entryY} y2={entryY}
          className={`pending-entry drag-line ${draggingLine === `${order.id}:entry` ? "dragging" : ""}`}
          onPointerDown={(e) => { setDraggingLine(`${order.id}:entry`); dragPrice(e, (price) => update("price", price), () => setDraggingLine(null)); }} />
        <text x={8} y={entryY - 7} className="entry-price-label">{order.draft ? "待确认" : "等待成交"} · {order.price.toFixed(2)}</text>
        <g className={`order-side-chip ${order.side} ${order.draft ? "" : "confirmed"}`} onPointerDown={(e) => {
          e.stopPropagation();
          if (order.draft) onExecutePendingOrder(order.id);
        }}><rect x={controlX} y={entryY - 14} width={48} height={24} /><text x={controlX + 24} y={entryY + 2}>{order.draft ? (order.side === "long" ? "Buy" : "Sell") : (order.type === "limit" ? "Limit" : "Stop")}</text></g>
        {order.target == null && <g className="order-inline-button tp" onPointerDown={(e) => {
          setDraggingLine(`${order.id}:target`);
          dragPrice(e, (price) => update("target", price), () => setDraggingLine(null));
        }}><rect x={controlX + 56} y={entryY - 14} width={44} height={24} /><text x={controlX + 78} y={entryY + 2}>＋TP</text></g>}
        {order.stop == null && <g className="order-inline-button sl" onPointerDown={(e) => {
          setDraggingLine(`${order.id}:stop`);
          dragPrice(e, (price) => update("stop", price), () => setDraggingLine(null));
        }}><rect x={controlX + 108} y={entryY - 14} width={44} height={24} /><text x={controlX + 130} y={entryY + 2}>＋SL</text></g>}
        <foreignObject x={controlX + 160} y={entryY - 14} width={64} height={25} className="order-quantity">
          <input type="number" min={quantityStep} step={quantityStep} value={order.quantity} onPointerDown={(e) => e.stopPropagation()} onChange={(e) => updateQuantity(Number(e.target.value))} />
        </foreignObject>
        <g className="order-cancel" onPointerDown={(e) => { e.stopPropagation(); remove(); }}><rect x={controlX + 232} y={entryY - 14} width={54} height={24} /><text x={controlX + 259} y={entryY + 3}>×</text></g>
        {stopY != null && <>
          <line x1={0} x2={size.width} y1={stopY} y2={stopY} className={`stop-line drag-line ${draggingLine === `${order.id}:stop` ? "dragging" : ""}`}
            onPointerDown={(e) => { setDraggingLine(`${order.id}:stop`); dragPrice(e, (price) => update("stop", price), () => setDraggingLine(null)); }} />
          <g className="draft-projected-pnl loss" onPointerDown={(e) => { setDraggingLine(`${order.id}:stop`); dragPrice(e, (price) => update("stop", price), () => setDraggingLine(null)); }}>
            <rect x={controlX + 70} y={stopY - 13} width={180} height={24} /><text x={controlX + 160} y={stopY + 3}>{order.quantity} · {stopPnl >= 0 ? "+" : ""}{stopPnl.toFixed(2)} USD</text>
          </g>
        </>}
        {targetY != null && <>
          <line x1={0} x2={size.width} y1={targetY} y2={targetY} className={`target-line drag-line ${draggingLine === `${order.id}:target` ? "dragging" : ""}`}
            onPointerDown={(e) => { setDraggingLine(`${order.id}:target`); dragPrice(e, (price) => update("target", price), () => setDraggingLine(null)); }} />
          <g className="draft-projected-pnl profit" onPointerDown={(e) => { setDraggingLine(`${order.id}:target`); dragPrice(e, (price) => update("target", price), () => setDraggingLine(null)); }}>
            <rect x={controlX + 70} y={targetY - 13} width={180} height={24} /><text x={controlX + 160} y={targetY + 3}>{order.quantity} · {targetPnl >= 0 ? "+" : ""}{targetPnl.toFixed(2)} USD</text>
          </g>
        </>}
      </g>;
    });
  }

  const draftDrawing: Drawing | null = draft && draftRef.current
    ? tool === "hline" ? { id: "draft", kind: "hline", a: draftRef.current, b: { time: draft.time, price: draftRef.current.price } }
      : tool === "bsl" || tool === "ssl" || tool === "buyli" || tool === "sellli" ? { id: "draft", kind: "liquidity", a: draftRef.current, label: tool.toUpperCase() as "BSL" | "SSL" | "BUYLI" | "SELLLI" }
      : tool === "rectangle" ? { id: "draft", kind: "rectangle", a: draftRef.current, b: draft }
      : tool === "fib" ? { id: "draft", kind: "fib", a: draftRef.current, b: draft }
        : tool === "long" || tool === "short" ? { id: "draft", kind: "position", side: tool, a: draftRef.current, b: draft, stop: tool === "long" ? draftRef.current.price - Math.abs(draft.price - draftRef.current.price) / 2 : draftRef.current.price + Math.abs(draft.price - draftRef.current.price) / 2 }
          : null
    : null;

  const shading = <svg className="session-overlay" width={size.width} height={size.height}>
    <g className="session-shading">
      {nonUsSessionRanges.map((range, index) => {
        const left = timeCoordinate(range.start);
        const right = timeCoordinate(range.end);
        if (left == null || right == null) return null;
        return <rect key={`${range.start}-${index}`} x={left} y={0} width={Math.max(0, right - left)} height={size.height} />;
      })}
    </g>
  </svg>;

  return <>
    {shading}
    <svg ref={svgRef} className={`drawing-overlay tool-${tool}`} width={size.width} height={size.height}
      onPointerDown={begin} onPointerMove={(e) => { if (draftRef.current) { const point = pointFromEvent(e); if (point) setDraft(point); } }} onPointerUp={end}>
      {tool === "rectangle" && draft && (() => {
        const point = coords(draft);
        return point ? <g className="rectangle-draft-guides">
          <line x1={0} x2={size.width} y1={point.y} y2={point.y} />
          <line x1={point.x} x2={point.x} y1={0} y2={size.height} />
          <circle cx={point.x} cy={point.y} r={3} />
        </g> : null;
      })()}
      {vixRangeEnabled && <g className="vix-range-lines">
        {vixRanges.map((range) => {
          const start = coords({ time: range.start, price: range.open });
          const end = coords({ time: range.end, price: range.open });
          if (!start || !end || !series) return null;
          const lines = [
            ...(vixInnerEnabled ? [
              { price: range.innerHigh, label: `+${vixInnerMultiplier}σ`, kind: "inner up" },
              { price: range.innerLow, label: `−${vixInnerMultiplier}σ`, kind: "inner down" }
            ] : []),
            ...(vixOuterEnabled ? [
              { price: range.outerHigh, label: `+${vixOuterMultiplier}σ`, kind: "outer up" },
              { price: range.outerLow, label: `−${vixOuterMultiplier}σ`, kind: "outer down" }
            ] : [])
          ];
          return <g key={range.date}>{lines.map((line) => {
            const y = series.priceToCoordinate(line.price);
            if (y == null) return null;
            return <g key={line.kind}>
              <line x1={start.x} x2={end.x} y1={y} y2={y} className={`vix-band ${line.kind}`} />
              <text x={Math.max(start.x + 3, end.x - 38)} y={y - 3} className={`vix-band-label ${line.kind}`}>{line.label}</text>
            </g>;
          })}</g>;
        })}
      </g>}
      {fvgEnabled && series && <g className="fvg-zones">
        {fvgZones.map((zone) => {
          const start = coords({ time: zone.start, price: zone.top });
          const topY = series.priceToCoordinate(zone.top);
          const bottomY = series.priceToCoordinate(zone.bottom);
          if (!start || topY == null || bottomY == null) return null;
          const y = Math.min(topY, bottomY);
          const height = Math.max(1, Math.abs(bottomY - topY));
          const x = Math.max(0, start.x);
          const width = Math.max(0, size.width - x);
          const midpointY = y + height / 2;
          return <g key={zone.id} className={`fvg-zone ${zone.bullish ? "bull" : "bear"} tf-${zone.timeframe.toLowerCase()}`}>
            <rect x={x} y={y} width={width} height={height} />
            <line className="fvg-midline" x1={x} x2={x + width} y1={midpointY} y2={midpointY} />
            {fvgShowLabels && <text x={x + 5} y={y + 11}>{zone.timeframe} {zone.bullish ? "看涨" : "看跌"} FVG</text>}
          </g>;
        })}
      </g>}
      {smtEnabled && <g className="smt-signals">
        {smtSignals.map((signal) => {
          const start = coords({ time: signal.startTime, price: signal.startPrice });
          const end = coords({ time: signal.endTime, price: signal.endPrice });
          if (!start || !end) return null;
          const labelX = (start.x + end.x) / 2;
          const labelY = (start.y + end.y) / 2 + (signal.bullish ? 14 : -6);
          return <g key={signal.id} className={`smt-signal ${signal.bullish ? "bull" : "bear"} tf-${signal.timeframe.toLowerCase()}`}>
            <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
            <circle cx={start.x} cy={start.y} r={2.5} />
            <circle cx={end.x} cy={end.y} r={2.5} />
            <text x={labelX} y={labelY} textAnchor="middle">{signal.timeframe} SMT</text>
          </g>;
        })}
      </g>}
      {ictData && series && <g className="ict-killzones">
        {ictData.sessions.map((session) => {
          const start = coords({ time: session.start, price: session.high });
          const end = coords({ time: session.end, price: session.low });
          const highStart = coords({ time: session.highTime, price: session.high });
          const highEnd = coords({ time: session.highEnd, price: session.high });
          const lowStart = coords({ time: session.lowTime, price: session.low });
          const lowEnd = coords({ time: session.lowEnd, price: session.low });
          if (!start || !end) return null;
          const top = series.priceToCoordinate(session.high);
          const bottom = series.priceToCoordinate(session.low);
          if (top == null || bottom == null) return null;
          return <g key={session.id} className={`ict-session ${session.kind}`}>
            {ictShowBoxes && <><rect x={start.x} y={Math.min(top, bottom)} width={Math.max(1, end.x - start.x)} height={Math.max(1, Math.abs(bottom - top))} />
              <text x={start.x + 4} y={Math.min(top, bottom) + 11}>{session.title}</text></>}
            {ictShowPivots && highStart && highEnd && <><line x1={highStart.x} x2={highEnd.x} y1={highStart.y} y2={highEnd.y} className="ict-pivot high" />
              <text x={highEnd.x + 3} y={highEnd.y - 3} className="ict-pivot-label">{session.title} H</text></>}
            {ictShowPivots && lowStart && lowEnd && <><line x1={lowStart.x} x2={lowEnd.x} y1={lowStart.y} y2={lowEnd.y} className="ict-pivot low" />
              <text x={lowEnd.x + 3} y={lowEnd.y + 10} className="ict-pivot-label">{session.title} L</text></>}
            {ictShowMidpoints && (() => {
              const mid = (session.high + session.low) / 2;
              const a = coords({ time: session.end, price: mid });
              const b = coords({ time: lastBarTime ?? session.end, price: mid });
              return a && b ? <line x1={a.x} x2={b.x} y1={a.y} y2={b.y} className="ict-midpoint" /> : null;
            })()}
          </g>;
        })}
        {ictData.levels.map((level) => {
          const a = coords({ time: level.start, price: level.price });
          const b = coords({ time: level.end, price: level.price });
          return a && b ? <g key={level.id} className={`ict-dwm ${level.kind} ${level.midpoint ? "midpoint" : ""}`}>
            <line x1={a.x} x2={b.x} y1={a.y} y2={b.y} />
            <text x={Math.min(size.width - 35, b.x + 3)} y={b.y - 3}>{level.label}</text>
          </g> : null;
        })}
      </g>}
      {priceActionData && <g className="price-action-overlay">
        {priceActionYshYsl && priceActionData.yshYsl.map((day) => {
          const highStart = coords({ time: day.highTime, price: day.high });
          const lowStart = coords({ time: day.lowTime, price: day.low });
          const highEnd = coords({ time: day.end, price: day.high });
          const lowEnd = coords({ time: day.end, price: day.low });
          return <g key={day.date}>
            {highStart && highEnd && <><line x1={highStart.x} x2={highEnd.x} y1={highStart.y} y2={highEnd.y} className="pa-ysh" /><text x={highEnd.x - 22} y={highEnd.y - 4} className="pa-label pa-high">YSH</text></>}
            {lowStart && lowEnd && <><line x1={lowStart.x} x2={lowEnd.x} y1={lowStart.y} y2={lowEnd.y} className="pa-ysl" /><text x={lowEnd.x - 22} y={lowEnd.y + 11} className="pa-label pa-low">YSL</text></>}
          </g>;
        })}
        {priceActionBarCount && priceActionData.barCounts.map(({ bar, count }) => {
          const point = coords({ time: bar.time, price: bar.low });
          return point ? <text key={`${bar.time}-${count}`} x={point.x} y={point.y + 13} className="pa-bar-count">{count}</text> : null;
        })}
        {priceActionAdaptive && lastBarTime != null && <>
          {priceActionData.adaptiveHigh && (() => {
            const a = coords({ time: priceActionData.adaptiveHigh.time, price: priceActionData.adaptiveHigh.price });
            const b = coords({ time: lastBarTime, price: priceActionData.adaptiveHigh.price });
            return a && b ? <><line x1={a.x} x2={b.x} y1={a.y} y2={b.y} className="pa-adaptive-high" /><text x={b.x + 4} y={b.y - 3} className="pa-label pa-high">AH</text></> : null;
          })()}
          {priceActionData.adaptiveLow && (() => {
            const a = coords({ time: priceActionData.adaptiveLow.time, price: priceActionData.adaptiveLow.price });
            const b = coords({ time: lastBarTime, price: priceActionData.adaptiveLow.price });
            return a && b ? <><line x1={a.x} x2={b.x} y1={a.y} y2={b.y} className="pa-adaptive-low" /><text x={b.x + 4} y={b.y + 10} className="pa-label pa-low">AL</text></> : null;
          })()}
        </>}
        {priceActionStructure && priceActionData.structures.map((item, index) => {
          const a = coords(item.a), b = coords(item.b);
          if (!a || !b) return null;
          return <g key={`${item.a.time}-${item.b.time}-${index}`}>
            <line x1={a.x} x2={b.x} y1={a.y} y2={b.y} className={`pa-structure ${item.kind}`} />
            <text x={b.x + 3} y={b.y + (item.kind.includes("Bull") || item.kind === "bull" ? 12 : -5)} className={`pa-label ${item.kind}`}>{item.label}</text>
          </g>;
        })}
        {priceActionHtf && series && lastBarTime != null && (() => {
          const last = coords({ time: lastBarTime, price: visibleBars[visibleBars.length - 1]?.close || 0 });
          if (!last) return null;
          let groupX = Math.max(last.x + 32, size.width - 315);
          return <g className="pa-htf-candles">
            {priceActionData.htfGroups.map((group) => {
              const startX = groupX;
              groupX += group.bars.length * 8 + 22;
              const label = group.seconds < 3600 ? `${group.seconds / 60}m` : `${group.seconds / 3600}h`;
              return <g key={group.seconds}>
                <text x={startX} y={18} className="pa-htf-label">{label}</text>
                {group.bars.map((bar, index) => {
                  const x = startX + index * 8;
                  const openY = series.priceToCoordinate(bar.open), closeY = series.priceToCoordinate(bar.close);
                  const highY = series.priceToCoordinate(bar.high), lowY = series.priceToCoordinate(bar.low);
                  if (openY == null || closeY == null || highY == null || lowY == null) return null;
                  const up = bar.close >= bar.open;
                  return <g key={bar.time}>
                    <line x1={x} x2={x} y1={highY} y2={lowY} className={`pa-htf-wick ${up ? "up" : "down"}`} />
                    <rect x={x - 2.5} y={Math.min(openY, closeY)} width={5} height={Math.max(1, Math.abs(openY - closeY))} className={`pa-htf-body ${up ? "up" : "down"}`} />
                  </g>;
                })}
              </g>;
            })}
          </g>;
        })()}
      </g>}
      {drawings.map(renderDrawing)}
      {draftDrawing && renderDrawing(draftDrawing)}
      {pendingOrderLines()}
      {livePosition()}
    </svg>
  </>;
}
