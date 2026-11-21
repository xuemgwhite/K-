from __future__ import annotations

import math
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

random.seed(7)
root = Path(__file__).resolve().parents[1]
output = root / "data" / "processed" / "DEMO_NQ_1m.parquet"
output.parent.mkdir(parents=True, exist_ok=True)

start = datetime(2025, 1, 6, 14, 30, tzinfo=timezone.utc)
price = 21420.0
rows = []
for i in range(900):
    drift = math.sin(i / 45) * 1.2 + math.sin(i / 130) * 2.1
    shock = random.gauss(0, 4.4)
    open_ = price
    close = open_ + drift + shock
    high = max(open_, close) + abs(random.gauss(2.4, 1.5))
    low = min(open_, close) - abs(random.gauss(2.4, 1.5))
    rows.append({
        "ts_event": start + timedelta(minutes=i),
        "open": round(open_, 2),
        "high": round(high, 2),
        "low": round(low, 2),
        "close": round(close, 2),
        "volume": random.randint(80, 950),
        "symbol": "DEMO.NQ",
    })
    price = close

pq.write_table(pa.Table.from_pylist(rows), output)

print(output)
