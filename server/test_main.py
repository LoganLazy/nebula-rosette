"""
后端测试：账号、数据同步、AI 代理。
不发真实网络请求，用 monkeypatch 替换 httpx；每个用例用独立的临时数据库。

运行：python3 test_main.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="nebula-test-")
os.environ["DB_PATH"] = str(Path(_TMP) / "test.db")
os.environ["ENC_KEY_FILE"] = str(Path(_TMP) / ".enc_key")   # 不污染源码目录
os.environ.setdefault("LLM_API_KEY", "test-key-not-real")
os.environ["ALLOWED_ORIGINS"] = "http://localhost:8000"
os.environ["RATE_LIMIT_PER_MIN"] = "100"
os.environ["LOGIN_ATTEMPTS_PER_MIN"] = "100"
os.environ["PBKDF2_ITERATIONS"] = "1000"      # 测试里降低迭代，避免拖慢

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import httpx
from fastapi.testclient import TestClient

import auth
import crypto
import db
import main as srv

# fresh() 会把 httpx.AsyncClient 换成替身，这里先留一份真的，
# 否则测试里再想用回真客户端时拿到的还是替身。
_REAL_ASYNC_CLIENT = httpx.AsyncClient

passed = 0
failed = 0


def test(name):
    def deco(fn):
        global passed, failed
        try:
            fn()
            passed += 1
            print(f"  ok   {name}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL {name}")
            print(f"       {e}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  FAIL {name}")
            print(f"       {type(e).__name__}: {e}")
        return fn
    return deco


# ---------- httpx 替身 ----------

class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {
            "choices": [{"message": {"content": "多喝热水，注意保暖。"}}]
        }

    def json(self):
        return self._payload


captured: dict = {}


def make_client(response=None, raise_exc=None):
    class FakeAsyncClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None, json=None):
            captured["url"] = url
            captured["headers"] = headers or {}
            captured["json"] = json or {}
            if raise_exc:
                raise raise_exc
            return response or FakeResponse()

    return FakeAsyncClient


def fresh(response=None, raise_exc=None):
    """全新数据库 + 全新限流状态 + 替换后的 httpx。"""
    p = Path(os.environ["DB_PATH"])
    for suffix in ("", "-wal", "-shm"):
        f = Path(str(p) + suffix)
        if f.exists():
            f.unlink()
    db.init_db()
    srv._hits.clear()
    srv.httpx.AsyncClient = make_client(response, raise_exc)
    captured.clear()
    return TestClient(srv.app)


def signup(c, username="alice", password="password123", nickname=None):
    r = c.post("/api/auth/register",
               json={"username": username, "password": password, "nickname": nickname})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def hdr(token):
    return {"Authorization": f"Bearer {token}"}


BASE_CYCLE = {
    "phase": "luteal", "dayOfCycle": 24, "medianCycleLength": 28,
    "stability": "regular", "cv": 0.05, "daysUntilNext": 4, "recordCount": 6,
}

# ================= 口令与会话 =================

print("\n[口令哈希]")


@test("PBKDF2 哈希可验证，且同一密码两次哈希不同（含随机盐）")
def _():
    h1 = auth.hash_password("hunter22")
    h2 = auth.hash_password("hunter22")
    assert h1 != h2
    assert auth.verify_password("hunter22", h1)
    assert auth.verify_password("hunter22", h2)


@test("错误密码验证失败")
def _():
    h = auth.hash_password("hunter22")
    assert not auth.verify_password("hunter23", h)
    assert not auth.verify_password("", h)


@test("哈希格式非法时返回 False 而不抛异常")
def _():
    for bad in ["", "garbage", "md5$1$aa$bb", "pbkdf2_sha256$notanint$aa$bb", None]:
        assert auth.verify_password("x", bad) is False


@test("迭代次数低于当前配置时判定需要重算")
def _():
    old = auth.hash_password("pw", iterations=100)
    assert auth.needs_rehash(old) is True
    cur = auth.hash_password("pw")
    assert auth.needs_rehash(cur) is False


@test("数据库里存的是哈希，不是明文密码")
def _():
    c = fresh()
    signup(c, "bob", "secretpassword")
    with db.get_db() as conn:
        row = db.find_user_by_username(conn, "bob")
    assert "secretpassword" not in row["password_hash"]
    assert row["password_hash"].startswith("pbkdf2_sha256$")


@test("会话表只存 token 的哈希，不存原文")
def _():
    c = fresh()
    token = signup(c, "carol")
    with db.get_db() as conn:
        rows = conn.execute("SELECT token_hash FROM sessions").fetchall()
    assert len(rows) == 1
    assert rows[0]["token_hash"] != token
    assert len(rows[0]["token_hash"]) == 64


print("\n[用户名与密码校验]")


@test("用户名过短或过长被拒")
def _():
    c = fresh()
    for name in ["ab", "x" * 33]:
        r = c.post("/api/auth/register", json={"username": name, "password": "password123"})
        assert r.status_code == 400, (name, r.status_code)


@test("用户名含非法字符被拒")
def _():
    c = fresh()
    for name in ["a b c", "alice@x", "小明!!"]:
        r = c.post("/api/auth/register", json={"username": name, "password": "password123"})
        assert r.status_code == 400, name


@test("密码短于 8 位被拒")
def _():
    c = fresh()
    r = c.post("/api/auth/register", json={"username": "dave", "password": "short"})
    assert r.status_code == 400
    assert "8" in r.json()["detail"]


@test("用户名重复返回 409")
def _():
    c = fresh()
    signup(c, "eve")
    r = c.post("/api/auth/register", json={"username": "eve", "password": "password123"})
    assert r.status_code == 409


print("\n[登录与会话]")


@test("注册后直接返回可用 token")
def _():
    c = fresh()
    token = signup(c, "frank", nickname="小方")
    r = c.get("/api/auth/me", headers=hdr(token))
    assert r.status_code == 200, r.text
    assert r.json() == {"username": "frank", "nickname": "小方"}


@test("正确密码可登录并拿到新 token")
def _():
    c = fresh()
    signup(c, "grace", "password123")
    r = c.post("/api/auth/login", json={"username": "grace", "password": "password123"})
    assert r.status_code == 200, r.text
    assert c.get("/api/auth/me", headers=hdr(r.json()["token"])).status_code == 200


@test("错误密码返回 401")
def _():
    c = fresh()
    signup(c, "heidi", "password123")
    r = c.post("/api/auth/login", json={"username": "heidi", "password": "wrongpassword"})
    assert r.status_code == 401


@test("不存在的用户名返回 401，措辞不泄露账号是否存在")
def _():
    c = fresh()
    r = c.post("/api/auth/login", json={"username": "nobody", "password": "password123"})
    assert r.status_code == 401
    detail = r.json()["detail"]
    assert "不存在" not in detail
    assert "用户名或密码" in detail


@test("无 token / 伪造 token / 错误格式一律 401")
def _():
    c = fresh()
    signup(c, "ivan")
    assert c.get("/api/auth/me").status_code == 401
    assert c.get("/api/auth/me", headers={"Authorization": "Bearer faketoken"}).status_code == 401
    assert c.get("/api/auth/me", headers={"Authorization": "faketoken"}).status_code == 401
    assert c.get("/api/auth/me", headers={"Authorization": "Basic abc"}).status_code == 401


@test("登出后 token 立即失效")
def _():
    c = fresh()
    token = signup(c, "judy")
    assert c.post("/api/auth/logout", headers=hdr(token)).status_code == 200
    assert c.get("/api/auth/me", headers=hdr(token)).status_code == 401


@test("过期会话无法使用且会被清理")
def _():
    c = fresh()
    token = signup(c, "ken")
    with db.get_db() as conn:
        conn.execute("UPDATE sessions SET expires_at = datetime('now', '-1 day')")
    assert c.get("/api/auth/me", headers=hdr(token)).status_code == 401
    with db.get_db() as conn:
        removed = db.purge_expired_sessions(conn)
    assert removed == 1


@test("登录成功会自动升级迭代次数偏低的旧哈希")
def _():
    c = fresh()
    signup(c, "leo", "password123")
    with db.get_db() as conn:
        db.update_password(conn, 1, auth.hash_password("password123", iterations=100))
    assert c.post("/api/auth/login",
                  json={"username": "leo", "password": "password123"}).status_code == 200
    with db.get_db() as conn:
        row = db.find_user_by_username(conn, "leo")
    assert not auth.needs_rehash(row["password_hash"])


@test("注册可通过环境开关关闭")
def _():
    c = fresh()
    srv.ALLOW_REGISTRATION = False
    try:
        r = c.post("/api/auth/register", json={"username": "mallory", "password": "password123"})
        assert r.status_code == 403
    finally:
        srv.ALLOW_REGISTRATION = True


@test("登录尝试超过上限返回 429")
def _():
    c = fresh()
    signup(c, "nina", "password123")
    srv.LOGIN_ATTEMPTS_PER_MIN = 3
    try:
        srv._hits.clear()
        codes = [c.post("/api/auth/login",
                        json={"username": "nina", "password": "bad-password"}).status_code
                 for _ in range(5)]
        assert 429 in codes, codes
    finally:
        srv.LOGIN_ATTEMPTS_PER_MIN = 100


# ================= 数据同步 =================

print("\n[数据同步]")


@test("新账号的数据为空")
def _():
    c = fresh()
    token = signup(c, "olive")
    r = c.get("/api/data", headers=hdr(token))
    assert r.status_code == 200
    assert r.json()["periods"] == []
    assert r.json()["notes"] == {}


@test("上传后能原样取回")
def _():
    c = fresh()
    token = signup(c, "peggy")
    payload = {
        "periods": [{"start": "2026-07-01", "end": "2026-07-05"},
                    {"start": "2026-07-29", "end": None}],
        "notes": {"2026-07-02": {"flow": "medium", "pain": 3, "text": "有点累"}},
    }
    assert c.put("/api/data", json=payload, headers=hdr(token)).status_code == 200
    got = c.get("/api/data", headers=hdr(token)).json()
    assert got["periods"] == [{"start": "2026-07-01", "end": "2026-07-05"},
                              {"start": "2026-07-29", "end": None}]
    assert got["notes"]["2026-07-02"]["text"] == "有点累"
    assert got["notes"]["2026-07-02"]["pain"] == 3


@test("常规同步是合并：第二次上传不会抹掉第一次的记录")
def _():
    c = fresh()
    token = signup(c, "quinn")
    c.put("/api/data", json={"periods": [{"start": "2026-01-01"}, {"start": "2026-01-29"}],
                             "notes": {}}, headers=hdr(token))
    c.put("/api/data", json={"periods": [{"start": "2026-02-26"}], "notes": {}},
          headers=hdr(token))
    got = c.get("/api/data", headers=hdr(token)).json()
    starts = [p["start"] for p in got["periods"]]
    assert starts == ["2026-01-01", "2026-01-29", "2026-02-26"], starts


@test("/api/data/replace 才是整表替换")
def _():
    c = fresh()
    token = signup(c, "quinn2")
    c.put("/api/data", json={"periods": [{"start": "2026-01-01"}, {"start": "2026-01-29"}],
                             "notes": {}}, headers=hdr(token))
    c.put("/api/data/replace", json={"periods": [{"start": "2026-02-26"}], "notes": {}},
          headers=hdr(token))
    got = c.get("/api/data", headers=hdr(token)).json()
    assert [p["start"] for p in got["periods"]] == ["2026-02-26"]


@test("periods 按 start_date 升序返回，无论上传顺序")
def _():
    c = fresh()
    token = signup(c, "ruth")
    c.put("/api/data", json={"periods": [{"start": "2026-03-01"}, {"start": "2026-01-01"},
                                         {"start": "2026-02-01"}], "notes": {}},
          headers=hdr(token))
    starts = [p["start"] for p in c.get("/api/data", headers=hdr(token)).json()["periods"]]
    assert starts == ["2026-01-01", "2026-02-01", "2026-03-01"], starts


@test("两个账号的数据互相隔离")
def _():
    c = fresh()
    t1 = signup(c, "user1")
    t2 = signup(c, "user2")
    c.put("/api/data", json={"periods": [{"start": "2026-05-01"}], "notes": {}}, headers=hdr(t1))
    c.put("/api/data", json={"periods": [{"start": "2026-06-01"}], "notes": {}}, headers=hdr(t2))
    assert c.get("/api/data", headers=hdr(t1)).json()["periods"][0]["start"] == "2026-05-01"
    assert c.get("/api/data", headers=hdr(t2)).json()["periods"][0]["start"] == "2026-06-01"


@test("未登录不能读写数据")
def _():
    c = fresh()
    assert c.get("/api/data").status_code == 401
    assert c.put("/api/data", json={"periods": [], "notes": {}}).status_code == 401


@test("非法日期格式被拒")
def _():
    c = fresh()
    token = signup(c, "sam")
    for bad in ["2026/07/01", "26-07-01", "2026-7-1", "not-a-date", ""]:
        r = c.put("/api/data", json={"periods": [{"start": bad}], "notes": {}}, headers=hdr(token))
        assert r.status_code == 422, (bad, r.status_code)


@test("非法 notes 键（非日期）被拒")
def _():
    c = fresh()
    token = signup(c, "tina")
    r = c.put("/api/data", json={"periods": [], "notes": {"whenever": {"text": "x"}}},
              headers=hdr(token))
    assert r.status_code == 422


@test("非法 flow 与超范围 pain 被拒")
def _():
    c = fresh()
    token = signup(c, "uma")
    bad_flow = {"periods": [], "notes": {"2026-07-01": {"flow": "flood"}}}
    bad_pain = {"periods": [], "notes": {"2026-07-01": {"pain": 99}}}
    assert c.put("/api/data", json=bad_flow, headers=hdr(token)).status_code == 422
    assert c.put("/api/data", json=bad_pain, headers=hdr(token)).status_code == 422


@test("删除账号会级联删掉其数据（外键 ON DELETE CASCADE 生效）")
def _():
    c = fresh()
    token = signup(c, "vera")
    c.put("/api/data", json={"periods": [{"start": "2026-04-01"}],
                             "notes": {"2026-04-01": {"text": "x"}}}, headers=hdr(token))
    with db.get_db() as conn:
        conn.execute("DELETE FROM users WHERE username = 'vera'")
    with db.get_db() as conn:
        assert conn.execute("SELECT COUNT(*) AS n FROM periods").fetchone()["n"] == 0
        assert conn.execute("SELECT COUNT(*) AS n FROM notes").fetchone()["n"] == 0
        assert conn.execute("SELECT COUNT(*) AS n FROM sessions").fetchone()["n"] == 0


@test("同一天重复上传备注不会产生重复行")
def _():
    c = fresh()
    token = signup(c, "wendy")
    for i, text in enumerate(["第一次", "第二次"]):
        c.put("/api/data", json={
            "periods": [], "notes": {"2026-08-01": {"text": text}},
            "noteTimes": {"2026-08-01": f"2026-08-0{i + 1} 10:00:00"},
        }, headers=hdr(token))
    with db.get_db() as conn:
        n = conn.execute("SELECT COUNT(*) AS n FROM notes").fetchone()["n"]
    assert n == 1
    assert c.get("/api/data", headers=hdr(token)).json()["notes"]["2026-08-01"]["text"] == "第二次"


@test("updated_at 存客户端时钟，避免时区差导致的永远更新/永不更新")
def _():
    c = fresh()
    token = signup(c, "wendy2")
    c.put("/api/data", json={
        "periods": [], "notes": {"2026-08-01": {"text": "x"}},
        "noteTimes": {"2026-08-01": "2026-08-01 10:00:00"}}, headers=hdr(token))
    got = c.get("/api/data", headers=hdr(token)).json()
    assert got["noteTimes"]["2026-08-01"] == "2026-08-01 10:00:00", got["noteTimes"]


print("\n[逐条合并同步]")


@test("两台设备各改不同的一天，互不覆盖")
def _():
    c = fresh()
    token = signup(c, "merge1")
    # 手机改 3 号
    c.put("/api/data", json={
        "periods": [], "notes": {"2026-08-03": {"text": "手机记的"}},
        "noteTimes": {"2026-08-03": "2026-08-03 09:00:00"}}, headers=hdr(token))
    # 电脑只知道自己改的 5 号，payload 里没有 3 号
    c.put("/api/data", json={
        "periods": [], "notes": {"2026-08-05": {"text": "电脑记的"}},
        "noteTimes": {"2026-08-05": "2026-08-05 09:00:00"}}, headers=hdr(token))
    notes = c.get("/api/data", headers=hdr(token)).json()["notes"]
    assert notes["2026-08-03"]["text"] == "手机记的", "另一台设备的记录被抹掉了"
    assert notes["2026-08-05"]["text"] == "电脑记的"


@test("客户端时间戳更新时覆盖服务端")
def _():
    c = fresh()
    token = signup(c, "merge2")
    c.put("/api/data", json={
        "periods": [], "notes": {"2026-08-01": {"text": "旧"}},
        "noteTimes": {"2026-08-01": "2026-08-01 08:00:00"}}, headers=hdr(token))
    c.put("/api/data", json={
        "periods": [], "notes": {"2026-08-01": {"text": "新"}},
        "noteTimes": {"2026-08-01": "2030-01-01 00:00:00"}}, headers=hdr(token))
    assert c.get("/api/data", headers=hdr(token)).json()["notes"]["2026-08-01"]["text"] == "新"


@test("客户端时间戳更旧时不覆盖，并计入 skipped")
def _():
    c = fresh()
    token = signup(c, "merge3")
    c.put("/api/data", json={
        "periods": [], "notes": {"2026-08-01": {"text": "服务端的"}},
        "noteTimes": {"2026-08-01": "2030-01-01 00:00:00"}}, headers=hdr(token))
    r = c.put("/api/data", json={
        "periods": [], "notes": {"2026-08-01": {"text": "旧设备的"}},
        "noteTimes": {"2026-08-01": "2020-01-01 00:00:00"}}, headers=hdr(token))
    assert r.json()["merged"]["notesSkipped"] == 1
    assert c.get("/api/data", headers=hdr(token)).json()["notes"]["2026-08-01"]["text"] == "服务端的"


@test("跨时区：UTC 时间戳比较，真实更晚的修改获胜")
def _():
    # 回归：旧版前端发本地时间戳时，UTC+8 设备本地 20:00（UTC 12:00）的修改
    # 会"赢过" UTC-5 设备本地 08:00（UTC 13:00）的修改，尽管后者实际晚 1 小时。
    # 前端现已发 UTC 时间戳，同一时刻的两地时间戳可直接按字符串比较。
    c = fresh()
    token = signup(c, "merge-tz")
    c.put("/api/data", json={
        "periods": [], "notes": {"2026-08-01": {"text": "东八区先改的"}},
        "noteTimes": {"2026-08-01": "2026-11-07 12:00:00"}}, headers=hdr(token))
    r = c.put("/api/data", json={
        "periods": [], "notes": {"2026-08-01": {"text": "西五区后改的"}},
        "noteTimes": {"2026-08-01": "2026-11-07 13:00:00"}}, headers=hdr(token))
    assert r.json()["merged"]["notesUpdated"] == 1, r.json()
    assert c.get("/api/data", headers=hdr(token)).json()["notes"]["2026-08-01"]["text"] == "西五区后改的"


@test("没带时间戳时保守处理：只补缺的，不覆盖已有的")
def _():
    c = fresh()
    token = signup(c, "merge4")
    c.put("/api/data", json={
        "periods": [], "notes": {"2026-08-01": {"text": "原有"}},
        "noteTimes": {"2026-08-01": "2026-08-01 08:00:00"}}, headers=hdr(token))
    # 老版本前端不发 noteTimes
    r = c.put("/api/data", json={
        "periods": [], "notes": {"2026-08-01": {"text": "覆盖尝试"},
                                 "2026-08-09": {"text": "新的一天"}}}, headers=hdr(token))
    notes = c.get("/api/data", headers=hdr(token)).json()["notes"]
    assert notes["2026-08-01"]["text"] == "原有", "无时间戳不该覆盖"
    assert notes["2026-08-09"]["text"] == "新的一天", "缺的应该补上"
    assert r.json()["merged"]["notesAdded"] == 1
    assert r.json()["merged"]["notesSkipped"] == 1


@test("经期冲突时已标结束的胜过未标结束的")
def _():
    c = fresh()
    token = signup(c, "merge5")
    c.put("/api/data", json={"periods": [{"start": "2026-08-01", "end": "2026-08-05"}],
                             "notes": {}}, headers=hdr(token))
    # 另一台设备还不知道结束日
    c.put("/api/data", json={"periods": [{"start": "2026-08-01", "end": None}],
                             "notes": {}}, headers=hdr(token))
    ps = c.get("/api/data", headers=hdr(token)).json()["periods"]
    assert ps[0]["end"] == "2026-08-05", "结束日被 null 抹掉了"


@test("经期冲突时取更晚的结束日")
def _():
    c = fresh()
    token = signup(c, "merge6")
    c.put("/api/data", json={"periods": [{"start": "2026-08-01", "end": "2026-08-04"}],
                             "notes": {}}, headers=hdr(token))
    c.put("/api/data", json={"periods": [{"start": "2026-08-01", "end": "2026-08-06"}],
                             "notes": {}}, headers=hdr(token))
    ps = c.get("/api/data", headers=hdr(token)).json()["periods"]
    assert ps[0]["end"] == "2026-08-06"


@test("显式删除才真的删，且不被同批 payload 复活")
def _():
    c = fresh()
    token = signup(c, "merge7")
    c.put("/api/data", json={
        "periods": [{"start": "2026-08-01"}, {"start": "2026-08-29"}],
        "notes": {"2026-08-02": {"text": "删我"}, "2026-08-03": {"text": "留我"}},
        "noteTimes": {"2026-08-02": "2026-08-02 09:00:00",
                      "2026-08-03": "2026-08-03 09:00:00"}}, headers=hdr(token))
    r = c.put("/api/data", json={
        "periods": [], "notes": {},
        "deletedNotes": ["2026-08-02"], "deletedPeriods": ["2026-08-01"]}, headers=hdr(token))
    assert r.json()["merged"]["notesDeleted"] == 1
    assert r.json()["merged"]["periodsDeleted"] == 1
    got = c.get("/api/data", headers=hdr(token)).json()
    assert "2026-08-02" not in got["notes"]
    assert "2026-08-03" in got["notes"]
    assert [p["start"] for p in got["periods"]] == ["2026-08-29"]


@test("删除与上报同一天时，删除先执行不会残留")
def _():
    c = fresh()
    token = signup(c, "merge8")
    c.put("/api/data", json={
        "periods": [], "notes": {"2026-08-02": {"text": "x"}},
        "noteTimes": {"2026-08-02": "2026-08-02 09:00:00"}}, headers=hdr(token))
    # 同一批里既删又报同一天：删除先执行，随后被当成新增加回来
    c.put("/api/data", json={
        "periods": [], "notes": {"2026-08-02": {"text": "重新写的"}},
        "noteTimes": {"2026-08-02": "2026-08-02 10:00:00"},
        "deletedNotes": ["2026-08-02"]}, headers=hdr(token))
    assert c.get("/api/data", headers=hdr(token)).json()["notes"]["2026-08-02"]["text"] == "重新写的"


@test("GET /api/data 附带 noteTimes 供客户端比较")
def _():
    c = fresh()
    token = signup(c, "merge9")
    c.put("/api/data", json={"periods": [], "notes": {"2026-08-01": {"text": "x"}},
                             "noteTimes": {"2026-08-01": "2026-08-01 09:00:00"}},
          headers=hdr(token))
    got = c.get("/api/data", headers=hdr(token)).json()
    assert "2026-08-01" in got["noteTimes"]
    assert len(got["noteTimes"]["2026-08-01"]) >= 10


@test("删除列表里的非法日期被拒")
def _():
    c = fresh()
    token = signup(c, "merge10")
    r = c.put("/api/data", json={"periods": [], "notes": {},
                                 "deletedNotes": ["2026/08/01"]}, headers=hdr(token))
    assert r.status_code == 422


print("\n[改密码与资料]")


@test("未登录不能改密码")
def _():
    c = fresh()
    r = c.post("/api/auth/change-password",
               json={"old_password": "password123", "new_password": "newpassword456"})
    assert r.status_code == 401


@test("旧密码不对时拒绝，且密码没被改动")
def _():
    c = fresh()
    t = signup(c, "chp1")
    r = c.post("/api/auth/change-password", headers=hdr(t),
               json={"old_password": "wrongpassword", "new_password": "newpassword456"})
    assert r.status_code == 401
    assert "当前密码" in r.text
    # 原密码仍然可用
    assert c.post("/api/auth/login",
                  json={"username": "chp1", "password": "password123"}).status_code == 200


@test("改密码成功后新密码可登录、旧密码失效")
def _():
    c = fresh()
    t = signup(c, "chp2")
    r = c.post("/api/auth/change-password", headers=hdr(t),
               json={"old_password": "password123", "new_password": "newpassword456"})
    assert r.status_code == 200, r.text
    assert c.post("/api/auth/login",
                  json={"username": "chp2", "password": "password123"}).status_code == 401
    assert c.post("/api/auth/login",
                  json={"username": "chp2", "password": "newpassword456"}).status_code == 200


@test("改密码默认踢掉其他设备，但保留当前设备")
def _():
    c = fresh()
    t1 = signup(c, "chp3")
    # 第二台设备登录
    t2 = c.post("/api/auth/login",
                json={"username": "chp3", "password": "password123"}).json()["token"]
    assert c.get("/api/auth/me", headers=hdr(t2)).status_code == 200

    r = c.post("/api/auth/change-password", headers=hdr(t1),
               json={"old_password": "password123", "new_password": "newpassword456"})
    assert r.json()["logged_out_devices"] == 1
    assert c.get("/api/auth/me", headers=hdr(t1)).status_code == 200, "当前设备不该被踢"
    assert c.get("/api/auth/me", headers=hdr(t2)).status_code == 401, "其他设备该被踢"


@test("logout_others=false 时其他设备保持登录")
def _():
    c = fresh()
    t1 = signup(c, "chp4")
    t2 = c.post("/api/auth/login",
                json={"username": "chp4", "password": "password123"}).json()["token"]
    c.post("/api/auth/change-password", headers=hdr(t1),
           json={"old_password": "password123", "new_password": "newpassword456",
                 "logout_others": False})
    assert c.get("/api/auth/me", headers=hdr(t2)).status_code == 200


@test("新密码不能和当前密码相同")
def _():
    c = fresh()
    t = signup(c, "chp5")
    r = c.post("/api/auth/change-password", headers=hdr(t),
               json={"old_password": "password123", "new_password": "password123"})
    assert r.status_code == 400
    assert "相同" in r.text


@test("新密码走注册时同一套强度规则")
def _():
    c = fresh()
    t = signup(c, "chp6")
    r = c.post("/api/auth/change-password", headers=hdr(t),
               json={"old_password": "password123", "new_password": "abc"})
    assert r.status_code == 400, r.status_code


@test("改密码不影响数据")
def _():
    c = fresh()
    t = signup(c, "chp7")
    c.put("/api/data", json={"periods": [{"start": "2026-08-01"}], "notes": {}}, headers=hdr(t))
    c.post("/api/auth/change-password", headers=hdr(t),
           json={"old_password": "password123", "new_password": "newpassword456"})
    assert len(c.get("/api/data", headers=hdr(t)).json()["periods"]) == 1


@test("改密码后 AI 配置仍在（不因清会话而丢）")
def _():
    c = fresh()
    t = signup(c, "chp8")
    c.put("/api/ai-config", headers=hdr(t), json={"model": "m", "api_key": "sk-keep-after-pwd"})
    c.post("/api/auth/change-password", headers=hdr(t),
           json={"old_password": "password123", "new_password": "newpassword456"})
    assert c.get("/api/ai-config", headers=hdr(t)).json()["has_key"] is True


@test("改昵称立即生效，且不需要密码")
def _():
    c = fresh()
    t = signup(c, "prof1")
    r = c.put("/api/auth/profile", headers=hdr(t), json={"nickname": "小月"})
    assert r.status_code == 200
    assert r.json()["nickname"] == "小月"
    assert c.get("/api/auth/me", headers=hdr(t)).json()["nickname"] == "小月"


@test("昵称可以清空")
def _():
    c = fresh()
    t = signup(c, "prof2", nickname="旧名")
    c.put("/api/auth/profile", headers=hdr(t), json={"nickname": "   "})
    assert c.get("/api/auth/me", headers=hdr(t)).json()["nickname"] is None


@test("未登录不能改资料")
def _():
    c = fresh()
    assert c.put("/api/auth/profile", json={"nickname": "x"}).status_code == 401


# ================= AI =================

print("\n[AI 代理]")


@test("未登录不能调用 AI")
def _():
    c = fresh()
    r = c.post("/api/chat", json={"question": "痛经怎么办", "cycle": BASE_CYCLE})
    assert r.status_code == 401


@test("登录后正常提问返回答案")
def _():
    c = fresh()
    token = signup(c, "xena")
    r = c.post("/api/chat", json={"question": "经前情绪低落怎么办", "cycle": BASE_CYCLE},
               headers=hdr(token))
    assert r.status_code == 200, r.text
    assert "多喝热水" in r.json()["answer"]
    assert "仅供参考" in r.json()["answer"]


@test("API Key 以 Bearer 发往上游，且不出现在响应里")
def _():
    c = fresh()
    token = signup(c, "yara")
    r = c.post("/api/chat", json={"question": "测试", "cycle": BASE_CYCLE}, headers=hdr(token))
    assert captured["headers"]["Authorization"].startswith("Bearer ")
    assert "test-key-not-real" not in r.text


@test("周期摘要被翻译成中文写进 system prompt")
def _():
    c = fresh()
    token = signup(c, "zoe")
    c.post("/api/chat", json={"question": "测试", "cycle": BASE_CYCLE}, headers=hdr(token))
    sys_msg = captured["json"]["messages"][0]["content"]
    for kw in ["黄体期", "周期第 24 天", "比较规律", "距预测下次还有 4 天"]:
        assert kw in sys_msg, kw


@test("system prompt 含所有禁止项（含避孕受孕）")
def _():
    c = fresh()
    token = signup(c, "amy")
    c.post("/api/chat", json={"question": "测试", "cycle": BASE_CYCLE}, headers=hdr(token))
    sys_msg = captured["json"]["messages"][0]["content"]
    for kw in ["诊断疾病", "推荐具体药物", "避孕或受孕", "安全期"]:
        assert kw in sys_msg, f"缺少约束: {kw}"


@test("无记录时 prompt 引导用户先记录")
def _():
    c = fresh()
    token = signup(c, "bella")
    c.post("/api/chat", json={"question": "你能干什么", "cycle": {"recordCount": 0}},
           headers=hdr(token))
    assert "还没有任何记录" in captured["json"]["messages"][0]["content"]


@test("推迟场景 prompt 措辞正确")
def _():
    c = fresh()
    token = signup(c, "cora")
    c.post("/api/chat", json={"question": "为什么还没来",
                              "cycle": dict(BASE_CYCLE, daysUntilNext=-3)}, headers=hdr(token))
    assert "已比预测推迟 3 天" in captured["json"]["messages"][0]["content"]


@test("多余字段与真实日期不会被转发给模型")
def _():
    c = fresh()
    token = signup(c, "dana")
    c.post("/api/chat", json={
        "question": "hi",
        "cycle": dict(BASE_CYCLE, notes="私密备注", periods=["2026-08-01"]),
    }, headers=hdr(token))
    body = json.dumps(captured["json"], ensure_ascii=False)
    assert "私密备注" not in body
    assert "2026-08-01" not in body


@test("空问题与超长问题被拒")
def _():
    c = fresh()
    token = signup(c, "elsa")
    assert c.post("/api/chat", json={"question": "   ", "cycle": BASE_CYCLE},
                  headers=hdr(token)).status_code == 422
    assert c.post("/api/chat", json={"question": "痛" * 400, "cycle": BASE_CYCLE},
                  headers=hdr(token)).status_code == 422


@test("非法 phase 与超范围 dayOfCycle 被拒")
def _():
    c = fresh()
    token = signup(c, "fiona")
    assert c.post("/api/chat", json={"question": "hi", "cycle": dict(BASE_CYCLE, phase="pregnant")},
                  headers=hdr(token)).status_code == 422
    assert c.post("/api/chat", json={"question": "hi", "cycle": dict(BASE_CYCLE, dayOfCycle=999)},
                  headers=hdr(token)).status_code == 422


print("\n[AI 安全过滤]")


@test("上游提到具体药名时被拦截替换")
def _():
    c = fresh(FakeResponse(payload={"choices": [{"message": {"content": "建议吃布洛芬缓解疼痛。"}}]}))
    token = signup(c, "gina")
    r = c.post("/api/chat", json={"question": "痛经吃什么药", "cycle": BASE_CYCLE},
               headers=hdr(token))
    ans = r.json()["answer"]
    assert "布洛芬" not in ans
    assert "咨询医生" in ans


@test("上游给出避孕/安全期建议时被拦截")
def _():
    c = fresh(FakeResponse(payload={"choices": [{"message": {"content": "你的安全期大概是这几天。"}}]}))
    token = signup(c, "hana")
    r = c.post("/api/chat", json={"question": "安全期是哪几天", "cycle": BASE_CYCLE},
               headers=hdr(token))
    assert "安全期大概" not in r.json()["answer"]
    assert "不方便给具体建议" in r.json()["answer"]


@test("上游给出确诊式判断时被拦截")
def _():
    c = fresh(FakeResponse(payload={"choices": [{"message": {"content": "看起来你得了多囊卵巢综合征。"}}]}))
    token = signup(c, "iris")
    r = c.post("/api/chat", json={"question": "我周期很乱", "cycle": BASE_CYCLE},
               headers=hdr(token))
    assert "多囊" not in r.json()["answer"]


@test("关键词加空格或标点也拦得住（归一化后匹配）")
def _():
    c = fresh(FakeResponse(payload={"choices": [{"message": {"content": "可以吃布 洛 芬缓解。"}}]}))
    token = signup(c, "ivan")
    r = c.post("/api/chat", json={"question": "痛经吃什么", "cycle": BASE_CYCLE},
               headers=hdr(token))
    assert "布 洛 芬" not in r.json()["answer"]
    assert "不方便给具体建议" in r.json()["answer"]


@test("safety_filter：空格/标点变形被拦截，正常回答只补免责声明")
def _():
    assert "不方便给具体建议" in srv.safety_filter("建议服用布洛芬。")
    assert "不方便给具体建议" in srv.safety_filter("试试布 洛 芬吧")
    assert "不方便给具体建议" in srv.safety_filter("安 全 期 是哪几天？")
    assert "不方便给具体建议" in srv.safety_filter("芬必得、也可以")
    ok = srv.safety_filter("多喝热水，注意保暖。")
    assert "多喝热水" in ok
    assert "不方便给具体建议" not in ok
    assert ok.endswith(srv.DISCLAIMER)
    assert "暂时没法回答" in srv.safety_filter("   ")


@test("上游返回空内容时明确报告失败")
def _():
    c = fresh(FakeResponse(payload={"choices": [{"message": {"content": ""}}]}))
    token = signup(c, "jade")
    r = c.post("/api/chat", json={"question": "hi", "cycle": BASE_CYCLE}, headers=hdr(token))
    assert r.status_code == 502
    assert "有效文本" in r.json()["detail"]


print("\n[限流与故障]")


@test("AI 按账号限流：超过每分钟上限返回 429")
def _():
    c = fresh()
    token = signup(c, "kira")
    srv.RATE_LIMIT_PER_MIN = 3
    try:
        srv._hits.clear()
        codes = [c.post("/api/chat", json={"question": f"问题{i}", "cycle": BASE_CYCLE},
                        headers=hdr(token)).status_code for i in range(5)]
        assert codes[:3] == [200, 200, 200], codes
        assert 429 in codes[3:], codes
    finally:
        srv.RATE_LIMIT_PER_MIN = 100


@test("一个账号被限流不影响另一个账号")
def _():
    c = fresh()
    t1 = signup(c, "limit1")
    t2 = signup(c, "limit2")
    srv.RATE_LIMIT_PER_MIN = 2
    try:
        srv._hits.clear()
        for _ in range(3):
            c.post("/api/chat", json={"question": "q", "cycle": BASE_CYCLE}, headers=hdr(t1))
        r = c.post("/api/chat", json={"question": "q", "cycle": BASE_CYCLE}, headers=hdr(t2))
        assert r.status_code == 200, r.status_code
    finally:
        srv.RATE_LIMIT_PER_MIN = 100


@test("上游超时返回 504")
def _():
    c = fresh(raise_exc=httpx.TimeoutException("timeout"))
    token = signup(c, "lena")
    assert c.post("/api/chat", json={"question": "hi", "cycle": BASE_CYCLE},
                  headers=hdr(token)).status_code == 504


@test("上游网络错误返回 502")
def _():
    c = fresh(raise_exc=httpx.ConnectError("boom"))
    token = signup(c, "mona")
    assert c.post("/api/chat", json={"question": "hi", "cycle": BASE_CYCLE},
                  headers=hdr(token)).status_code == 502


@test("构造 httpx 客户端抛 InvalidURL 时返回 502 而不是裸 500")
def _():
    # 回归：InvalidURL 既不是 HTTPError 也不是 ValueError，旧代码接不住，
    # 环境里有 httpx 解析不了的代理配置（例如 NO_PROXY 含 [::1]）时
    # AsyncClient 构造直接抛错，整个 /api/chat 变成 500。
    class RaisingClient:
        def __init__(self, *a, **k):
            raise httpx.InvalidURL("Invalid port: ':1]'")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    c = fresh()
    token = signup(c, "nancy")
    orig = srv.httpx.AsyncClient
    srv.httpx.AsyncClient = RaisingClient
    try:
        r = c.post("/api/chat", json={"question": "hi", "cycle": BASE_CYCLE},
                   headers=hdr(token))
    finally:
        srv.httpx.AsyncClient = orig
    assert r.status_code == 502, r.text
    assert "无法连接模型服务" in r.text


@test("毒化的代理环境变量 + 填错的 Base URL 也只返回 502")
def _():
    # 真实 AsyncClient + trust_env=False：构造时不再读环境代理变量，
    # 填错的 Base URL 在发请求前解析失败，同样走 502，不发真实网络请求。
    c = fresh()
    token = signup(c, "oscar")
    c.put("/api/ai-config", headers=hdr(token), json={
        "base_url": "https://example.com:bad", "model": "m", "api_key": "sk-x"})
    orig_client = srv.httpx.AsyncClient
    orig_no_proxy = os.environ.get("NO_PROXY")
    srv.httpx.AsyncClient = _REAL_ASYNC_CLIENT
    os.environ["NO_PROXY"] = "[::1]"
    try:
        r = c.post("/api/chat", json={"question": "hi", "cycle": BASE_CYCLE},
                   headers=hdr(token))
    finally:
        srv.httpx.AsyncClient = orig_client
        if orig_no_proxy is None:
            os.environ.pop("NO_PROXY", None)
        else:
            os.environ["NO_PROXY"] = orig_no_proxy
    assert r.status_code == 502, r.text


@test("上游 401 不泄露原始错误内容")
def _():
    c = fresh(FakeResponse(status_code=401,
                           payload={"error": {"message": "Invalid API key sk-abc123"}}))
    token = signup(c, "nora")
    r = c.post("/api/chat", json={"question": "hi", "cycle": BASE_CYCLE}, headers=hdr(token))
    assert r.status_code == 502
    assert "sk-abc" not in r.text
    assert "Invalid API key" not in r.text


@test("上游返回格式异常时返回 502")
def _():
    c = fresh(FakeResponse(payload={"unexpected": True}))
    token = signup(c, "opal")
    assert c.post("/api/chat", json={"question": "hi", "cycle": BASE_CYCLE},
                  headers=hdr(token)).status_code == 502


@test("未配置 key 时返回 503 而非崩溃")
def _():
    c = fresh()
    token = signup(c, "pearl")
    original = srv.LLM_API_KEY
    srv.LLM_API_KEY = ""
    try:
        assert c.post("/api/chat", json={"question": "hi", "cycle": BASE_CYCLE},
                      headers=hdr(token)).status_code == 503
    finally:
        srv.LLM_API_KEY = original


@test("AI 不分享摘要时不推断个人记录")
def _():
    c = fresh()
    token = signup(c, "privateai")
    for body in ({"question": "经期能运动吗"}, {"question": "经期能运动吗", "cycle": None}):
        r = c.post("/api/chat", json=body, headers=hdr(token))
        assert r.status_code == 200
        assert "未提供周期摘要" in captured["json"]["messages"][0]["content"]


@test("AI 畸形或空白文本返回可控错误而非崩溃")
def _():
    for payload in ([], {"choices": None}, {"choices": [None]},
                    {"choices": [{"message": {"content": []}}]},
                    {"choices": [{"message": {"content": "   "}}]},
                    {"choices": [{"message": {"content": "x" * 12001}}]}):
        c = fresh(FakeResponse(payload=payload))
        token = signup(c, "badformat")
        r = c.post("/api/chat", json={"question": "测试"}, headers=hdr(token))
        assert r.status_code == 502, r.text


print("\n[接口暴露与 CORS]")


@test("健康检查可用且不泄露 key 与用户数")
def _():
    c = fresh()
    r = c.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ai_configured"] is True
    assert "test-key" not in json.dumps(body)
    assert "users" not in body


@test("注册用户后健康检查也不泄露用户数")
def _():
    c = fresh()
    signup(c, "quinnh")
    signup(c, "quinn2")
    assert "users" not in c.get("/api/health").json()


@test("允许的来源可跨域，未列入白名单的不放行")
def _():
    c = fresh()
    ok = c.get("/api/health", headers={"Origin": "http://localhost:8000"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:8000"
    bad = c.get("/api/health", headers={"Origin": "https://evil.example.com"})
    assert bad.headers.get("access-control-allow-origin") != "https://evil.example.com"


@test("自动生成的 API 文档已关闭")
def _():
    c = fresh()
    assert c.get("/docs").status_code == 404
    assert c.get("/redoc").status_code == 404


@test("GET /api/chat 不可用（只接受 POST）")
def _():
    c = fresh()
    assert c.get("/api/chat").status_code == 405


@test("前端页面挂在同源根路径下")
def _():
    c = fresh()
    r = c.get("/")
    assert r.status_code == 200
    assert "Nebula Rosette" in r.text
    assert c.get("/js/period.js").status_code == 200


@test("源码中没有硬编码密钥")
def _():
    import re
    here = Path(os.path.dirname(os.path.abspath(__file__)))
    for name in ["main.py", "auth.py", "db.py", "crypto.py"]:
        src = (here / name).read_text(encoding="utf-8")
        assert not re.search(r"sk-[A-Za-z0-9]{16,}", src), name
    assert "LLM_API_KEY = os.getenv" in (here / "main.py").read_text(encoding="utf-8")


# ================= 账号自存的 API Key =================

print("\n[加密存储]")


@test("加密后的密文不含明文，且能解回原值")
def _():
    token = crypto.encrypt("sk-secret-abcd1234")
    assert "sk-secret-abcd1234" not in token
    assert crypto.decrypt(token) == "sk-secret-abcd1234"


@test("同一明文两次加密得到不同密文（含随机 IV）")
def _():
    a = crypto.encrypt("sk-same-value-1234")
    b = crypto.encrypt("sk-same-value-1234")
    assert a != b
    assert crypto.decrypt(a) == crypto.decrypt(b)


@test("密钥不对时解密抛 ValueError 而不是返回垃圾")
def _():
    from cryptography.fernet import Fernet
    token = Fernet(Fernet.generate_key()).encrypt(b"x").decode()
    try:
        crypto.decrypt(token)
        raise AssertionError("应该抛 ValueError")
    except ValueError:
        pass


@test("被改过一个字符的密文无法通过认证")
def _():
    token = crypto.encrypt("sk-tamper-test-9999")
    # 必须改中段：base64 末尾字符含未使用位，动它可能不改变解码后的字节，
    # 那样断言就会时通时不通。
    i = len(token) // 2
    bad = token[:i] + ("A" if token[i] != "A" else "B") + token[i + 1:]
    assert bad != token
    try:
        crypto.decrypt(bad)
        raise AssertionError("篡改后应该解不开")
    except ValueError:
        pass


@test("遮掩只露出末 4 位，不露中间")
def _():
    m = crypto.mask("sk-1234567890abcdef")
    assert m.endswith("cdef")
    assert "567890" not in m
    assert crypto.mask("") == ""


print("\n[账号 AI 配置接口]")


@test("未登录访问 ai-config 返回 401")
def _():
    c = fresh()
    assert c.get("/api/ai-config").status_code == 401
    assert c.put("/api/ai-config", json={"model": "m", "api_key": "k"}).status_code == 401
    assert c.delete("/api/ai-config").status_code == 401


@test("新账号读配置时为空，并报告服务端有兜底 key")
def _():
    c = fresh()
    t = signup(c)
    body = c.get("/api/ai-config", headers=hdr(t)).json()
    assert body["has_key"] is False
    assert body["api_key_masked"] == ""
    assert body["server_fallback"] is True   # 测试环境设了 LLM_API_KEY


@test("保存后 GET 只回遮掩形式，永不回明文")
def _():
    c = fresh()
    t = signup(c)
    r = c.put("/api/ai-config", headers=hdr(t), json={
        "base_url": "https://api.deepseek.com/v1",
        "model": "deepseek-chat",
        "api_key": "sk-account-key-7788",
    })
    assert r.status_code == 200, r.text
    assert "sk-account-key-7788" not in r.text
    body = c.get("/api/ai-config", headers=hdr(t))
    assert "sk-account-key-7788" not in body.text
    j = body.json()
    assert j["has_key"] is True
    assert j["model"] == "deepseek-chat"
    assert j["api_key_masked"].endswith("7788")


@test("数据库里存的是密文，直接读表读不到明文")
def _():
    c = fresh()
    t = signup(c)
    c.put("/api/ai-config", headers=hdr(t),
          json={"model": "m", "api_key": "sk-in-db-check-4321"})
    raw = Path(os.environ["DB_PATH"]).read_bytes()
    assert b"sk-in-db-check-4321" not in raw, "明文 key 落到了数据库文件里"
    with db.get_db() as conn:
        row = conn.execute("SELECT api_key_enc FROM ai_configs").fetchone()
    assert "sk-in-db-check-4321" not in row["api_key_enc"]
    assert crypto.decrypt(row["api_key_enc"]) == "sk-in-db-check-4321"


@test("api_key 省略时保留原 key，只更新其他字段")
def _():
    c = fresh()
    t = signup(c)
    c.put("/api/ai-config", headers=hdr(t),
          json={"model": "old-model", "api_key": "sk-keep-me-5555"})
    c.put("/api/ai-config", headers=hdr(t), json={"model": "new-model"})
    j = c.get("/api/ai-config", headers=hdr(t)).json()
    assert j["model"] == "new-model"
    assert j["has_key"] is True
    assert j["api_key_masked"].endswith("5555")


@test("Base URL 必须是 http(s)，否则 422")
def _():
    c = fresh()
    t = signup(c)
    r = c.put("/api/ai-config", headers=hdr(t),
              json={"base_url": "ftp://evil.example.com", "model": "m", "api_key": "k"})
    assert r.status_code == 422, r.status_code


@test("Base URL 末尾斜杠被规整掉")
def _():
    c = fresh()
    t = signup(c)
    c.put("/api/ai-config", headers=hdr(t), json={
        "base_url": "https://api.deepseek.com/v1/", "model": "m", "api_key": "k"})
    j = c.get("/api/ai-config", headers=hdr(t)).json()
    assert j["base_url"] == "https://api.deepseek.com/v1"


@test("删除后 has_key 归 false，库里记录也没了")
def _():
    c = fresh()
    t = signup(c)
    c.put("/api/ai-config", headers=hdr(t), json={"model": "m", "api_key": "sk-del-1234"})
    assert c.delete("/api/ai-config", headers=hdr(t)).json()["has_key"] is False
    with db.get_db() as conn:
        assert conn.execute("SELECT COUNT(*) c FROM ai_configs").fetchone()["c"] == 0


@test("配置随账号隔离，读不到别人的 key")
def _():
    c = fresh()
    t1 = signup(c, "alice")
    t2 = signup(c, "bob")
    c.put("/api/ai-config", headers=hdr(t1), json={"model": "alice-m", "api_key": "sk-alice-1111"})
    j = c.get("/api/ai-config", headers=hdr(t2)).json()
    assert j["has_key"] is False
    assert j["model"] is None


@test("删号会连带删掉它的 AI 配置（外键级联）")
def _():
    c = fresh()
    t = signup(c)
    c.put("/api/ai-config", headers=hdr(t), json={"model": "m", "api_key": "sk-cascade-1234"})
    with db.get_db() as conn:
        conn.execute("DELETE FROM users")
    with db.get_db() as conn:
        assert conn.execute("SELECT COUNT(*) c FROM ai_configs").fetchone()["c"] == 0


print("\n[AI 调用优先用账号自存的 key]")


@test("存了账号 key 时，上游请求用账号的 key、base_url 与模型")
def _():
    c = fresh()
    t = signup(c)
    c.put("/api/ai-config", headers=hdr(t), json={
        "base_url": "https://acct.example.com/v1",
        "model": "acct-model",
        "api_key": "sk-acct-used-2222",
    })
    r = c.post("/api/chat", headers=hdr(t),
               json={"question": "经期能运动吗", "cycle": BASE_CYCLE})
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "account"
    assert captured["url"] == "https://acct.example.com/v1/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer sk-acct-used-2222"
    assert captured["json"]["model"] == "acct-model"


@test("没存账号 key 时退回服务端环境变量")
def _():
    c = fresh()
    t = signup(c)
    r = c.post("/api/chat", headers=hdr(t),
               json={"question": "经期能运动吗", "cycle": BASE_CYCLE})
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "server"
    assert captured["headers"]["Authorization"] == f"Bearer {srv.LLM_API_KEY}"


@test("账号只填了 key、没填 base_url 时沿用服务端默认地址")
def _():
    c = fresh()
    t = signup(c)
    c.put("/api/ai-config", headers=hdr(t), json={"model": "only-model", "api_key": "sk-only-key-3333"})
    c.post("/api/chat", headers=hdr(t), json={"question": "问题", "cycle": BASE_CYCLE})
    assert captured["url"].startswith(srv.LLM_BASE_URL.rstrip("/"))
    assert captured["headers"]["Authorization"] == "Bearer sk-only-key-3333"


@test("账号 key 解不开时返回 500 并提示重填，不静默改用服务端 key")
def _():
    c = fresh()
    t = signup(c)
    c.put("/api/ai-config", headers=hdr(t), json={"model": "m", "api_key": "sk-broken-4444"})
    with db.get_db() as conn:
        conn.execute("UPDATE ai_configs SET api_key_enc = 'not-a-valid-token'")
    r = c.post("/api/chat", headers=hdr(t), json={"question": "问题", "cycle": BASE_CYCLE})
    assert r.status_code == 500
    assert "重新填写" in r.text


@test("服务端与账号都没有 key 时返回 503，且提示两种解法")
def _():
    c = fresh()
    t = signup(c)
    orig = srv.LLM_API_KEY
    srv.LLM_API_KEY = ""
    try:
        r = c.post("/api/chat", headers=hdr(t), json={"question": "问题", "cycle": BASE_CYCLE})
        assert r.status_code == 503
        assert "设置" in r.text
    finally:
        srv.LLM_API_KEY = orig


@test("AI 回复仍然过安全过滤，账号 key 也不例外")
def _():
    c = fresh(FakeResponse(payload={
        "choices": [{"message": {"content": "建议服用布洛芬缓解疼痛。"}}]}))
    t = signup(c)
    c.put("/api/ai-config", headers=hdr(t), json={"model": "m", "api_key": "sk-filter-6666"})
    r = c.post("/api/chat", headers=hdr(t), json={"question": "痛经吃什么", "cycle": BASE_CYCLE})
    assert r.status_code == 200
    assert "布洛芬" not in r.json()["answer"]


@test("上游报错时不把 key 回显给前端")
def _():
    c = fresh(FakeResponse(status_code=401, payload={"error": "invalid key sk-acct-leak-7777"}))
    t = signup(c)
    c.put("/api/ai-config", headers=hdr(t), json={"model": "m", "api_key": "sk-acct-leak-7777"})
    r = c.post("/api/chat", headers=hdr(t), json={"question": "问题", "cycle": BASE_CYCLE})
    assert r.status_code == 502
    assert "sk-acct-leak-7777" not in r.text


print("\n[PWA 静态资源]")


@test("首页可访问")
def _():
    c = fresh()
    r = c.get("/")
    assert r.status_code == 200
    assert "NEBULA ROSETTE" in r.text


@test("manifest 从根路径提供，且 content-type 正确")
def _():
    c = fresh()
    r = c.get("/manifest.webmanifest")
    assert r.status_code == 200, r.status_code
    assert "manifest+json" in r.headers["content-type"], r.headers["content-type"]
    assert json.loads(r.text)["short_name"] == "月历"


@test("manifest 里声明的图标都能真的取到")
def _():
    c = fresh()
    for icon in json.loads(c.get("/manifest.webmanifest").text)["icons"]:
        r = c.get("/" + icon["src"])
        assert r.status_code == 200, f'{icon["src"]} -> {r.status_code}'
        assert r.headers["content-type"].startswith("image/"), icon["src"]


@test("sw.js 从根路径提供并允许根作用域")
def _():
    # 作用域是关键：从 /js/ 下提供的 SW 管不到首页，离线兜底就失效了
    c = fresh()
    r = c.get("/sw.js")
    assert r.status_code == 200, r.status_code
    assert "javascript" in r.headers["content-type"]
    assert r.headers.get("service-worker-allowed") == "/"
    assert "no-cache" in r.headers.get("cache-control", "")


@test("sw.js 不缓存 API：经期数据不该落到磁盘缓存")
def _():
    c = fresh()
    body = c.get("/sw.js").text
    assert "/api/" in body
    assert "addEventListener('push'" not in body


@test("背景图仍可访问")
def _():
    c = fresh()
    assert c.get("/assets/backdrop.svg").status_code == 200


# ================= 恢复码 =================

print("\n[恢复码]")


@test("生成的码只含不易混淆的字符（无 0/O/1/I/L）")
def _():
    codes = auth.generate_recovery_codes(20)
    assert len(codes) == 20
    for c in codes:
        assert len(c) == 14, c              # ABCD-EFGH-JKMN
        assert c.count("-") == 2, c
        body = c.replace("-", "")
        for bad in "01OIL":
            assert bad not in body, f"{c} 含易混字符 {bad}"


@test("同一批码互不重复")
def _():
    codes = auth.generate_recovery_codes(50)
    assert len(set(codes)) == 50


@test("恢复码校验忽略大小写、空格与连字符")
def _():
    code = auth.generate_recovery_codes(1)[0]
    h = auth.hash_recovery_code(code)
    assert auth.hash_recovery_code(code.lower()) == h
    assert auth.hash_recovery_code(code.replace("-", "")) == h
    assert auth.hash_recovery_code(" " + code.replace("-", " ") + " ") == h


@test("易混字符不做纠错映射：抄错就失败，不会撞成另一个码")
def _():
    # 字母表里没有 O/I，所以输入 O 只可能是抄错。
    # 若做了 0→O 之类映射，就有概率变成另一个有效码。
    assert auth.hash_recovery_code("ABCD-EFGH-JKMN") != auth.hash_recovery_code("ABCD-EFGH-JKMO")


@test("新账号没有恢复码")
def _():
    c = fresh()
    t = signup(c)
    r = c.get("/api/auth/recovery", headers=hdr(t))
    assert r.status_code == 200, r.text
    assert r.json() == {"total": 0, "unused": 0, "used": 0}


@test("生成恢复码需要重新验密码")
def _():
    c = fresh()
    t = signup(c)
    r = c.post("/api/auth/recovery", json={"password": "wrong-password"}, headers=hdr(t))
    assert r.status_code == 401, r.status_code
    r = c.post("/api/auth/recovery", json={"password": "password123"}, headers=hdr(t))
    assert r.status_code == 200, r.text
    assert len(r.json()["codes"]) == 10


@test("未登录不能生成恢复码")
def _():
    c = fresh()
    signup(c)
    r = c.post("/api/auth/recovery", json={"password": "password123"})
    assert r.status_code == 401


@test("恢复码明文不落库，库里只有哈希")
def _():
    c = fresh()
    t = signup(c)
    codes = c.post("/api/auth/recovery", json={"password": "password123"},
                   headers=hdr(t)).json()["codes"]
    with db.get_db() as conn:
        rows = conn.execute("SELECT code_hash FROM recovery_codes").fetchall()
    stored = {r["code_hash"] for r in rows}
    assert len(stored) == 10
    for code in codes:
        assert code not in stored
        assert code.replace("-", "") not in stored
        assert auth.hash_recovery_code(code) in stored


@test("用恢复码重设密码后可以用新密码登录")
def _():
    c = fresh()
    t = signup(c)
    codes = c.post("/api/auth/recovery", json={"password": "password123"},
                   headers=hdr(t)).json()["codes"]
    r = c.post("/api/auth/recovery/reset", json={
        "username": "alice", "code": codes[0], "new_password": "brand-new-pw-1"})
    assert r.status_code == 200, r.text
    assert r.json()["username"] == "alice"
    assert r.json()["token"]
    # 旧密码不再可用，新密码可用
    assert c.post("/api/auth/login",
                  json={"username": "alice", "password": "password123"}).status_code == 401
    assert c.post("/api/auth/login",
                  json={"username": "alice", "password": "brand-new-pw-1"}).status_code == 200


@test("一个恢复码只能用一次")
def _():
    c = fresh()
    t = signup(c)
    codes = c.post("/api/auth/recovery", json={"password": "password123"},
                   headers=hdr(t)).json()["codes"]
    assert c.post("/api/auth/recovery/reset", json={
        "username": "alice", "code": codes[0],
        "new_password": "brand-new-pw-1"}).status_code == 200
    r = c.post("/api/auth/recovery/reset", json={
        "username": "alice", "code": codes[0], "new_password": "another-pw-22"})
    assert r.status_code == 401, r.status_code


@test("重设密码后剩余恢复码全部作废")
def _():
    # 走到用恢复码这一步说明账号已经失控，剩下的纸质码也可能被同一个人看到
    c = fresh()
    t = signup(c)
    codes = c.post("/api/auth/recovery", json={"password": "password123"},
                   headers=hdr(t)).json()["codes"]
    c.post("/api/auth/recovery/reset", json={
        "username": "alice", "code": codes[0], "new_password": "brand-new-pw-1"})
    r = c.post("/api/auth/recovery/reset", json={
        "username": "alice", "code": codes[5], "new_password": "third-pw-333"})
    assert r.status_code == 401, r.status_code


@test("重设密码会踢掉所有旧会话")
def _():
    c = fresh()
    t = signup(c)
    codes = c.post("/api/auth/recovery", json={"password": "password123"},
                   headers=hdr(t)).json()["codes"]
    assert c.get("/api/auth/me", headers=hdr(t)).status_code == 200
    c.post("/api/auth/recovery/reset", json={
        "username": "alice", "code": codes[0], "new_password": "brand-new-pw-1"})
    assert c.get("/api/auth/me", headers=hdr(t)).status_code == 401


@test("恢复码不存在与账号不存在返回同一措辞")
def _():
    c = fresh()
    signup(c)
    a = c.post("/api/auth/recovery/reset", json={
        "username": "alice", "code": "ZZZZ-ZZZZ-ZZZZ", "new_password": "whatever-pw-1"})
    b = c.post("/api/auth/recovery/reset", json={
        "username": "nobody", "code": "ZZZZ-ZZZZ-ZZZZ", "new_password": "whatever-pw-1"})
    assert a.status_code == b.status_code == 401
    assert a.json()["detail"] == b.json()["detail"]


@test("重设密码同样要满足最短长度")
def _():
    c = fresh()
    t = signup(c)
    codes = c.post("/api/auth/recovery", json={"password": "password123"},
                   headers=hdr(t)).json()["codes"]
    r = c.post("/api/auth/recovery/reset", json={
        "username": "alice", "code": codes[0], "new_password": "短"})
    assert r.status_code == 400, r.status_code
    # 校验失败不该白白消耗掉一个码
    assert c.post("/api/auth/recovery/reset", json={
        "username": "alice", "code": codes[0],
        "new_password": "valid-pw-9999"}).status_code == 200


@test("重新生成会作废上一批码")
def _():
    c = fresh()
    t = signup(c)
    old = c.post("/api/auth/recovery", json={"password": "password123"},
                 headers=hdr(t)).json()["codes"]
    new = c.post("/api/auth/recovery", json={"password": "password123"},
                 headers=hdr(t)).json()["codes"]
    assert set(old).isdisjoint(new)
    assert c.post("/api/auth/recovery/reset", json={
        "username": "alice", "code": old[0],
        "new_password": "brand-new-pw-1"}).status_code == 401
    assert c.post("/api/auth/recovery/reset", json={
        "username": "alice", "code": new[0],
        "new_password": "brand-new-pw-1"}).status_code == 200


@test("恢复码统计能反映已用掉几个")
def _():
    c = fresh()
    t = signup(c)
    c.post("/api/auth/recovery", json={"password": "password123"}, headers=hdr(t))
    s = c.get("/api/auth/recovery", headers=hdr(t)).json()
    assert s == {"total": 10, "unused": 10, "used": 0}, s


@test("别人的恢复码不能重设我的密码")
def _():
    c = fresh()
    ta = signup(c, "alice")
    signup(c, "bobby", "bobby-pw-1234")
    a_codes = c.post("/api/auth/recovery", json={"password": "password123"},
                     headers=hdr(ta)).json()["codes"]
    # 用 alice 的码去重设 bobby 的密码
    r = c.post("/api/auth/recovery/reset", json={
        "username": "bobby", "code": a_codes[0], "new_password": "hacked-pw-99"})
    assert r.status_code == 401, r.status_code
    assert c.post("/api/auth/login",
                  json={"username": "bobby", "password": "bobby-pw-1234"}).status_code == 200


# ================= 安全响应头 =================

print("\n[安全响应头]")


@test("首页带上 CSP / nosniff / no-referrer / DENY")
def _():
    c = fresh()
    h = c.get("/").headers
    assert "Content-Security-Policy" in h
    assert h["X-Content-Type-Options"] == "nosniff"
    assert h["Referrer-Policy"] == "no-referrer"
    assert h["X-Frame-Options"] == "DENY"


@test("CSP 禁止被 iframe 嵌套，且不允许任意脚本源")
def _():
    c = fresh()
    csp = c.get("/").headers["Content-Security-Policy"]
    assert "frame-ancestors 'none'" in csp
    assert "default-src 'self'" in csp
    assert "script-src *" not in csp


@test("API 响应一律 no-store：经期数据不进磁盘缓存")
def _():
    c = fresh()
    t = signup(c)
    assert c.get("/api/auth/me", headers=hdr(t)).headers["Cache-Control"] == "no-store"
    assert c.get("/api/data", headers=hdr(t)).headers["Cache-Control"] == "no-store"


@test("401 响应也带安全头（中间件不被异常绕过）")
def _():
    c = fresh()
    r = c.get("/api/auth/me")
    assert r.status_code == 401
    assert r.headers["X-Content-Type-Options"] == "nosniff"


# ================= 数据库迁移 =================

print("\n[数据库迁移]")


@test("老库缺列时 migrate 会补上，且可重复执行")
def _():
    import sqlite3 as _sq
    path = Path(_TMP) / "legacy.db"
    if path.exists():
        path.unlink()
    conn = _sq.connect(path)
    conn.row_factory = _sq.Row
    # 模拟旧版本的表结构：notes 无 symptoms，sessions 无 device/last_seen
    conn.executescript("""
        CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT,
                            nickname TEXT);
        CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER,
                               created_at TEXT, expires_at TEXT);
        CREATE TABLE notes (id INTEGER PRIMARY KEY, user_id INTEGER, date TEXT,
                            flow TEXT, pain INTEGER, text TEXT, updated_at TEXT);
    """)
    done = db.migrate(conn)
    assert set(done) == {"notes.symptoms", "sessions.device", "sessions.last_seen"}, done
    assert db.migrate(conn) == []          # 幂等
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(notes)")}
    assert "symptoms" in cols
    conn.close()


# ================= 注销账号 =================

print("\n[注销账号]")


def _seed_everything(c, token):
    """给账号塞满各类数据，用来验证注销真的清得干净。"""
    c.put("/api/data", json={
        "periods": [{"start": "2026-01-01", "end": "2026-01-05"}],
        "notes": {"2026-01-02": {"flow": "heavy", "pain": 4, "symptoms": ["cramps"],
                                 "text": "很难受"}},
    }, headers=hdr(token))
    c.post("/api/auth/recovery", json={"password": "password123"}, headers=hdr(token))
    c.put("/api/ai-config", json={"base_url": "https://api.example.com/v1",
                                  "model": "some-model", "api_key": "sk-secret"},
          headers=hdr(token))


@test("注销需要密码正确")
def _():
    c = fresh()
    t = signup(c)
    r = c.post("/api/auth/delete-account",
               json={"password": "wrong-one", "confirm_username": "alice"},
               headers=hdr(t))
    assert r.status_code == 401, r.status_code
    assert c.get("/api/auth/me", headers=hdr(t)).status_code == 200, "账号不该被删"


@test("注销需要重打一次用户名，防误删")
def _():
    c = fresh()
    t = signup(c)
    r = c.post("/api/auth/delete-account",
               json={"password": "password123", "confirm_username": "alicee"},
               headers=hdr(t))
    assert r.status_code == 400, r.status_code
    assert c.get("/api/auth/me", headers=hdr(t)).status_code == 200


@test("未登录不能注销")
def _():
    c = fresh()
    signup(c)
    r = c.post("/api/auth/delete-account",
               json={"password": "password123", "confirm_username": "alice"})
    assert r.status_code == 401


@test("注销后所有相关行一起消失（级联真的生效）")
def _():
    c = fresh()
    t = signup(c)
    _seed_everything(c, t)

    with db.get_db() as conn:
        uid = conn.execute("SELECT id FROM users WHERE username = 'alice'").fetchone()["id"]
        before = {
            tbl: conn.execute(f"SELECT COUNT(*) c FROM {tbl} WHERE user_id = ?",
                              (uid,)).fetchone()["c"]
            for tbl in ("periods", "notes", "sessions", "recovery_codes", "ai_configs")
        }
    for tbl, n in before.items():
        assert n > 0, f"{tbl} 没有数据，这个用例就测不出级联"

    r = c.post("/api/auth/delete-account",
               json={"password": "password123", "confirm_username": "alice"},
               headers=hdr(t))
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] == {"periods": 1, "notes": 1}, r.json()

    with db.get_db() as conn:
        assert conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"] == 0
        for tbl in ("periods", "notes", "sessions", "recovery_codes", "ai_configs"):
            n = conn.execute(f"SELECT COUNT(*) c FROM {tbl} WHERE user_id = ?",
                             (uid,)).fetchone()["c"]
            assert n == 0, f"{tbl} 还剩 {n} 行孤儿数据"


@test("注销后 token 立即失效")
def _():
    c = fresh()
    t = signup(c)
    c.post("/api/auth/delete-account",
           json={"password": "password123", "confirm_username": "alice"}, headers=hdr(t))
    assert c.get("/api/auth/me", headers=hdr(t)).status_code == 401
    assert c.get("/api/data", headers=hdr(t)).status_code == 401


@test("注销后同名可以重新注册，且拿不到旧数据")
def _():
    c = fresh()
    t = signup(c)
    _seed_everything(c, t)
    c.post("/api/auth/delete-account",
           json={"password": "password123", "confirm_username": "alice"}, headers=hdr(t))

    t2 = signup(c, password="another-pass-1")
    r = c.get("/api/data", headers=hdr(t2))
    assert r.status_code == 200, r.text
    assert r.json()["periods"] == [], "新账号看到了旧数据"
    assert r.json()["notes"] == {}
    # 恢复码也不该继承
    assert c.get("/api/auth/recovery", headers=hdr(t2)).json()["total"] == 0


@test("注销只影响自己，不碰别的账号")
def _():
    c = fresh()
    t1 = signup(c, "alice")
    t2 = signup(c, "bob")
    c.put("/api/data", json={"periods": [{"start": "2026-02-01", "end": "2026-02-05"}],
                             "notes": {}}, headers=hdr(t2))
    c.post("/api/auth/delete-account",
           json={"password": "password123", "confirm_username": "alice"}, headers=hdr(t1))
    r = c.get("/api/data", headers=hdr(t2))
    assert r.status_code == 200, r.text
    assert len(r.json()["periods"]) == 1, "bob 的数据被牵连"


print("\n[反代与真实来源 IP]")


@test("默认不信 X-Forwarded-For（伪造这个头不能绕过限流）")
def _():
    c = fresh()
    srv.TRUST_PROXY = False
    try:
        # 每次换一个伪造 IP。如果被采信，每次都是新桶，永远不会 429
        for i in range(srv.LOGIN_ATTEMPTS_PER_MIN + 2):
            r = c.post("/api/auth/login",
                       json={"username": "nobody", "password": "password123"},
                       headers={"X-Forwarded-For": f"9.9.9.{i}"})
            if r.status_code == 429:
                break
        else:
            raise AssertionError("伪造 X-Forwarded-For 绕过了限流")
    finally:
        srv.TRUST_PROXY = False


@test("TRUST_PROXY=1 时按 X-Forwarded-For 分桶，不同客户端互不影响")
def _():
    c = fresh()
    srv.TRUST_PROXY = True
    try:
        # 用满一个 IP 的额度
        for _i in range(srv.LOGIN_ATTEMPTS_PER_MIN + 2):
            r = c.post("/api/auth/login",
                       json={"username": "nobody", "password": "password123"},
                       headers={"X-Forwarded-For": "203.0.113.7"})
        assert r.status_code == 429, "同一 IP 应被限流"
        # 另一个 IP 仍然可用——反代下所有人共用 127.0.0.1 桶会互相锁死
        r2 = c.post("/api/auth/login",
                    json={"username": "nobody", "password": "password123"},
                    headers={"X-Forwarded-For": "203.0.113.8"})
        assert r2.status_code == 401, f"另一 IP 不该被牵连: {r2.status_code}"
    finally:
        srv.TRUST_PROXY = False


@test("X-Forwarded-For 取最右一个（左边的可由客户端伪造）")
def _():
    c = fresh()
    srv.TRUST_PROXY = True
    try:
        for _i in range(srv.LOGIN_ATTEMPTS_PER_MIN + 2):
            r = c.post("/api/auth/login",
                       json={"username": "nobody", "password": "password123"},
                       headers={"X-Forwarded-For": "1.1.1.1, 198.51.100.5"})
        assert r.status_code == 429
        # 换掉左边伪造的部分、保持最右不变 —— 仍应命中同一个桶
        r2 = c.post("/api/auth/login",
                    json={"username": "nobody", "password": "password123"},
                    headers={"X-Forwarded-For": "2.2.2.2, 198.51.100.5"})
        assert r2.status_code == 429, "改左边就换桶说明取错了位置"
    finally:
        srv.TRUST_PROXY = False


print("\n[部署配置]")


@test("Dockerfile 不信任任意来源的 X-Forwarded-For")
def _():
    # uvicorn 会在应用看到请求之前就按 X-Forwarded-For 改写来源 IP，
    # 一旦写了 --forwarded-allow-ips "*"，公开映射的端口就等于把登录限流
    # 交给了请求方自己填的头。默认只信回环地址就覆盖了文档里的部署方式。
    # 只查 CMD 行：注释里提到这个选项是刻意写明的禁忌，不是真的启用。
    root = Path(__file__).resolve().parent.parent
    text = (root / "Dockerfile").read_text(encoding="utf-8")
    cmd = [ln for ln in text.splitlines() if ln.startswith("CMD")]
    assert len(cmd) == 1, f"Dockerfile 应恰好有一条 CMD，实际 {len(cmd)} 条"
    assert "forwarded-allow-ips" not in cmd[0], "CMD 不应信任任意来源的 XFF"
    assert "--proxy-headers" in cmd[0]


print(f"\n{passed} passed, {failed} failed\n")

# 清理临时库
import shutil
shutil.rmtree(_TMP, ignore_errors=True)

sys.exit(1 if failed else 0)
