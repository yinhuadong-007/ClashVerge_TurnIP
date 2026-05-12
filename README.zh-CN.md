# Clash Verge 自动换 IP

英文说明见：[README.md](./README.md)

## 前置条件
- Windows + Clash Verge，并已开启 External Controller（外部控制器）。
- Node.js 18+。
- 必须设置环境变量 `CLASH_SECRET`。

## 启动服务（PowerShell）
```powershell
$env:CLASH_SECRET = "your_api_secret"
$env:CLASH_CONTROLLER = "127.0.0.1:9097"      # 可选，默认 127.0.0.1:9097
$env:CLASH_PROXY = "http://127.0.0.1:7897"    # 可选，用于公网 IP 检测
$env:CLASH_GROUP = "GLOBAL"                   # 可选，不填时自动探测公网 IP 查询实际命中的策略组
$env:MAX_ACCEPTABLE_DELAY_MS = "300"          # 可选，最大可接受延迟
$env:ROTATE_INTERVAL_MS = "300000"            # 可选，默认 5 分钟
$env:ROTATE_ON_START = "1"                    # 可选，启动时是否立即切换一次（1/0）
$env:DISCOVER_SETTLE_MS = "1200"              # 可选，节点切换后探测IP前等待毫秒
$env:API_BIND = "127.0.0.1"                   # 可选，API 监听地址
$env:API_PORT = "8787"                        # 可选，API 端口
$env:API_TOKEN = "change_me"                  # 可选，API 鉴权 token（不设则不鉴权）
$env:DEBUG_LOGS = "1"                         # 可选，开启详细调试日志
node .\scripts\rotate-ip.js
```

- 服务会前台常驻运行。
- 使用 `Ctrl + C` 可优雅停止。

## 使用 CMD 启动
可直接运行 `run-rotate-ip.cmd`：
```bat
run-rotate-ip.cmd
```

## 状态文件
- 脚本会将状态保存在 `data/ip-state.json`。
- `lastIps` 记录成功切换过的历史公网 IP。

## API 端点
- `GET /health`：查看服务状态（无需 token）。
- `POST /rotate`：立即触发一次 IP 切换。
- 当设置了 `API_TOKEN` 时，`POST /rotate` 需要请求头 `Authorization: Bearer <token>` 或 `x-api-token: <token>`。

PowerShell 调用示例：
```powershell
Invoke-RestMethod -Method Get "http://127.0.0.1:8787/health"
Invoke-RestMethod -Method Post "http://127.0.0.1:8787/rotate" -Headers @{ "Authorization" = "Bearer change_me" }
```

## 说明
- 脚本会从候选节点中排除 `DIRECT` 与 `REJECT`。
- 公网 IP 检测会显式通过 `CLASH_PROXY` 访问，默认使用 Clash Verge 端口 `7897`。
- 不设置 `CLASH_GROUP` 时，脚本会自动探测公网 IP 查询请求实际命中的策略组，再切换该组。
- 每个周期会先遍历候选节点，探测所有可用出口 IP。
- 优先选择不在历史中的非香港 IP；当可用非香港 IP（去重）数量 `>20` 时，不使用香港 IP。
- 当可用非香港 IP（去重）数量 `<=20` 时，若没有可选非香港 IP，可回退使用香港 IP。
- 当本轮最终没有可用候选时（无论处于哪个分支），会清空历史并在同一轮重试一次。
- 如果重试后仍没有节点满足条件，则保持当前 IP 不变。
- 周期由 `ROTATE_INTERVAL_MS` 控制（默认 `300000`，即 5 分钟）。
- `ROTATE_ON_START` 控制启动后是否立即执行一次切换（默认开启；`0/false/no/off` 关闭）。
- 探测阶段每次切换后等待 `DISCOVER_SETTLE_MS`（默认 `1200`ms）再读取公网 IP。
- 默认只输出启动、摘要、成功和错误日志；设置 `DEBUG_LOGS=1` 可输出详细探测日志。
- 启动阶段失败时会返回非 0 退出码。
