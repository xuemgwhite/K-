import json
import sys
from datetime import datetime, timezone

import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.parquet as pq


def metadata(path):
    schema = pq.ParquetFile(path).schema_arrow
    columns = ["ts_event"] + (["symbol"] if "symbol" in schema.names else [])
    table = pq.read_table(path, columns=columns)
    times = table["ts_event"]
    symbols = table["symbol"].drop_null() if "symbol" in table.column_names else []
    return {
        "rowCount": table.num_rows,
        "startTime": int(pc.min(times).as_py().timestamp()),
        "endTime": int(pc.max(times).as_py().timestamp()),
        "symbol": symbols[0].as_py() if len(symbols) else "",
    }


def bars(path, options):
    from_ts = int(options.get("from", 0))
    to_ts = int(options.get("to", 2**63 - 1))
    limit = int(options.get("limit", 300000))
    source = ds.dataset(path, format="parquet")
    time_field = ds.field("ts_event")
    expression = (
        (time_field >= datetime.fromtimestamp(from_ts, timezone.utc))
        & (time_field <= datetime.fromtimestamp(to_ts, timezone.utc))
    )
    table = source.scanner(
        columns=["ts_event", "open", "high", "low", "close", "volume"],
        filter=expression,
    ).head(limit + 1)
    has_more = table.num_rows > limit
    table = table.slice(0, limit)
    rows = []
    data = table.to_pydict()
    for i, ts in enumerate(data["ts_event"]):
        rows.append({
            "time": int(ts.timestamp()),
            "open": float(data["open"][i]),
            "high": float(data["high"][i]),
            "low": float(data["low"][i]),
            "close": float(data["close"][i]),
            "volume": float(data["volume"][i]),
        })
    return {"bars": rows, "hasMore": has_more}


command, path = sys.argv[1:3]
options = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
result = metadata(path) if command == "metadata" else bars(path, options)
print(json.dumps(result, separators=(",", ":")))
