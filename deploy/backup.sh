#!/bin/sh
# Nebula Rosette —— 备份数据库 + 加密密钥。
#
# 为什么不能只 cp 那个 .db 文件：
#   1. 库开了 WAL 模式，最近的写入可能还在 -wal 里，直接拷主文件会丢；
#      所以走 sqlite3 的 .backup 命令，它会拿一致性快照。
#   2. 库里存的 AI API Key 是用 .enc_key 加密的。**只备份 .db 等于备份了
#      一堆解不开的密文。** 两个必须一起。
#
# 用法：
#   sh deploy/backup.sh                      # 默认输出到 ./backups
#   sh deploy/backup.sh /mnt/nas/rosette     # 指定目录
#
# 定时任务（每天 3:20，保留 30 天）：
#   20 3 * * * cd /srv/nebula-rosette && sh deploy/backup.sh >> /var/log/rosette-backup.log 2>&1

set -eu

OUT_DIR="${1:-./backups}"
CONTAINER="${CONTAINER:-nebula-rosette}"
KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$OUT_DIR"

# 备份文件里有完整的健康记录和加密密钥，权限必须收紧
chmod 700 "$OUT_DIR"

WORK="$(mktemp -d)"
# shellcheck disable=SC2064
trap "rm -rf '$WORK'" EXIT INT TERM

if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "从容器 $CONTAINER 备份"

  # sqlite3 CLI 在 python:slim 镜像里没有，用 Python 的 sqlite3 模块做
  # 在线备份——同样是一致性快照，不需要停服。
  docker exec "$CONTAINER" python -c "
import sqlite3, os
src = sqlite3.connect(os.environ.get('DB_PATH', '/data/nebula.db'))
dst = sqlite3.connect('/tmp/backup.db')
src.backup(dst)
dst.close(); src.close()
print('snapshot ok')
"
  docker cp "$CONTAINER:/tmp/backup.db" "$WORK/nebula.db"
  docker exec "$CONTAINER" rm -f /tmp/backup.db

  # 密钥可能来自环境变量 CONFIG_ENC_KEY 而不是文件，那种情况下没有文件可拷
  if docker exec "$CONTAINER" test -f /data/.enc_key 2>/dev/null; then
    docker cp "$CONTAINER:/data/.enc_key" "$WORK/.enc_key"
  else
    echo "警告：容器里没有 /data/.enc_key。"
    echo "      如果你是用 CONFIG_ENC_KEY 环境变量提供密钥的，请单独妥善保存它，"
    echo "      否则这份备份里的 AI API Key 将无法解密。"
  fi
else
  echo "未发现容器 $CONTAINER，按裸机部署处理"

  DB="${DB_PATH:-server/nebula.db}"
  [ -f "$DB" ] || { echo "找不到数据库 $DB" >&2; exit 1; }

  python3 -c "
import sqlite3, sys
src = sqlite3.connect(sys.argv[1])
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
dst.close(); src.close()
" "$DB" "$WORK/nebula.db"

  KEY="${ENC_KEY_FILE:-server/.enc_key}"
  if [ -f "$KEY" ]; then
    cp "$KEY" "$WORK/.enc_key"
  else
    echo "警告：找不到密钥文件 $KEY，库里的 AI API Key 将无法解密。"
  fi
fi

ARCHIVE="$OUT_DIR/rosette-$STAMP.tar.gz"
tar -czf "$ARCHIVE" -C "$WORK" .
chmod 600 "$ARCHIVE"

echo "已写入 $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

# 清理过期备份。-mtime 而不是按文件名排序：改过时区或补跑过脚本时
# 文件名的顺序未必等于时间顺序。
find "$OUT_DIR" -maxdepth 1 -name 'rosette-*.tar.gz' -mtime "+$KEEP_DAYS" -print -delete

cat <<'EOF'

恢复方式：
  tar -xzf rosette-<时间戳>.tar.gz -C /tmp/restore
  docker compose down
  docker run --rm -v nebula-data:/data -v /tmp/restore:/restore alpine \
    sh -c 'cp /restore/nebula.db /data/nebula.db && cp /restore/.enc_key /data/.enc_key'
  docker compose up -d

注意：恢复会覆盖现有数据，且 .db 与 .enc_key 必须来自同一份备份，
否则库里存的 AI API Key 解不开。
EOF
