@echo off
setlocal

REM Required: set your Clash External Controller secret
set CLASH_SECRET=y123456

REM Optional: default is 127.0.0.1:9097
set CLASH_CONTROLLER=127.0.0.1:9097

REM Optional: Clash Verge proxy port used for public IP checks
set CLASH_PROXY=http://127.0.0.1:7897

REM Optional: if omitted, script detects the policy group used by public IP checks
REM set CLASH_GROUP=GLOBAL

REM Optional: default is 300ms max acceptable node delay
REM set MAX_ACCEPTABLE_DELAY_MS=300

REM Optional: default is 300000ms (5 min)
set ROTATE_INTERVAL_MS=900000
REM Optional: rotate once immediately on startup (1/0, true/false)
set ROTATE_ON_START=0

REM Optional: API server bind/port and token (token empty means no auth)
REM set API_BIND=127.0.0.1
REM set API_PORT=8787
REM set API_TOKEN=cc123456789

node "%~dp0scripts\rotate-ip.js"

endlocal
