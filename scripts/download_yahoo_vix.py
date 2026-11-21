#!/usr/bin/env python3
import json
import ssl
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

import pandas as pd
import certifi


START = int(datetime(2021, 1, 1, tzinfo=timezone.utc).timestamp())
END = int(datetime(2025, 1, 2, tzinfo=timezone.utc).timestamp())
symbol = "^VIX"
url = (
    f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(symbol)}"
    f"?period1={START}&period2={END}&interval=1d&events=history"
)
request = Request(url, headers={"User-Agent": "Mozilla/5.0 ReplayLab/1.0"})
ssl_context = ssl.create_default_context(cafile=certifi.where())
with urlopen(request, timeout=30, context=ssl_context) as response:
    payload = json.load(response)

result = payload["chart"]["result"][0]
quote_data = result["indicators"]["quote"][0]
rows = []
for index, timestamp in enumerate(result["timestamp"]):
    close = quote_data["close"][index]
    if close is None:
        continue
    rows.append({
        "ts_event": pd.Timestamp(timestamp, unit="s", tz="UTC"),
        "open": quote_data["open"][index],
        "high": quote_data["high"][index],
        "low": quote_data["low"][index],
        "close": close,
        "volume": quote_data["volume"][index] or 0,
        "symbol": symbol,
    })

output = Path(__file__).resolve().parents[1] / "data" / "processed" / "_VIX_YAHOO_1d.parquet"
pd.DataFrame(rows).to_parquet(output, index=False)
print(json.dumps({"file": str(output), "rows": len(rows), "first": rows[0]["ts_event"].isoformat(), "last": rows[-1]["ts_event"].isoformat()}))
