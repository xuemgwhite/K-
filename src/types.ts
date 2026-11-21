export type Bar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Dataset = {
  id: string;
  label: string;
  bytes: number;
  modifiedAt: string;
  rowCount: number;
  startTime: number;
  endTime: number;
  symbol: string;
};

export type Side = "long" | "short";
export type Timeframe = "1s" | "15s" | "1m" | "2m" | "5m" | "15m" | "1h" | "4h" | "1d";
export type OrderType = "limit" | "stop";

export type Strategy = {
  id: string;
  name: string;
  createdAt: string;
};

export type Position = {
  id: string;
  side: Side;
  entry: number;
  stop?: number;
  target?: number;
  quantity: number;
  initialQuantity?: number;
  openedAt: number;
  exitFills?: ExitFill[];
};

export type ExitFill = {
  price: number;
  quantity: number;
  closedAt: number;
  pnl: number;
  reason: "manual" | "stop" | "target";
};

export type Trade = Position & {
  exit: number;
  closedAt: number;
  pnl: number;
  reason: "manual" | "stop" | "target";
  tradingDate?: string;
  strategyId?: string;
  tradeReason?: string;
  isBreakEven?: boolean;
};

export type PremarketNote = {
  tradingDate: string;
  text: string;
  chartTimestamp: number;
  savedAt: string;
};

export type PFPayout = {
  id: string;
  amount: number;
  at: string;
};

export type PFCycleRecord = {
  cycle: number;
  startedAtTradeIndex: number;
  endedAtTradeIndex: number;
  endedAt: string;
  status: "reset" | "busted" | "qualified";
  finalBalance: number;
  netPnl: number;
  drawdownFloor: number;
  tradeCount: number;
  payouts: PFPayout[];
  startedAt?: number;
  qualifiedAt?: number;
  daysToQualify?: number;
};

export type PFState = {
  cycleStartTradeIndex: number;
  payouts: PFPayout[];
  resetCount: number;
  cycles?: PFCycleRecord[];
  currentCycleStartedAt?: number;
};

export type PendingOrder = {
  id: string;
  side: Side;
  type: OrderType;
  price: number;
  stop?: number;
  target?: number;
  quantity: number;
  createdAt: number;
  draft?: boolean;
};

export type Point = { time: number; price: number };
export type RayDirection = "left" | "right" | "both";
export type Drawing =
  | { id: string; kind: "rectangle"; a: Point; b: Point }
  | { id: string; kind: "fib"; a: Point; b: Point }
  | { id: string; kind: "hline"; a: Point; b?: Point; direction?: RayDirection }
  | { id: string; kind: "liquidity"; a: Point; label: "BSL" | "SSL" | "BUYLI" | "SELLLI" }
  | { id: string; kind: "position"; side: Side; a: Point; b: Point; stop: number };

export type BacktestProgress = {
  cursor: number;
  replayTime?: number | null;
  position: Position | null;
  trades: Trade[];
  drawings: Drawing[];
  quantity: number;
  stopDistance: number;
  targetDistance: number;
  emaEnabled: boolean;
  emaPeriod: number;
  emaColor: string;
  emaWidth: number;
  vixRangeEnabled?: boolean;
  vixInnerEnabled?: boolean;
  vixOuterEnabled?: boolean;
  vixInnerMultiplier?: number;
  vixOuterMultiplier?: number;
  priceActionEnabled?: boolean;
  priceActionYshYsl?: boolean;
  priceActionHtf?: boolean;
  priceActionBarCount?: boolean;
  priceActionAdaptive?: boolean;
  priceActionStructure?: boolean;
  fvgEnabled?: boolean;
  fvg5m?: boolean;
  fvg15m?: boolean;
  fvg1h?: boolean;
  fvg4h?: boolean;
  fvg1d?: boolean;
  fvgShowLabels?: boolean;
  fvgUseBodyFill?: boolean;
  smtEnabled?: boolean;
  smt5m?: boolean;
  smt15m?: boolean;
  smt1h?: boolean;
  smt4h?: boolean;
  ictKillzonesEnabled?: boolean;
  ictShowBoxes?: boolean;
  ictShowPivots?: boolean;
  ictShowMidpoints?: boolean;
  ictAsia?: boolean;
  ictLondon?: boolean;
  ictNyam?: boolean;
  ictNypm?: boolean;
  ictDwm?: boolean;
  timeframe?: Timeframe;
  dualChartEnabled?: boolean;
  secondaryTimeframe?: Timeframe;
  secondaryDatasetId?: string;
  theme?: "dark" | "light";
  pendingOrders?: PendingOrder[];
  premarketNotes?: PremarketNote[];
  pfState?: PFState;
};

export type BacktestSession = {
  id: string;
  strategyName: string;
  strategies?: Strategy[];
  datasetId: string;
  startTime: number;
  endTime: number;
  initialCapital: number;
  accountType?: "normal" | "pf";
  pfMaxDrawdown?: number;
  pfTarget?: number;
  createdAt: string;
  updatedAt: string;
  progress: BacktestProgress;
};
