"""Small, single-host Linux process and GPU dashboard."""

import json
import hashlib
import hmac
import os
import re
import secrets
import unicodedata
import sqlite3
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import psutil
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from monitor import host_metrics

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv("MONITOR_DB", str(ROOT / "monitor.sqlite3")))
INTERVAL = 300
SESSION_SECONDS = 7 * 86400


def connect():
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=10000")
    return db


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("""CREATE TABLE IF NOT EXISTS samples (
            id INTEGER PRIMARY KEY, sampled_at REAL NOT NULL, data TEXT NOT NULL
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS services (
            id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, name TEXT NOT NULL,
            started_at REAL NOT NULL, registered_at REAL NOT NULL,
            stopped_at REAL, status TEXT NOT NULL DEFAULT 'running',
            user_id INTEGER REFERENCES users(id), started_by TEXT
        )""")
        columns = {row["name"] for row in db.execute("PRAGMA table_info(services)")}
        if "user_id" not in columns:
            db.execute("ALTER TABLE services ADD COLUMN user_id INTEGER REFERENCES users(id)")
        if "started_by" not in columns:
            db.execute("ALTER TABLE services ADD COLUMN started_by TEXT")
        db.execute("""CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL, created_at REAL NOT NULL
        )""")
        db.execute("""CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at REAL NOT NULL
        )""")
        db.execute("CREATE INDEX IF NOT EXISTS idx_samples_time ON samples(sampled_at DESC)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_services_user ON services(user_id)")


def process_matches(pid, started_at):
    try:
        proc = psutil.Process(pid)
        return proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE and abs(proc.create_time() - started_at) < 1
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return False


def reconcile_services():
    with connect() as db:
        rows = db.execute("SELECT id, pid, started_at FROM services WHERE status='running'").fetchall()
        for row in rows:
            if not process_matches(row["pid"], row["started_at"]):
                db.execute("UPDATE services SET status='exited', stopped_at=? WHERE id=? AND status='running'",
                           (time.time(), row["id"]))


def save_sample():
    data = host_metrics()
    with connect() as db:
        db.execute("INSERT INTO samples(sampled_at, data) VALUES (?, ?)",
                   (data["timestamp"], json.dumps(data)))
        # Keep 30 days of 5-minute samples.
        db.execute("DELETE FROM samples WHERE sampled_at < ?", (time.time() - 30 * 86400,))
    reconcile_services()


def sampling_loop(stop):
    while not stop.is_set():
        start = time.monotonic()
        try:
            save_sample()
        except Exception as exc:
            print(f"采样失败: {exc}", flush=True)
        stop.wait(max(0, INTERVAL - (time.monotonic() - start)))


@asynccontextmanager
async def lifespan(_app):
    init_db()
    stop = threading.Event()
    worker = threading.Thread(target=sampling_loop, args=(stop,), daemon=True)
    worker.start()
    try:
        yield
    finally:
        stop.set()
        worker.join(timeout=10)


app = FastAPI(title="服务器监控", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310000)
    return salt.hex() + ":" + digest.hex()


def verify_password(password, stored):
    try:
        salt_hex, digest_hex = stored.split(":", 1)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), 310000)
        return hmac.compare_digest(actual, bytes.fromhex(digest_hex))
    except (ValueError, TypeError):
        return False


def create_session(db, user_id):
    token = secrets.token_urlsafe(32)
    db.execute("DELETE FROM sessions WHERE expires_at < ?", (time.time(),))
    db.execute("INSERT INTO sessions VALUES (?,?,?)",
               (hashlib.sha256(token.encode()).hexdigest(), user_id, time.time() + SESSION_SECONDS))
    return token


def authorize(authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "请先登录")
    token = authorization[7:]
    with connect() as db:
        row = db.execute("""SELECT users.id, users.username FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE token_hash=? AND expires_at>?""",
            (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
    if row is None:
        raise HTTPException(401, "登录已失效，请重新登录")
    return dict(row)


class Credentials(BaseModel):
    username: str = Field(min_length=2, max_length=32)
    password: str = Field(min_length=8, max_length=128)


@app.post("/api/auth/register")
def register_user(item: Credentials):
    username = unicodedata.normalize("NFC", item.username.strip())
    if not 2 <= len(username) <= 32 or not re.fullmatch(r"[\u3400-\u9fffA-Za-z0-9_]+", username):
        raise HTTPException(422, "用户名须为 2–32 个汉字、英文字母、数字或下划线")
    with connect() as db:
        try:
            cursor = db.execute("INSERT INTO users(username,password_hash,created_at) VALUES (?,?,?)",
                                (username, hash_password(item.password), time.time()))
        except sqlite3.IntegrityError:
            raise HTTPException(409, "用户名已存在")
        token = create_session(db, cursor.lastrowid)
    return {"token": token, "user": {"id": cursor.lastrowid, "username": username}}


@app.post("/api/auth/login")
def login(item: Credentials):
    username = unicodedata.normalize("NFC", item.username.strip())
    with connect() as db:
        user = db.execute("SELECT id,username,password_hash FROM users WHERE username=?", (username,)).fetchone()
        if user is None or not verify_password(item.password, user["password_hash"]):
            raise HTTPException(401, "用户名或密码错误")
        token = create_session(db, user["id"])
    return {"token": token, "user": {"id": user["id"], "username": user["username"]}}


@app.get("/api/auth/me")
def me(user=Depends(authorize)):
    return user


@app.post("/api/auth/logout")
def logout(user=Depends(authorize), authorization: Optional[str] = Header(default=None)):
    with connect() as db:
        db.execute("DELETE FROM sessions WHERE token_hash=?",
                   (hashlib.sha256(authorization[7:].encode()).hexdigest(),))
    return {"status": "ok"}


class Registration(BaseModel):
    pid: int = Field(gt=0)
    name: str = Field(min_length=1, max_length=100)
    expected_started_at: Optional[float] = None


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/metrics", dependencies=[Depends(authorize)])
def latest_metrics():
    with connect() as db:
        row = db.execute("SELECT data FROM samples ORDER BY id DESC LIMIT 1").fetchone()
    return json.loads(row["data"]) if row else {"status": "采样中"}


@app.get("/api/history", dependencies=[Depends(authorize)])
def history(limit: int = Query(default=288, ge=1, le=2016)):
    with connect() as db:
        rows = db.execute("SELECT data FROM samples ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [json.loads(row["data"]) for row in reversed(rows)]


@app.get("/api/processes", dependencies=[Depends(authorize)])
def processes(q: str = Query(default="", max_length=100)):
    found = []
    for proc in psutil.process_iter(["pid", "name", "username", "create_time", "memory_percent", "memory_info", "cmdline"]):
        try:
            info = proc.info
            command = " ".join(info["cmdline"] or [])[:250]
            if q.lower() not in (info["name"] or "").lower() and q.lower() not in command.lower() and q not in str(info["pid"]):
                continue
            found.append({"pid": info["pid"], "name": info["name"], "user": info["username"],
                          "started_at": info["create_time"], "memory_percent": round(info["memory_percent"] or 0, 2),
                          "memory_rss_mb": round(info["memory_info"].rss / 1024 ** 2, 1) if info["memory_info"] else None,
                          "command": command})
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return sorted(found, key=lambda p: p["pid"], reverse=True)[:200]


@app.get("/api/processes/{pid}", dependencies=[Depends(authorize)])
def process_detail(pid: int):
    if pid <= 0:
        raise HTTPException(422, "请输入有效的 PID")
    try:
        proc = psutil.Process(pid)
        with proc.oneshot():
            if not proc.is_running() or proc.status() == psutil.STATUS_ZOMBIE:
                raise HTTPException(404, "进程不存在或已退出")
            memory = proc.memory_info()
            return {"pid": pid, "name": proc.name(), "user": proc.username(),
                    "started_at": proc.create_time(), "memory_rss_mb": round(memory.rss / 1024 ** 2, 1),
                    "command": " ".join(proc.cmdline())[:250]}
    except psutil.NoSuchProcess:
        raise HTTPException(404, "进程不存在或已退出")
    except psutil.AccessDenied:
        raise HTTPException(403, "当前用户无权查看此进程")


@app.get("/api/services")
def services(user=Depends(authorize)):
    reconcile_services()
    with connect() as db:
        return [dict(row) for row in db.execute("""SELECT services.*, users.username AS registered_by
            FROM services LEFT JOIN users ON users.id=services.user_id
            ORDER BY services.id DESC LIMIT 500""")]


@app.post("/api/services")
def register(item: Registration, user=Depends(authorize)):
    name = item.name.strip()
    if not name:
        raise HTTPException(422, "服务名称不能为空")
    try:
        proc = psutil.Process(item.pid)
        started_at = proc.create_time()
        if item.expected_started_at is not None and abs(started_at - item.expected_started_at) >= 0.001:
            raise HTTPException(409, "PID 对应的进程已变化，请重新核对")
        started_by = proc.username()
        if not process_matches(item.pid, started_at):
            raise HTTPException(404, "进程不存在")
    except psutil.NoSuchProcess:
        raise HTTPException(404, "进程不存在")
    except psutil.AccessDenied:
        raise HTTPException(403, "无权查看此进程")
    reconcile_services()
    with connect() as db:
        duplicate = db.execute("SELECT id FROM services WHERE pid=? AND started_at=? AND status='running' AND user_id IS NOT NULL",
                               (item.pid, started_at)).fetchone()
        if duplicate:
            raise HTTPException(409, "该进程已经登记")
        cursor = db.execute("""INSERT INTO services(pid,name,started_at,registered_at,status,user_id,started_by)
            VALUES (?,?,?,?, 'running',?,?)""", (item.pid, name, started_at, time.time(), user["id"], started_by))
        return {"id": cursor.lastrowid, "pid": item.pid, "name": name, "started_at": started_at,
                "registered_by": user["username"], "started_by": started_by}


@app.post("/api/services/{service_id}/stop")
def stop_service(service_id: int, user=Depends(authorize)):
    with connect() as db:
        row = db.execute("SELECT * FROM services WHERE id=?", (service_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "登记记录不存在")
    if row["user_id"] != user["id"]:
        raise HTTPException(403, "只能停止自己登记的服务")
    if row["status"] != "running":
        raise HTTPException(409, "该服务已经停止")
    if row["pid"] in (1, os.getpid()):
        raise HTTPException(403, "不能通过页面停止系统 1 号进程或监控程序自身")
    if not process_matches(row["pid"], row["started_at"]):
        reconcile_services()
        raise HTTPException(409, "原进程已退出，未向当前 PID 发送信号")
    try:
        proc = psutil.Process(row["pid"])
        # Recheck immediately before signaling to reduce PID reuse risk.
        if abs(proc.create_time() - row["started_at"]) >= 1:
            raise HTTPException(409, "PID 已被复用")
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except psutil.TimeoutExpired:
            raise HTTPException(409, "已发送 SIGTERM，但进程 5 秒后仍在运行")
    except psutil.NoSuchProcess:
        pass
    except psutil.AccessDenied:
        raise HTTPException(403, "当前用户无权停止此进程")
    with connect() as db:
        db.execute("UPDATE services SET stopped_at=?, status='stopped' WHERE id=? AND status='running'",
                   (time.time(), service_id))
    return {"status": "stopped", "pid": row["pid"]}
