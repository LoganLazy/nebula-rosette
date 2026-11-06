"""
Nebula Rosette — 认证

口令哈希用标准库的 PBKDF2-HMAC-SHA256（passlib/bcrypt 不在环境里，
而 PBKDF2 是 hashlib 自带且被广泛接受的方案）。

会话用随机 token + Bearer 头。数据库里只存 token 的 SHA-256，
不存原文：库被读走也无法直接冒用登录态。
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Optional

PBKDF2_ITERATIONS = int(os.getenv("PBKDF2_ITERATIONS", "260000"))
SESSION_DAYS = int(os.getenv("SESSION_DAYS", "30"))
MIN_PASSWORD_LEN = 8


# ---------- 口令 ----------

def hash_password(password: str, *, salt: Optional[bytes] = None,
                  iterations: Optional[int] = None) -> str:
    """返回 ``pbkdf2_sha256$<iterations>$<salt_hex>$<hash_hex>``。"""
    it = iterations or PBKDF2_ITERATIONS
    s = salt or secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), s, it)
    return f"pbkdf2_sha256${it}${s.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """定时安全比较；格式非法一律返回 False，不抛异常。"""
    try:
        algo, it_s, salt_hex, hash_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(it_s)
        )
    except (ValueError, AttributeError):
        return False
    return hmac.compare_digest(dk.hex(), hash_hex)


def needs_rehash(stored: str) -> bool:
    """迭代次数被上调后，登录成功时顺带升级旧哈希。"""
    try:
        _, it_s, _, _ = stored.split("$")
        return int(it_s) < PBKDF2_ITERATIONS
    except (ValueError, AttributeError):
        return True


# ---------- 会话 ----------

def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def token_hash(token: str) -> str:
    """公开版本：改密码时需要算出「当前设备」的 hash 以便保留它的会话。"""
    return _hash_token(token)


def create_session(conn: sqlite3.Connection, user_id: int,
                   device: Optional[str] = None) -> tuple[str, str]:
    """返回 ``(token 原文, 过期时间 ISO)``；原文只在此刻交给客户端。"""
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
    expires_s = expires.strftime("%Y-%m-%d %H:%M:%S")
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, device, last_seen, expires_at) "
        "VALUES (?, ?, ?, datetime('now'), ?)",
        (_hash_token(token), user_id, device, expires_s),
    )
    return token, expires_s


def describe_device(user_agent: Optional[str]) -> str:
    """
    把 User-Agent 概括成一句人能认出来的机型，例如「iPhone · Safari」。
    刻意只保留这一层粒度：更细没有帮助，而完整 UA 是指纹材料，不值得落库。
    """
    ua = (user_agent or "").strip()
    if not ua:
        return "未知设备"

    plat = "未知系统"
    for needle, name in (
        ("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"),
        ("Macintosh", "Mac"), ("Mac OS X", "Mac"), ("Windows", "Windows"),
        ("CrOS", "ChromeOS"), ("Linux", "Linux"),
    ):
        if needle in ua:
            plat = name
            break

    # 顺序有讲究：Edge/Chrome 的 UA 里都含 "Safari"，Chrome 的里还含 "Edg"，
    # 从最专有的关键字开始判断，否则一律会被认成 Safari。
    browser = ""
    for needle, name in (
        ("Edg/", "Edge"), ("OPR/", "Opera"), ("SamsungBrowser", "Samsung"),
        ("MicroMessenger", "微信"), ("Firefox/", "Firefox"),
        ("Chrome/", "Chrome"), ("Safari/", "Safari"),
    ):
        if needle in ua:
            browser = name
            break

    return f"{plat} · {browser}" if browser else plat


def resolve_session(conn: sqlite3.Connection, token: str) -> Optional[int]:
    """token 有效则返回 user_id；过期或不存在返回 None。"""
    if not token:
        return None
    row = conn.execute(
        "SELECT user_id FROM sessions "
        "WHERE token_hash = ? AND expires_at > datetime('now')",
        (_hash_token(token),),
    ).fetchone()
    return int(row["user_id"]) if row else None


def revoke_session(conn: sqlite3.Connection, token: str) -> None:
    conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash_token(token),))


def revoke_all_sessions(conn: sqlite3.Connection, user_id: int) -> None:
    conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))


# ---------- 恢复码 ----------

RECOVERY_CODE_COUNT = 10

# 刻意去掉 0/O/1/I/L：恢复码要抄到纸上，这几个字符手写后无法区分，
# 用户抄错时会得到「码不对」而无法自救，那这个功能就白做了。
_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
_CODE_GROUP = 4
_CODE_GROUPS = 3          # 4×3 = 12 个字符，约 59 bit 熵，足够抗在线爆破


def generate_recovery_codes(count: int = RECOVERY_CODE_COUNT) -> list[str]:
    """生成一组人可抄写的恢复码，形如 ``ABCD-EFGH-JKMN``。"""
    codes = []
    for _ in range(count):
        groups = [
            "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_GROUP))
            for _ in range(_CODE_GROUPS)
        ]
        codes.append("-".join(groups))
    return codes


def normalize_recovery_code(code: str) -> str:
    """
    宽松接受用户的输入：忽略大小写、空格和连字符位置，只保留字母数字。

    刻意不做 0↔O、1↔I 这类纠错映射：这两组字符压根不在字母表里，
    所以「用户写了 O」只可能是抄错，猜成另一个字符有可能猜成别人的有效码，
    不如让它明确失败。真正的防抄错手段是生成时就不产生这些字符。
    """
    return "".join(ch for ch in (code or "").upper() if ch.isalnum())


def hash_recovery_code(code: str) -> str:
    """
    单轮 SHA-256。恢复码是 59 bit 系统随机串而不是人选口令，
    没有字典可用；换成 PBKDF2 只会让服务端校验时逐个试码变得极慢。
    """
    return hashlib.sha256(normalize_recovery_code(code).encode("utf-8")).hexdigest()


def format_recovery_code(code: str) -> str:
    """把归一化后的串重新加上连字符，用于展示。"""
    s = normalize_recovery_code(code)
    return "-".join(s[i:i + _CODE_GROUP] for i in range(0, len(s), _CODE_GROUP))


# ---------- 校验 ----------

def validate_username(name: str) -> str:
    name = (name or "").strip()
    if not (3 <= len(name) <= 32):
        raise ValueError("用户名需要 3~32 个字符")
    if not all(c.isalnum() or c in "_-" for c in name):
        raise ValueError("用户名只能包含字母、数字、下划线和连字符")
    return name


def validate_password(pw: str) -> str:
    if not pw or len(pw) < MIN_PASSWORD_LEN:
        raise ValueError(f"密码至少 {MIN_PASSWORD_LEN} 位")
    if len(pw) > 128:
        raise ValueError("密码过长")
    return pw
