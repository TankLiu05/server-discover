#!/bin/sh
set -eu

# Always run from the project directory, regardless of the caller's cwd.
APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PYTHON=$(command -v python3 || true)

if [ -z "$PYTHON" ]; then
    echo "错误：未找到 Python 3，请先安装 Python 3。" >&2
    exit 1
fi
if ! "$PYTHON" -c 'import uvicorn, fastapi, psutil' 2>/dev/null; then
    echo "错误：缺少依赖，请运行 python3 -m pip install -r requirements.txt。" >&2
    exit 1
fi

exec "$PYTHON" - "$APP_DIR" <<'PY'
import os
import socket
import sys

os.chdir(sys.argv[1])
for port in range(8789, 65536):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("0.0.0.0", port))
        except OSError:
            continue
    print(f"Server Discover 启动端口：{port}", flush=True)
    print(f"浏览器访问：http://<服务器局域网IP>:{port}", flush=True)
    os.execv(sys.executable, [
        sys.executable, "-m", "uvicorn", "app:app",
        "--host", "0.0.0.0", "--port", str(port),
    ])

print("错误：8789 至 65535 没有可用的 TCP 端口。", file=sys.stderr)
sys.exit(1)
PY
