import type { Bar } from "./types";

export type SMTTimeframe = "5m" | "15m" | "1H" | "4H";

export type SMTSignal = {
  id: string;
  timeframe: SMTTimeframe;
  rank: number;
  bullish: boolean;
  startTime: number;
  startPrice: number;
  endTime: number;
  endPrice: number;
  triggerTime: number;
  breakPrice: number;
  periodStart: number;
};

type Period = {
  start: number;
  high: number;
  highTime: number;
  low: number;
  lowTime: number;
};

type Settings = {
  timeframe: SMTTimeframe;
  seconds: number;
  rank: number;
  enabled: boolean;
  offset: number;
};

function bucketStart(time: number, seconds: number, offset: number) {
  return Math.floor((time - offset) / seconds) * seconds + offset;
}

function updatePeriod(period: Period | null, bar: Bar, start: number): Period {
  if (!period || period.start !== start) {
    return { start, high: bar.high, highTime: bar.time, low: bar.low, lowTime: bar.time };
  }
  if (bar.high > period.high) {
    period.high = bar.high;
    period.highTime = bar.time;
  }
  if (bar.low < period.low) {
    period.low = bar.low;
    period.lowTime = bar.time;
  }
  return period;
}

function simulateTimeframe(primary: Bar[], otherByTime: Map<number, Bar>, setting: Settings) {
  let previousPrimary: Period | null = null;
  let previousOther: Period | null = null;
  let currentPrimary: Period | null = null;
  let currentOther: Period | null = null;
  let bearDrawn = false;
  let bullDrawn = false;
  let active: SMTSignal[] = [];

  for (const bar of primary) {
    const other = otherByTime.get(bar.time);
    if (!other) continue;

    // Pine 版本在每根 1m K 线开始时先使已突破的旧信号失效。
    active = active.filter((signal) => signal.bullish
      ? bar.low >= signal.breakPrice
      : bar.high <= signal.breakPrice);

    const start = bucketStart(bar.time, setting.seconds, setting.offset);
    const isNewPeriod = currentPrimary?.start !== start;
    if (isNewPeriod) {
      previousPrimary = currentPrimary;
      previousOther = currentOther;
      currentPrimary = null;
      currentOther = null;
      bearDrawn = false;
      bullDrawn = false;
    }

    const oldHigh = currentPrimary?.high;
    const oldLow = currentPrimary?.low;
    currentPrimary = updatePeriod(currentPrimary, bar, start);
    currentOther = updatePeriod(currentOther, other, start);

    // 当前周期主品种极值更新时，替换本周期旧端点后重新判断。
    if (oldHigh != null && currentPrimary.high > oldHigh && bearDrawn) {
      active = active.filter((signal) => !(signal.periodStart === start && !signal.bullish));
      bearDrawn = false;
    }
    if (oldLow != null && currentPrimary.low < oldLow && bullDrawn) {
      active = active.filter((signal) => !(signal.periodStart === start && signal.bullish));
      bullDrawn = false;
    }

    if (!previousPrimary || !previousOther) continue;
    const primaryHigher = currentPrimary.high > previousPrimary.high;
    const otherHigher = currentOther.high > previousOther.high;
    const primaryLower = currentPrimary.low < previousPrimary.low;
    const otherLower = currentOther.low < previousOther.low;

    if (primaryHigher !== otherHigher && !bearDrawn) {
      const breakPrice = Math.max(previousPrimary.high, currentPrimary.high);
      if (bar.high <= breakPrice) {
        active.push({
          id: `${setting.timeframe}-bear-${start}`,
          timeframe: setting.timeframe,
          rank: setting.rank,
          bullish: false,
          startTime: previousPrimary.highTime,
          startPrice: previousPrimary.high,
          endTime: currentPrimary.highTime,
          endPrice: currentPrimary.high,
          triggerTime: bar.time,
          breakPrice,
          periodStart: start
        });
        bearDrawn = true;
      }
    }
    if (primaryLower !== otherLower && !bullDrawn) {
      const breakPrice = Math.min(previousPrimary.low, currentPrimary.low);
      if (bar.low >= breakPrice) {
        active.push({
          id: `${setting.timeframe}-bull-${start}`,
          timeframe: setting.timeframe,
          rank: setting.rank,
          bullish: true,
          startTime: previousPrimary.lowTime,
          startPrice: previousPrimary.low,
          endTime: currentPrimary.lowTime,
          endPrice: currentPrimary.low,
          triggerTime: bar.time,
          breakPrice,
          periodStart: start
        });
        bullDrawn = true;
      }
    }
  }
  return active;
}

export function calculateSMTSignals(
  primary: Bar[],
  other: Bar[],
  enabled: Record<SMTTimeframe, boolean>,
  lookbackDays = 30
) {
  if (!primary.length || !other.length) return [];
  const latest = primary[primary.length - 1].time;
  const cutoff = latest - lookbackDays * 86400;
  const primaryWindow = primary.filter((bar) => bar.time >= cutoff && bar.time <= latest);
  const otherByTime = new Map(other.filter((bar) => bar.time >= cutoff && bar.time <= latest).map((bar) => [bar.time, bar]));
  const settings: Settings[] = [
    { timeframe: "5m", seconds: 300, rank: 5, enabled: enabled["5m"], offset: 0 },
    { timeframe: "15m", seconds: 900, rank: 15, enabled: enabled["15m"], offset: 0 },
    { timeframe: "1H", seconds: 3600, rank: 60, enabled: enabled["1H"], offset: 0 },
    // CME 4H K 线使用 22:00/02:00/06:00 UTC 一组边界。
    { timeframe: "4H", seconds: 14400, rank: 240, enabled: enabled["4H"], offset: 7200 }
  ];

  let signals = settings
    .filter((setting) => setting.enabled)
    .flatMap((setting) => simulateTimeframe(primaryWindow, otherByTime, setting));

  // 同一触发时刻同方向优先保留更高周期。
  const best = new Map<string, SMTSignal>();
  for (const signal of signals) {
    const key = `${signal.bullish ? "bull" : "bear"}-${signal.triggerTime}`;
    const existing = best.get(key);
    if (!existing || signal.rank > existing.rank) best.set(key, signal);
  }
  signals = [...best.values()];

  // 高周期信号净化其端点范围内同方向的低周期信号。
  signals = signals.filter((candidate) => !signals.some((higher) =>
    higher !== candidate
    && higher.bullish === candidate.bullish
    && higher.rank > candidate.rank
    && candidate.startTime >= Math.min(higher.startTime, higher.endTime)
    && candidate.endTime <= Math.max(higher.startTime, higher.endTime)
  ));

  return signals.sort((a, b) => a.triggerTime - b.triggerTime).slice(-160);
}
