#!/usr/bin/env python3
"""Probe grok web: connect via WS, initialize, call _x.ai/sessions/list."""
import asyncio
import json
import sys
import websockets

SECRET = sys.argv[1] if len(sys.argv) > 1 else "4d945f036db5e221"
WS_URL = f"ws://127.0.0.1:2420/ws?server-key={SECRET}"


async def call(ws, mid, method, params=None):
    msg = {"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}}
    await ws.send(json.dumps(msg))
    raw = await asyncio.wait_for(ws.recv(), timeout=15)
    return json.loads(raw)


async def main():
    async with websockets.connect(WS_URL) as ws:
        # initialize
        r = await call(ws, 1, "initialize", {
            "protocolVersion": 1,
            "clientInfo": {"name": "probe", "version": "0.0.1"},
            "capabilities": {},
        })
        print("=== initialize ===")
        print(json.dumps(r, indent=2, ensure_ascii=False)[:2000])

        # Probe 1: _x.ai/sessions/list (roster — what web UI uses)
        print("\n=== _x.ai/sessions/list ===")
        r = await call(ws, 2, "_x.ai/sessions/list", {})
        print(json.dumps(r, indent=2, ensure_ascii=False)[:4000])

        # Probe 2: _x.ai/session/list (the singular — full session list with cwd filter)
        print("\n=== _x.ai/session/list (no cwd) ===")
        r = await call(ws, 3, "_x.ai/session/list", {})
        if isinstance(r, dict) and "result" in r:
            res = r["result"]
            if isinstance(res, dict) and "sessions" in res:
                print(f"  sessions count: {len(res['sessions'])}")
                for s in res["sessions"][:5]:
                    print(f"    - {s.get('id','?')[:24]} cwd={s.get('info',{}).get('cwd','?')[:60]} title={(s.get('session_summary') or '')[:30]}")
            else:
                print(json.dumps(res, indent=2, ensure_ascii=False)[:2000])
        else:
            print(json.dumps(r, indent=2, ensure_ascii=False)[:2000])


asyncio.run(main())