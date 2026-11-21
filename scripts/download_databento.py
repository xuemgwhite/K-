"""Download Databento OHLCV data into data/processed.

Install once:
    python3 -m pip install databento python-dotenv

Configure .env from .env.example, then:
    npm run download:data
"""

from __future__ import annotations

import os
from pathlib import Path

import databento as db
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")

api_key = os.environ["DATABENTO_API_KEY"]
dataset = os.getenv("DATABENTO_DATASET", "GLBX.MDP3")
symbol = os.getenv("DATABENTO_SYMBOL", "NQ.c.0")
start = os.environ["DATABENTO_START"]
end = os.environ["DATABENTO_END"]
schema = os.getenv("DATABENTO_SCHEMA", "ohlcv-1m")

safe_symbol = symbol.replace("/", "-").replace(".", "_")
output = ROOT / "data" / "processed" / f"{safe_symbol}_{schema}_{start}_{end}.parquet"
output.parent.mkdir(parents=True, exist_ok=True)

client = db.Historical(api_key)
data = client.timeseries.get_range(
    dataset=dataset,
    symbols=[symbol],
    stype_in="continuous",
    schema=schema,
    start=start,
    end=end,
)
data.to_parquet(output)
print(f"Saved: {output}")
