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

REM Optional: default is 20 recent IPs
REM set IP_HISTORY_LIMIT=20

REM Optional: default is 300ms max acceptable node delay
REM set MAX_ACCEPTABLE_DELAY_MS=300

REM Optional: default is 300000ms (5 min)
set ROTATE_INTERVAL_MS=1800000

node D:\A_Tools\ClashVerge_TurnIP\scripts\rotate-ip.js

endlocal
