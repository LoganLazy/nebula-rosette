"""
Nebula Rosette — 静态数据加密

只用来加密存在库里的第三方 API Key。用 Fernet（AES-128-CBC + HMAC），
密钥来自环境变量 CONFIG_ENC_KEY；没配置时自动生成并写到 server/.enc_key（0600）。

为什么要加密：API Key 是可直接换成钱的凭证，和口令不同——口令可以只存单向哈希，
但 Key 必须能还原出来去调上游，所以只能对称加密。这样即使 nebula.db 被拷走，
没有密钥文件也用不了里面的 Key。

注意这不是万能的：能读到数据库的人通常也能读到同目录的密钥文件。
它防的是「数据库单独泄露」（误传 git、备份外泄、只挂了数据卷），
不防已经拿到服务器完整权限的攻击者。
"""
from __future__ import annotations

import os
import stat
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

KEY_FILE = Path(os.getenv("ENC_KEY_FILE", Path(__file__).parent / ".enc_key"))


def _load_or_create_key() -> bytes:
    env_key = os.getenv("CONFIG_ENC_KEY", "").strip()
    if env_key:
        return env_key.encode("utf-8")

    if KEY_FILE.exists():
        return KEY_FILE.read_bytes().strip()

    key = Fernet.generate_key()
    KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    KEY_FILE.write_bytes(key)
    try:
        KEY_FILE.chmod(stat.S_IRUSR | stat.S_IWUSR)  # 0600
    except OSError:
        pass  # 某些文件系统（如 Windows / 挂载卷）不支持，不致命
    return key


_fernet: Fernet | None = None


def _cipher() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_load_or_create_key())
    return _fernet


def reset_cipher() -> None:
    """测试用：换过环境变量后强制重新加载密钥。"""
    global _fernet
    _fernet = None


def encrypt(plain: str) -> str:
    return _cipher().encrypt(plain.encode("utf-8")).decode("ascii")


def decrypt(token: str) -> str:
    """解不开时抛 ValueError —— 通常意味着密钥换了或数据被改过。"""
    try:
        return _cipher().decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError, TypeError) as e:
        raise ValueError("无法解密，密钥可能已更换") from e


def mask(secret: str) -> str:
    """给前端看的遮掩形式，例如 ``sk-…a1b2``。永远不回传完整 Key。"""
    if not secret:
        return ""
    tail = secret[-4:] if len(secret) >= 8 else ""
    head = secret[:3] if len(secret) >= 12 else ""
    return f"{head}…{tail}" if tail else "已保存"
