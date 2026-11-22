# Server Discover · Linux 服务器监控台

基于 FastAPI、SQLite 和原生 HTML/CSS/JavaScript 的单机监控页面。支持查看硬件状态、查找 PID、登记服务和停止自己登记的服务。

## 功能

| 页面 | 功能 |
| --- | --- |
| 运行总览 | 查看 CPU、物理内存、Swap、根分区和 NVIDIA GPU 的使用情况；内存、磁盘和显存有环形占比图 |
| 显卡趋势 | 查看最近 24 小时的 GPU 利用率与显存使用率趋势；支持切换显卡及查看采样明细 |
| 服务登记 | 通过 PID 登记服务名称，记录启动和停止时间、登记账号及 Linux 进程所属用户 |
| 进程查询 | 按 PID、名称或命令查进程及内存占用，一键填入登记表 |
| 登录注册 | 用户、登录会话和服务登记记录均保存在 SQLite，用户名支持中文 |

启动时立即采样，之后约每 **5 分钟**采样一次，采样数据保留 **30 天**。前端每 **30 秒**读取最新采样；刷新页面不会强制重新采样。

## 目录

```text
server-discover/
├── app.py              # FastAPI 接口、用户登录、进程操作和 SQLite 表
├── monitor.py          # CPU、内存、磁盘和 NVIDIA GPU 采集
├── static/index.html   # 前端界面
├── requirements.txt    # Python 依赖
└── monitor.sqlite3     # 运行后自动创建，不需手工建表
```

## 部署到 Linux

需要 Python 3.9+。监控 NVIDIA GPU 还需服务器能正常运行 `nvidia-smi`；没有 NVIDIA 显卡时，其余指标仍可使用。

以下以项目位于服务器 `/data/server-discover` 为例。建议创建**专用虚拟环境**，不要把依赖安装到 ComfyUI 等其他项目的虚拟环境：

```bash
cd /data/server-discover
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn app:app --host 0.0.0.0 --port 8000
```

看到 `Uvicorn running on http://0.0.0.0:8000` 后，局域网设备访问 `http://服务器IP:8000`。例如服务器地址为 `192.168.3.202`，浏览器打开 **http://192.168.3.202:8000**。首次使用先注册，再登录。保持 Uvicorn 所在终端开启；按 `Ctrl+C` 可停止程序。

`python app.py` **不会启动网页服务**：`app.py` 定义了 FastAPI 应用，需通过 `uvicorn app:app` 运行。不要以多个 Uvicorn worker 启动，否则会产生多个采样线程。

### 只通过 SSH 访问

若不想开放局域网端口，将启动参数改为 `--host 127.0.0.1`，然后在 Mac 另开终端运行：

```bash
ssh -L 8000:127.0.0.1:8000 root@192.168.3.202
```

Mac 浏览器打开 **http://127.0.0.1:8000**。SSH 连接需保持开启。如果 Mac 的 8000 端口被占用，用 `ssh -L 8001:127.0.0.1:8000 root@192.168.3.202`，浏览器改用 `http://127.0.0.1:8001`。

### 从 Mac 更新服务器文件

在 Mac 终端执行；不要覆盖服务器上的 `monitor.sqlite3`：

```bash
scp ~/Desktop/pythonproject/server-discover/app.py ~/Desktop/pythonproject/server-discover/monitor.py ~/Desktop/pythonproject/server-discover/requirements.txt root@192.168.3.202:/data/server-discover/
scp ~/Desktop/pythonproject/server-discover/static/index.html root@192.168.3.202:/data/server-discover/static/
```

只更新 `static/index.html` 时刷新浏览器即可；更新 Python 文件后需重启 Uvicorn。建议更新前备份服务器的 `monitor.sqlite3`。

## 使用与记录规则

1. 用户名可用 2–32 个汉字、英文字母、数字或下划线；密码至少 8 个字符。服务名称支持中文。
2. 在“进程查询”按 PID、名称或命令查找进程，点击“填入登记”，在“服务登记”页面填写自定义名称。
3. “开始时间”来自 Linux 进程实际启动时间；“登记用户”是当前网页登录账号；“进程所属用户”来自 Linux。登记人和进程所属用户可能不同。
4. 只有登记该服务的网页用户能点击“停止”。应用会核对 PID 及进程启动时间，然后向该进程发送 `SIGTERM`，最多等待 5 秒；不会发送 `SIGKILL`。

进程自然退出后，系统在下次采样或查看登记表时才发现退出；记录的停止时间是**发现时间**，可能晚于实际退出时间。旧数据库中的无登记用户记录会保留，但不能从页面停止；运行中的进程可以重新登记以关联当前账号。

## SQLite 数据

默认数据库是项目目录下自动创建的 `monitor.sqlite3`。可通过 `MONITOR_DB` 修改路径：

```bash
MONITOR_DB=/data/server-discover/data/monitor.sqlite3 python -m uvicorn app:app --host 0.0.0.0 --port 8000
```

| 表 | 主要内容 |
| --- | --- |
| `users` | ID、唯一用户名、随机盐密码哈希、注册时间 |
| `sessions` | 登录令牌的哈希、用户 ID、过期时间；会话有效期 7 天 |
| `services` | PID、名称、启动/登记/停止时间、状态、登记用户 ID、Linux 进程所属用户名 |
| `samples` | 采样时间和硬件数据 JSON；30 天之前的数据在采样时清理 |

账号密码与会话令牌均不以明文写入 SQLite。可用 `sqlite3 monitor.sqlite3 '.tables'` 查看表名。

## API

除注册与登录接口外，API 需携带 `Authorization: Bearer <登录返回的 token>` 请求头。FastAPI 文档页面：`http://服务器IP:8000/docs`。

| 方法与路径 | 用途 |
| --- | --- |
| `POST /api/auth/register` | 注册并登录；参数 `{"username":"张三","password":"strong-pass-123"}` |
| `POST /api/auth/login` | 登录并获取令牌；参数同上 |
| `GET /api/auth/me` | 获取当前登录用户 |
| `POST /api/auth/logout` | 注销当前会话 |
| `GET /api/metrics` | 最新一次五分钟采样 |
| `GET /api/history?limit=288` | 历史采样，默认 288 条，最多 2016 条 |
| `GET /api/processes?q=python` | 按 PID、名称或命令查进程，最多 200 条 |
| `GET /api/services` | 最近 500 条服务登记 |
| `POST /api/services` | 登记进程，参数 `{"pid":12345,"name":"模型服务"}` |
| `POST /api/services/{id}/stop` | 停止自己登记的进程 |

## 常见问题

| 现象 | 处理方法 |
| --- | --- |
| `python app.py` 没反应 | 使用上面的 `python -m uvicorn app:app ...` 启动 |
| 浏览器无法访问 | 确认监听地址和服务器 IP；运行 `ss -lntp \| grep 8000` 查看监听端口，运行 `sudo ufw status` 检查防火墙 |
| GPU 显示不可用 | 在服务器执行 `nvidia-smi` 检查 NVIDIA 驱动和显卡 |
| 趋势图尚无曲线 | 至少等待两次成功采样；首次只有一个点 |
| 停止时提示无权限 | 检查是否由当前网页账号登记，以及运行监控程序的 Linux 用户是否有权限停止目标进程 |
| 页面没显示新版 | 确认更新了 `static/index.html` 并强制刷新浏览器 |

## 访问控制

当前注册入口对能访问页面的人开放。直接使用 `http://服务器IP:8000` 时，网络传输不加密；在不完全可信的网络中建议使用 SSH 隧道，或配置 HTTPS 与访问控制。**不要直接把 8000 端口映射到公网。**

停止进程使用的是监控程序自身的 Linux 权限。若以 root 运行监控，网页停止操作也会继承 root 权限；建议使用仅拥有必要权限的专用 Linux 账号运行。
