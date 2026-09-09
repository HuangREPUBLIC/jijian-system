#!/usr/bin/env bash
#
# 在【服务器上】跑的部署脚本：备份数据库 → 更新代码 → 装依赖 → 重启 → 健康检查。
# 任何一步失败就停下，不会留下"代码更新了但没重启"这种半吊子状态；
# 服务起不来会自动把代码回滚到部署前的 commit。
#
#   用法（在服务器上，仓库目录里执行）：
#     ./scripts/deploy.sh                      # 从 origin 拉（需要能连上 GitHub）
#     ./scripts/deploy.sh /tmp/xxx.bundle      # 从 git bundle 拉（服务器连不上 GitHub 时用）
#
# 为什么要支持 bundle：这台服务器在国内，连 github.com:443 会超时。
# 在本机执行下面两条，再把 bundle 传上来，就能绕开：
#     git bundle create /tmp/update.bundle <服务器当前commit>..main
#     scp /tmp/update.bundle daka-prod:/tmp/
#
set -euo pipefail

BUNDLE="${1:-}"
SERVICE="jijian"
HEALTH_URL="http://localhost:3001/"
BACKUP_DIR="/root/backups"

cd "$(dirname "$0")/.."
echo "▸ 仓库：$(pwd)"
echo "▸ 当前版本：$(git log --oneline -1)"
OLD_REV="$(git rev-parse HEAD)"

# ---------- 1. 备份数据库 ----------
# 迁移会 ALTER TABLE，出问题时这份备份是唯一的退路，所以放在最前面、失败就中止。
DB="$(grep '^MYSQL_DATABASE=' .env | cut -d= -f2 | tr -d '\r')"
if [ -z "$DB" ]; then echo "✗ .env 里没有 MYSQL_DATABASE，中止" >&2; exit 1; fi
mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/${SERVICE}-$(date +%Y%m%d-%H%M%S).sql.gz"
echo "▸ 备份数据库 $DB → $BACKUP"
mysqldump --single-transaction --routines "$DB" | gzip > "$BACKUP"
echo "  $(du -h "$BACKUP" | cut -f1)"

# 只留最近 10 份，免得慢慢把盘塞满
ls -1t "$BACKUP_DIR/${SERVICE}-"*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm --

# ---------- 2. 更新代码 ----------
if [ -n "$BUNDLE" ]; then
  echo "▸ 从 bundle 更新：$BUNDLE"
  git bundle verify "$BUNDLE" >/dev/null
  git pull --ff-only "$BUNDLE" main
else
  echo "▸ 从 origin 更新"
  git pull --ff-only origin main
fi
NEW_REV="$(git rev-parse HEAD)"

if [ "$OLD_REV" = "$NEW_REV" ]; then
  echo "▸ 代码没有变化，跳过依赖安装与重启"
  exit 0
fi
echo "▸ 新版本：$(git log --oneline -1)"

# ---------- 3. 依赖 ----------
echo "▸ 安装依赖"
npm install --omit=dev

# ---------- 4. 重启 ----------
# 数据库迁移是服务端启动时自动跑的（server/db.js 的 init()），所以重启就等于迁移。
echo "▸ 重启 $SERVICE"
systemctl restart "$SERVICE"

# ---------- 5. 健康检查 ----------
# 启动要建库建表跑迁移，给它几秒；连续探活失败就回滚代码并重启回旧版本。
echo -n "▸ 健康检查 "
for _ in $(seq 1 15); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$HEALTH_URL" || true)"
  if [ "$CODE" = "200" ]; then
    echo "→ 200 ✓"
    echo
    echo "▸ 迁移日志："
    journalctl -u "$SERVICE" --since '1 min ago' --no-pager -o cat \
      | grep -E '\[migrate\]|\[db\]|\[push\]' || echo "  （本次没有新迁移）"
    echo
    echo "✓ 部署完成：${OLD_REV:0:7} → ${NEW_REV:0:7}"
    echo "  代码回滚：git reset --hard $OLD_REV && npm install --omit=dev && systemctl restart $SERVICE"
    echo "  数据回滚：gunzip -c $BACKUP | mysql $DB"
    exit 0
  fi
  echo -n "."
  sleep 2
done

echo " → 失败（最后一次 HTTP $CODE）"
echo "✗ 服务起不来，自动把代码回滚到 ${OLD_REV:0:7}" >&2
git reset --hard "$OLD_REV"
npm install --omit=dev
systemctl restart "$SERVICE"
echo "✗ 已回滚。数据库如果也要退回：gunzip -c $BACKUP | mysql $DB" >&2
echo "  排查：journalctl -u $SERVICE -n 50 --no-pager" >&2
exit 1
