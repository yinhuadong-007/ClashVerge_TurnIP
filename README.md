# Clash Verge Turn IP

中文说明见：[README.zh-CN.md](./README.zh-CN.md)

## Prerequisites
- Windows + Clash Verge with External Controller enabled.
- Node.js 18+.
- Environment variable `CLASH_SECRET` must be set.

## Run Service (PowerShell)
```powershell
$env:CLASH_SECRET = "your_api_secret"
$env:CLASH_CONTROLLER = "127.0.0.1:9097"      # optional, default is 127.0.0.1:9097
$env:CLASH_PROXY = "http://127.0.0.1:7897"    # optional, used for public IP checks
$env:CLASH_GROUP = "GLOBAL"                   # optional, detects the public-IP route group when omitted
$env:IP_HISTORY_LIMIT = "50"                  # optional, recent IP history size
$env:MAX_ACCEPTABLE_DELAY_MS = "300"          # optional, max acceptable node delay
$env:ROTATE_INTERVAL_MS = "300000"            # optional, default 5 minutes
$env:DISCOVER_SETTLE_MS = "1200"              # optional, wait before IP check after each switch
$env:API_BIND = "127.0.0.1"                   # optional, API listen address
$env:API_PORT = "8787"                        # optional, API port
$env:API_TOKEN = "change_me"                  # optional, API auth token (no auth when empty)
$env:DEBUG_LOGS = "1"                         # optional, enables detailed debug logs
node .\scripts\rotate-ip.js
```

- The service runs in foreground.
- Press `Ctrl + C` to stop gracefully.

## Run with CMD file
Use `run-rotate-ip.cmd`:
```bat
run-rotate-ip.cmd
```

## State File
- Script stores recent state in `data/ip-state.json`.
- `lastIps` keeps the latest `IP_HISTORY_LIMIT` accepted public IPs, defaulting to 50.

## API Endpoints
- `GET /health`: returns current service status (no token required).
- `POST /rotate`: triggers one immediate IP-rotation cycle.
- When `API_TOKEN` is set, `POST /rotate` requires `Authorization: Bearer <token>` or `x-api-token: <token>`.

PowerShell examples:
```powershell
Invoke-RestMethod -Method Get "http://127.0.0.1:8787/health"
Invoke-RestMethod -Method Post "http://127.0.0.1:8787/rotate" -Headers @{ "Authorization" = "Bearer change_me" }
```

## Notes
- The script excludes `DIRECT` and `REJECT` from candidate nodes.
- Public IP checks explicitly use `CLASH_PROXY`, defaulting to Clash Verge port `7897`.
- When `CLASH_GROUP` is omitted, the script detects the policy group actually used by public IP checks.
- Each cycle first discovers all candidate nodes' reachable public IPs.
- It stops as soon as it finds a node whose IP is outside recent history and whose delay is <= `MAX_ACCEPTABLE_DELAY_MS`.
- If every reachable IP is already in history, it falls back to the oldest historical IP that still exists and has delay <= `MAX_ACCEPTABLE_DELAY_MS`.
- If no node matches either the new-IP rule or fallback rule, the current IP is left unchanged.
- Each cycle is scheduled with `ROTATE_INTERVAL_MS` (default `300000`, i.e. 5 minutes).
- Discovery waits `DISCOVER_SETTLE_MS` (default `1200` ms) before checking IP.
- By default only startup, summary, success, and error logs are printed; set `DEBUG_LOGS=1` for detailed discovery logs.
- Exit code is non-zero on startup failure.
