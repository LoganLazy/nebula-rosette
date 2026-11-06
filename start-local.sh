#!/usr/bin/env bash
set -euo pipefail
# 本机预览由用户级 systemd 托管，关闭终端后继续运行。
systemctl --user start nebula-rosette-local.service
systemctl --user is-active nebula-rosette-local.service
echo '月历地址：http://127.0.0.1:8000'
echo '停止：systemctl --user stop nebula-rosette-local.service'
