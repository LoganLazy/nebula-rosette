"""
Nebula Rosette — SQLite 数据层

只用标准库 sqlite3。没有引入 SQLAlchemy：这里的查询都是单表增删改查，
ORM 带来的抽象成本高于收益，而且少一个依赖就少一份部署麻烦。

线程模型：FastAPI 在线程池里跑同步路由，所以每次请求单独开连接，
不共享 Connection（sqlite3 的连接默认不允许跨线程）。
"""
from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

DB_PATH = Path(os.getenv("DB_PATH", Path(__file__).parent / "nebula.db"))

SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    nickname      TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 会话表：存 token 的哈希而非原文，库被读走也无法冒用登录态
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    device     TEXT,
    last_seen  TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS periods (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    end_date   TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, start_date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 每日记录（流量 / 痛感 / 症状 / 备注），一天一条
CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    date       TEXT NOT NULL,
    flow       TEXT,
    pain       INTEGER,
    symptoms   TEXT,
    text       TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 会话的设备标识，用于「在哪些设备登录过 / 远程登出」。
-- 只记 User-Agent 概括出来的机型和最后活跃时间，不记 IP：
-- IP 是位置信息，对「这是我哪台设备」这个问题没有帮助，存了只是多一份可泄露数据。

CREATE INDEX IF NOT EXISTS idx_periods_user_date  ON periods(user_id, start_date);
CREATE INDEX IF NOT EXISTS idx_notes_user_date    ON notes(user_id, date);
CREATE TABLE IF NOT EXISTS sync_versions (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sync_deletions (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    record_key TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind, record_key)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user      ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires   ON sessions(expires_at);

-- 恢复码：忘记密码时唯一的自救手段。
--
-- 只存 SHA-256，和口令一样不存原文；但这里刻意不用 PBKDF2：
-- 恢复码是系统生成的 80 位随机串（不是人选的弱口令），单轮 SHA-256 已经
-- 远超暴力破解成本，而按 code_hash 直接建索引查找又能做到 O(1) —— 否则
-- 校验时必须逐条试 10 个码，每条一次 26 万轮 PBKDF2 会让一次找回耗时数秒。
--
-- used_at 而不是直接删行：留着才能告诉用户「10 个里已用掉 3 个」，
-- 也让「码被人用过」这件事有痕迹可查。
CREATE TABLE IF NOT EXISTS recovery_codes (
    code_hash  TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recovery_user ON recovery_codes(user_id);

-- 每个账号自己的 AI 配置。api_key_enc 是 Fernet 加密后的密文，
-- 不存明文：库被单独拷走也拿不到可用的 Key。
CREATE TABLE IF NOT EXISTS ai_configs (
    user_id     INTEGER PRIMARY KEY,
    base_url    TEXT,
    model       TEXT,
    api_key_enc TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
"""


def connect() -> sqlite3.Connection:
    """新建一个连接。调用方负责关闭，通常用 ``with get_db() as db``。"""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def get_db() -> Iterator[sqlite3.Connection]:
    """请求级连接：正常结束提交，异常回滚。"""
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# 已发布版本之后追加的列。CREATE TABLE IF NOT EXISTS 不会给已存在的表加列，
# 所以升级时必须显式补——否则老库启动后所有涉及新列的查询都会 OperationalError。
MIGRATIONS = [
    ("notes", "symptoms", "ALTER TABLE notes ADD COLUMN symptoms TEXT"),
    ("sessions", "device", "ALTER TABLE sessions ADD COLUMN device TEXT"),
    ("sessions", "last_seen", "ALTER TABLE sessions ADD COLUMN last_seen TEXT"),
]


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}


def migrate(conn: sqlite3.Connection) -> list[str]:
    """幂等补列。返回实际执行了哪些迁移，方便启动日志和测试断言。"""
    done = []
    for table, column, sql in MIGRATIONS:
        if not _columns(conn, table):
            continue                     # 表还不存在，SCHEMA 会带上新列
        if column in _columns(conn, table):
            continue
        conn.execute(sql)
        done.append(f"{table}.{column}")
    return done


def init_db() -> None:
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        migrate(conn)
        conn.commit()
    finally:
        conn.close()


def purge_expired_sessions(conn: sqlite3.Connection) -> int:
    cur = conn.execute("DELETE FROM sessions WHERE expires_at <= datetime('now')")
    return cur.rowcount or 0


def delete_sessions_for_user(conn: sqlite3.Connection, user_id: int,
                            keep_token_hash: Optional[str] = None) -> int:
    """
    踢掉一个账号的所有会话。改密码后调用，让其他设备重新登录。
    keep_token_hash 用于保留当前这台设备的登录态——否则用户刚改完密码就被自己踢下线。
    """
    if keep_token_hash:
        cur = conn.execute(
            "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?",
            (user_id, keep_token_hash),
        )
    else:
        cur = conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    return cur.rowcount or 0


def list_sessions(conn: sqlite3.Connection, user_id: int,
                  current_token_hash: Optional[str] = None) -> list[dict]:
    """
    「在哪些设备登录过」。返回的 id 是 token_hash 的前 12 位，不是完整哈希——
    远程登出只需要能指认某一行，给出完整哈希等于把可用于伪造的材料交回前端。
    """
    rows = conn.execute(
        "SELECT token_hash, device, created_at, last_seen, expires_at FROM sessions "
        "WHERE user_id = ? AND expires_at > datetime('now') "
        "ORDER BY COALESCE(last_seen, created_at) DESC",
        (user_id,),
    ).fetchall()
    return [
        {
            "id": r["token_hash"][:12],
            "device": r["device"] or "未知设备",
            "createdAt": r["created_at"],
            "lastSeen": r["last_seen"] or r["created_at"],
            "expiresAt": r["expires_at"],
            "current": bool(current_token_hash and r["token_hash"] == current_token_hash),
        }
        for r in rows
    ]


def delete_session_by_prefix(conn: sqlite3.Connection, user_id: int, prefix: str) -> int:
    """按 list_sessions 给出的短 id 登出某台设备。限定 user_id，不能踢别人的会话。"""
    if not prefix or len(prefix) < 8:
        return 0
    cur = conn.execute(
        "DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, ?) = ?",
        (user_id, len(prefix), prefix),
    )
    return cur.rowcount or 0


def touch_session(conn: sqlite3.Connection, token_hash: str, device: Optional[str] = None) -> None:
    """
    刷新最后活跃时间。设备名只在还没记过时写入，避免每个请求都改动它。
    精度到分钟就够，这里不做节流——SQLite 单行 UPDATE 的成本远低于一次网络往返。
    """
    if device:
        conn.execute(
            "UPDATE sessions SET last_seen = datetime('now'), "
            "device = COALESCE(device, ?) WHERE token_hash = ?",
            (device, token_hash),
        )
    else:
        conn.execute(
            "UPDATE sessions SET last_seen = datetime('now') WHERE token_hash = ?",
            (token_hash,),
        )


# ---------- 用户 ----------

def create_user(conn: sqlite3.Connection, username: str, password_hash: str,
                nickname: Optional[str] = None) -> int:
    cur = conn.execute(
        "INSERT INTO users (username, password_hash, nickname) VALUES (?, ?, ?)",
        (username, password_hash, nickname),
    )
    return int(cur.lastrowid)


def find_user_by_username(conn: sqlite3.Connection, username: str) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM users WHERE username = ?", (username,)
    ).fetchone()


def find_user_by_id(conn: sqlite3.Connection, user_id: int) -> Optional[sqlite3.Row]:
    return conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def update_password(conn: sqlite3.Connection, user_id: int, password_hash: str) -> None:
    conn.execute(
        "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?",
        (password_hash, user_id),
    )


# ---------- 恢复码 ----------

def replace_recovery_codes(conn: sqlite3.Connection, user_id: int,
                           code_hashes: list[str]) -> None:
    """
    整组替换。生成新的一批就作废旧的：两批同时有效会让用户以为
    手上那张旧纸还能用，而它可能早就被别人看到过了。
    """
    conn.execute("DELETE FROM recovery_codes WHERE user_id = ?", (user_id,))
    if code_hashes:
        conn.executemany(
            "INSERT OR REPLACE INTO recovery_codes (code_hash, user_id) VALUES (?, ?)",
            [(h, user_id) for h in code_hashes],
        )


def count_recovery_codes(conn: sqlite3.Connection, user_id: int) -> dict:
    row = conn.execute(
        "SELECT COUNT(*) AS total, SUM(used_at IS NULL) AS unused "
        "FROM recovery_codes WHERE user_id = ?",
        (user_id,),
    ).fetchone()
    total = int(row["total"] or 0)
    unused = int(row["unused"] or 0)
    return {"total": total, "unused": unused, "used": total - unused}


def consume_recovery_code(conn: sqlite3.Connection, user_id: int, code_hash: str) -> bool:
    """
    核销一个恢复码。用带条件的 UPDATE 而不是「先查再改」：
    并发下两个请求可能同时查到同一个未使用的码，各自都认为自己有效；
    交给 SQLite 用 rowcount 判断，只有一方能改到那一行。
    """
    cur = conn.execute(
        "UPDATE recovery_codes SET used_at = datetime('now') "
        "WHERE user_id = ? AND code_hash = ? AND used_at IS NULL",
        (user_id, code_hash),
    )
    return (cur.rowcount or 0) > 0



def delete_user(conn: sqlite3.Connection, user_id: int) -> None:
    """
    彻底删掉一个账号。periods / notes / sessions / recovery_codes / ai_configs
    都带 ON DELETE CASCADE，所以只删 users 一行即可——但外键约束必须真的开着，
    否则会留下一堆孤儿行。connect() 里已经 PRAGMA foreign_keys=ON，
    test_main.py 有用例守着这条依赖。
    """
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))


def update_nickname(conn: sqlite3.Connection, user_id: int, nickname: Optional[str]) -> None:    conn.execute(
        "UPDATE users SET nickname = ?, updated_at = datetime('now') WHERE id = ?",
        (nickname, user_id),
    )


# ---------- 逐条合并（避免整表替换互相覆盖） ----------

def _dump_symptoms(value) -> Optional[str]:
    """
    症状是一个短字符串列表。存成 JSON 文本而不是另开一张关联表：
    它永远整组读写，没有单独查询某个症状的需求，多一张表只是多一次 join。
    """
    if not value:
        return None
    if isinstance(value, str):
        return value or None
    return json.dumps(list(value), ensure_ascii=False)


def _load_symptoms(raw) -> list:
    if not raw:
        return []
    try:
        v = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return v if isinstance(v, list) else []

def merge_periods(conn: sqlite3.Connection, user_id: int, periods: list[dict]) -> dict:
    """
    按 start_date 做并集，不删除服务端已有但本次未上报的记录。

    整表替换的问题：两台设备各改了不同的一天，后推送的会抹掉另一台的改动。
    periods 表只有 created_at 没有 updated_at，所以这里不能按时间戳判新旧，
    规则改为：同一 start_date 冲突时，取「信息更多」的一方——
    已标结束的胜过未标结束的，都标了则取更晚的结束日。
    理由是标结束一定是用户的主动操作，而 null 可能只是还没标。
    """
    existing = {
        r["start_date"]: r["end_date"]
        for r in conn.execute(
            "SELECT start_date, end_date FROM periods WHERE user_id = ?", (user_id,)
        )
    }
    added = 0
    updated = 0
    for p in periods:
        start = p["start"]
        end = p.get("end")
        if start not in existing:
            conn.execute(
                "INSERT INTO periods (user_id, start_date, end_date) VALUES (?, ?, ?)",
                (user_id, start, end),
            )
            added += 1
            continue
        cur_end = existing[start]
        if end and (cur_end is None or end > cur_end):
            conn.execute(
                "UPDATE periods SET end_date = ? WHERE user_id = ? AND start_date = ?",
                (end, user_id, start),
            )
            updated += 1
    return {"added": added, "updated": updated, "kept": len(existing)}


def merge_notes(conn: sqlite3.Connection, user_id: int, notes: dict,
                client_times: Optional[dict] = None) -> dict:
    """
    逐条合并每日记录，last-write-wins。

    时间戳一律用客户端给的那个，并原样存进 updated_at。这一点很关键：
    如果服务端写 datetime('now')（UTC）而客户端发本地时间，东八区的客户端
    永远比服务端「新」8 小时，比较就失去意义了。两边都用客户端时钟，
    只要各设备时间大致正确，比较就是有意义的。

    客户端没给时间戳时（老版本前端）保守处理：只补服务端缺的，不覆盖已有的。
    宁可让用户重新改一次，也不要静默丢掉另一台设备的修改。
    """
    client_times = client_times or {}
    existing = {
        r["date"]: r["updated_at"]
        for r in conn.execute(
            "SELECT date, updated_at FROM notes WHERE user_id = ?", (user_id,)
        )
    }
    added = 0
    updated = 0
    skipped = 0
    for date, n in (notes or {}).items():
        if not n:
            continue
        payload = (n.get("flow"), n.get("pain"), _dump_symptoms(n.get("symptoms")),
                   n.get("text"))
        ct = client_times.get(date)
        if date not in existing:
            if ct:
                conn.execute(
                    "INSERT INTO notes (user_id, date, flow, pain, symptoms, text, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (user_id, date, *payload, ct),
                )
            else:
                conn.execute(
                    "INSERT INTO notes (user_id, date, flow, pain, symptoms, text) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (user_id, date, *payload),
                )
            added += 1
            continue
        if ct and ct > (existing[date] or ""):
            conn.execute(
                "UPDATE notes SET flow = ?, pain = ?, symptoms = ?, text = ?, updated_at = ? "
                "WHERE user_id = ? AND date = ?",
                (*payload, ct, user_id, date),
            )
            updated += 1
        else:
            skipped += 1
    return {"added": added, "updated": updated, "skipped": skipped}


def delete_notes(conn: sqlite3.Connection, user_id: int, dates: list[str]) -> int:
    """
    显式删除。合并模式下「本次没上报」不等于「已删除」，
    所以删除必须由客户端明确指出是哪几天，否则多设备下会互相复活对方删掉的记录。
    """
    if not dates:
        return 0
    marks = ",".join("?" * len(dates))
    cur = conn.execute(
        f"DELETE FROM notes WHERE user_id = ? AND date IN ({marks})",
        (user_id, *dates),
    )
    return cur.rowcount or 0


def delete_periods(conn: sqlite3.Connection, user_id: int, starts: list[str]) -> int:
    if not starts:
        return 0
    marks = ",".join("?" * len(starts))
    cur = conn.execute(
        f"DELETE FROM periods WHERE user_id = ? AND start_date IN ({marks})",
        (user_id, *starts),
    )
    return cur.rowcount or 0


def get_notes_with_times(conn: sqlite3.Connection, user_id: int) -> dict:
    """带 updated_at 的版本，供客户端做本地比较。"""
    rows = conn.execute(
        "SELECT date, flow, pain, symptoms, text, updated_at FROM notes WHERE user_id = ?",
        (user_id,),
    ).fetchall()
    return {
        r["date"]: {"flow": r["flow"], "pain": r["pain"],
                    "symptoms": _load_symptoms(r["symptoms"]),
                    "text": r["text"], "updatedAt": r["updated_at"]}
        for r in rows
    }


# ---------- 数据读写 ----------

def get_periods(conn: sqlite3.Connection, user_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT start_date, end_date FROM periods WHERE user_id = ? ORDER BY start_date",
        (user_id,),
    ).fetchall()
    return [{"start": r["start_date"], "end": r["end_date"]} for r in rows]


def replace_periods(conn: sqlite3.Connection, user_id: int, periods: list[dict]) -> None:
    """整表替换。前端持有完整数据集，整体覆盖比逐条 diff 简单且不会残留脏数据。"""
    conn.execute("DELETE FROM periods WHERE user_id = ?", (user_id,))
    if periods:
        conn.executemany(
            "INSERT OR REPLACE INTO periods (user_id, start_date, end_date) VALUES (?, ?, ?)",
            [(user_id, p["start"], p.get("end")) for p in periods],
        )


def get_notes(conn: sqlite3.Connection, user_id: int) -> dict:
    rows = conn.execute(
        "SELECT date, flow, pain, symptoms, text FROM notes WHERE user_id = ?", (user_id,)
    ).fetchall()
    out: dict = {}
    for r in rows:
        out[r["date"]] = {"flow": r["flow"], "pain": r["pain"],
                          "symptoms": _load_symptoms(r["symptoms"]), "text": r["text"]}
    return out


def sync_snapshot(conn, user_id):
    row = conn.execute('SELECT revision FROM sync_versions WHERE user_id=?', (user_id,)).fetchone()
    return {'periods': get_periods(conn, user_id), 'notes': get_notes(conn, user_id),
            'revision': row['revision'] if row else 0}


def record_sync(conn, user_id, old, periods, notes):
    revision = old['revision'] + 1
    conn.execute('INSERT INTO sync_versions VALUES (?,?) ON CONFLICT(user_id) '
                 'DO UPDATE SET revision=excluded.revision', (user_id, revision))
    for kind, removed in [('periods', {p['start'] for p in old['periods']} - {p['start'] for p in periods}),
                          ('notes', set(old['notes']) - set(notes))]:
        for key in removed:
            conn.execute('INSERT INTO sync_deletions VALUES (?,?,?,?) '
                         'ON CONFLICT(user_id,kind,record_key) DO UPDATE SET revision=excluded.revision',
                         (user_id, kind, key, revision))
    return revision


def replace_notes(conn: sqlite3.Connection, user_id: int, notes: dict) -> None:
    conn.execute("DELETE FROM notes WHERE user_id = ?", (user_id,))
    rows = [
        (user_id, date, n.get("flow"), n.get("pain"),
         _dump_symptoms(n.get("symptoms")), n.get("text"))
        for date, n in (notes or {}).items()
        if n
    ]
    if rows:
        conn.executemany(
            "INSERT OR REPLACE INTO notes (user_id, date, flow, pain, symptoms, text) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            rows,
        )


# ---------- 账号自带的 AI 配置 ----------

def get_ai_config(conn: sqlite3.Connection, user_id: int) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT base_url, model, api_key_enc, updated_at FROM ai_configs WHERE user_id = ?",
        (user_id,),
    ).fetchone()


def save_ai_config(conn: sqlite3.Connection, user_id: int, base_url: Optional[str],
                   model: Optional[str], api_key_enc: Optional[str]) -> None:
    """api_key_enc 传 None 表示保留原有 Key（前端不重复上传已保存的 Key）。"""
    existing = get_ai_config(conn, user_id)
    if existing and api_key_enc is None:
        api_key_enc = existing["api_key_enc"]
    conn.execute(
        "INSERT INTO ai_configs (user_id, base_url, model, api_key_enc, updated_at) "
        "VALUES (?, ?, ?, ?, datetime('now')) "
        "ON CONFLICT(user_id) DO UPDATE SET "
        "base_url = excluded.base_url, model = excluded.model, "
        "api_key_enc = excluded.api_key_enc, updated_at = datetime('now')",
        (user_id, base_url, model, api_key_enc),
    )


def delete_ai_config(conn: sqlite3.Connection, user_id: int) -> None:
    conn.execute("DELETE FROM ai_configs WHERE user_id = ?", (user_id,))
