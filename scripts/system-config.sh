#!/usr/bin/env bash
# =============================================================================
# IPAM · 系统服务配置（第 3 层脚本：systemd + nginx）
# -----------------------------------------------------------------------------
# 用法： ./scripts/system-config.sh [选项]
#   --check    只检查现状与将要写入的内容是否一致，不修改任何文件
#   --render   只打印将要写入的 systemd unit 与 nginx 配置（不写、不需要 root）
#   --apply    写入配置并启动服务（默认；需要 sudo）
#   --remove   停止并移除本脚本创建的 systemd / nginx 配置（不动代码与数据）
#   --help     显示帮助
#
# 环境变量（全部可选，带默认值）：
#   IPAM_DIR              项目根目录（默认：本脚本的上级目录）
#   IPAM_SERVICE_USER     运行服务的系统用户（默认：SUDO_USER 或当前用户）
#   IPAM_SERVICE_NAME     systemd 服务名 / nginx 站点名（默认：ipam）
#   IPAM_PORT             后端 uvicorn 端口（默认：8000）
#   IPAM_HTTP_PORT        nginx 对外端口（默认：80）
#   IPAM_BIND_HOST        uvicorn 监听地址（默认：0.0.0.0）
#   IPAM_DEMO_SEED        写入 unit 的数据模式（默认：0，纯净）
#   IPAM_WITH_NGINX       是否配置 nginx（默认：1；设 0 则只配 systemd）
#
# 幂等：配置内容相同则跳过写入；重复执行不会重复安装或误改数据。
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IPAM_DIR="${IPAM_DIR:-$ROOT}"
SERVICE_NAME="${IPAM_SERVICE_NAME:-ipam}"
PORT="${IPAM_PORT:-8000}"
HTTP_PORT="${IPAM_HTTP_PORT:-80}"
BIND_HOST="${IPAM_BIND_HOST:-0.0.0.0}"
SEED="${IPAM_DEMO_SEED:-0}"
WITH_NGINX="${IPAM_WITH_NGINX:-1}"

# 服务运行用户：优先 SUDO_USER（避免 sudo 执行时把服务挂到 root 名下）
SVC_USER="${IPAM_SERVICE_USER:-${SUDO_USER:-$(id -un)}}"
SVC_GROUP="$(id -gn "$SVC_USER" 2>/dev/null || printf '%s' "$SVC_USER")"

UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
SITE="/etc/nginx/sites-available/${SERVICE_NAME}"
LINK="/etc/nginx/sites-enabled/${SERVICE_NAME}"
DEFAULT_LINK="/etc/nginx/sites-enabled/default"

MODE="apply"

say()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '    [OK] %s\n' "$*"; }
warn() { printf '    [!] %s\n' "$*"; }
die()  { printf '\n[错误] %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --check)  MODE="check" ;;
    --render) MODE="render" ;;
    --apply)  MODE="apply" ;;
    --remove) MODE="remove" ;;
    -h|--help) usage; exit 0 ;;
    *) printf '未知参数：%s（用 --help 查看用法）\n' "$arg" >&2; exit 2 ;;
  esac
done

# ------------------------------------------------------------ 配置渲染
render_unit() {
  cat <<EOF
[Unit]
Description=IPAM IPv4 Address Management
After=network.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_GROUP
WorkingDirectory=$IPAM_DIR
Environment=PYTHONUNBUFFERED=1
Environment=IPAM_DEMO_SEED=$SEED
ExecStart=$IPAM_DIR/.venv/bin/python -m uvicorn backend.app:app --host $BIND_HOST --port $PORT --proxy-headers --forwarded-allow-ips=127.0.0.1
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
}

render_site() {
  cat <<EOF
server {
    listen $HTTP_PORT default_server;
    listen [::]:$HTTP_PORT default_server;
    server_name _;
    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
}

if [ "$MODE" = "render" ]; then
  printf '# ===== 将要写入 %s =====\n' "$UNIT"
  render_unit
  printf '\n# ===== 将要写入 %s =====\n' "$SITE"
  render_site
  exit 0
fi

if [ "$SVC_USER" = "root" ]; then
  warn "当前以 root 直接运行，服务也会以 root 常驻；更推荐用普通用户执行（脚本内部自动 sudo），或设置 IPAM_SERVICE_USER=你的用户名"
fi

# ------------------------------------------------------------ 前置校验
OS_NAME="$(uname -s)"
if [ "$MODE" != "render" ]; then
  [ "$OS_NAME" = "Linux" ] || die "系统服务配置仅支持 Linux（当前 ${OS_NAME}）。macOS 请用 ./install.sh --start 本机运行"
  command -v systemctl >/dev/null 2>&1 || die "未找到 systemctl，当前系统不是 systemd 环境"
fi
# --check / --render 只是预览，允许应用尚未安装；真正写入时才要求 venv 与 nginx 就绪
if [ "$MODE" = "apply" ]; then
  [ -x "$IPAM_DIR/.venv/bin/python" ] || die "未找到 $IPAM_DIR/.venv/bin/python，请先执行 ./install.sh 完成应用安装"
  if [ "$WITH_NGINX" = "1" ]; then
    command -v nginx >/dev/null 2>&1 || die "未找到 nginx，请先执行：sudo ./scripts/system-deps.sh --apply"
  fi
fi

TMP_UNIT="$(mktemp)"
TMP_SITE="$(mktemp)"
trap 'rm -f "$TMP_UNIT" "$TMP_SITE"' EXIT
render_unit > "$TMP_UNIT"
render_site > "$TMP_SITE"

unit_state="不存在（将创建）"
site_state="不存在（将创建）"
if [ -f "$UNIT" ]; then
  if cmp -s "$TMP_UNIT" "$UNIT"; then unit_state="已存在且内容一致（跳过写入）"; else unit_state="已存在但内容不同（将更新并重启服务）"; fi
fi
if [ "$WITH_NGINX" = "1" ] && [ -f "$SITE" ]; then
  if cmp -s "$TMP_SITE" "$SITE"; then site_state="已存在且内容一致（跳过写入）"; else site_state="已存在但内容不同（将更新并重载）"; fi
fi

say "系统配置预览（${OS_NAME}）"
printf '    %-24s %s\n' "项目目录" "$IPAM_DIR"
printf '    %-24s %s\n' "服务用户 / 组" "${SVC_USER} / ${SVC_GROUP}"
printf '    %-24s %s\n' "服务名" "$SERVICE_NAME"
printf '    %-24s %s\n' "后端端口 / 绑定" "${PORT} / ${BIND_HOST}"
printf '    %-24s %s\n' "nginx 对外端口" "$([ "$WITH_NGINX" = "1" ] && printf '%s' "$HTTP_PORT" || printf '不配置')"
printf '    %-24s %s\n' "IPAM_DEMO_SEED" "$SEED"
printf '    %-24s %s\n' "systemd unit" "$unit_state"
[ "$WITH_NGINX" = "1" ] && printf '    %-24s %s\n' "nginx 站点" "$site_state"
printf '    %-24s %s\n' "当前服务状态" "$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || printf 'inactive')"

if [ "$MODE" = "check" ]; then
  printf '\n检查完成，未修改任何文件。\n'
  printf '确认无误后执行： sudo ./scripts/system-config.sh --apply\n'
  exit 0
fi

# ------------------------------------------------------------ sudo 准备
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "当前不是 root 且系统没有 sudo，请用 root 执行"
  SUDO="sudo"
  if ! sudo -n true 2>/dev/null; then
    printf '\n    === 接下来需要管理员权限，请在提示处输入 sudo 密码 ===\n'
    printf '    （密码只用于本次认证，不会被写入任何文件）\n\n'
    sudo -v || die "sudo 认证失败。请改用 root 执行，或先手动运行一次 sudo -v"
  fi
fi

# ------------------------------------------------------------ 移除模式
if [ "$MODE" = "remove" ]; then
  say "移除系统服务配置（保留代码与数据库）"
  $SUDO systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  $SUDO rm -f "$UNIT" "$SITE" "$LINK"
  $SUDO systemctl daemon-reload
  if [ "$WITH_NGINX" = "1" ] && command -v nginx >/dev/null 2>&1; then
    $SUDO nginx -t >/dev/null 2>&1 && $SUDO systemctl reload nginx >/dev/null 2>&1 || true
  fi
  ok "已移除 $UNIT / $SITE / $LINK"
  printf '    代码与数据未动：$IPAM_DIR\n'
  printf '    如需恢复默认 nginx 站点：sudo ln -s /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default && sudo systemctl reload nginx\n'
  exit 0
fi

# ------------------------------------------------------------ 应用配置
UNIT_CHANGED=0
SITE_CHANGED=0

say "[1/4] 写入 systemd unit"
if [ -f "$UNIT" ] && cmp -s "$TMP_UNIT" "$UNIT"; then
  ok "内容一致，跳过写入"
else
  $SUDO cp "$TMP_UNIT" "$UNIT"
  $SUDO chmod 644 "$UNIT"
  UNIT_CHANGED=1
  ok "已写入 $UNIT"
fi

if [ "$WITH_NGINX" = "1" ]; then
  say "[2/4] 写入 nginx 站点并处理默认站点冲突"
  $SUDO mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
  if [ -f "$SITE" ] && cmp -s "$TMP_SITE" "$SITE"; then
    ok "内容一致，跳过写入"
  else
    $SUDO cp "$TMP_SITE" "$SITE"
    SITE_CHANGED=1
    ok "已写入 $SITE"
  fi
  $SUDO chmod 644 "$SITE"
  $SUDO ln -sfn "$SITE" "$LINK"
  # 两个 default_server 会让 nginx -t 失败；只在默认站点确实声明了 default_server 时移除软链
  if [ -e "$DEFAULT_LINK" ] && grep -qs 'default_server' "$DEFAULT_LINK"; then
    $SUDO rm -f "$DEFAULT_LINK"
    ok "已移除冲突的 sites-enabled/default（源文件保留在 sites-available/）"
  fi
  $SUDO nginx -t || die "nginx 配置校验失败，请检查 $SITE"
  ok "nginx -t 通过"
else
  say "[2/4] 跳过 nginx（IPAM_WITH_NGINX=0）"
fi

say "[3/4] 启动并设置开机自启"
if [ "$UNIT_CHANGED" -eq 1 ]; then $SUDO systemctl daemon-reload; fi
$SUDO systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
if [ "$UNIT_CHANGED" -eq 1 ]; then
  $SUDO systemctl restart "$SERVICE_NAME"
else
  $SUDO systemctl enable --now "$SERVICE_NAME" >/dev/null 2>&1 || $SUDO systemctl start "$SERVICE_NAME"
fi
if [ "$WITH_NGINX" = "1" ]; then
  $SUDO systemctl enable nginx >/dev/null 2>&1 || true
  if [ "$SITE_CHANGED" -eq 1 ]; then
    $SUDO systemctl restart nginx
  else
    $SUDO systemctl reload nginx >/dev/null 2>&1 || $SUDO systemctl restart nginx
  fi
fi
sleep 2
ACTIVE="$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)"
[ "$ACTIVE" = "active" ] || die "服务未处于 active（当前：${ACTIVE}）。排查：sudo journalctl -u $SERVICE_NAME -n 50 --no-pager"
ok "$SERVICE_NAME active=$(systemctl is-active "$SERVICE_NAME") enabled=$(systemctl is-enabled "$SERVICE_NAME" 2>/dev/null || true)"
if [ "$WITH_NGINX" = "1" ]; then ok "nginx active=$(systemctl is-active nginx) enabled=$(systemctl is-enabled nginx 2>/dev/null || true)"; fi

say "[4/4] 本机 HTTP 验收"
printf '    %-42s %s\n' "http://127.0.0.1:${PORT}/api/health" "$(curl -s -m 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/health" || printf 'FAIL')"
printf '    %-42s %s\n' "http://127.0.0.1:${PORT}/" "$(curl -s -m 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/" || printf 'FAIL')"
if [ "$WITH_NGINX" = "1" ]; then
  printf '    %-42s %s\n' "http://127.0.0.1:${HTTP_PORT}/" "$(curl -s -m 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HTTP_PORT}/" || printf 'FAIL')"
fi

SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$SERVER_IP" ] || SERVER_IP="服务器IP"
printf '\n==============================================================\n'
printf ' 系统配置完成，IPAM 已常驻运行\n'
printf '   访问地址  : http://%s/\n' "$SERVER_IP"
if [ "$WITH_NGINX" = "1" ]; then printf '   nginx 端口: %s → 后端 %s\n' "$HTTP_PORT" "$PORT"; fi
printf '   后端直连  : http://%s:%s/\n' "$SERVER_IP" "$PORT"
printf '   首次登录  : admin / Admin@123（请立即修改密码）\n'
printf '   数据模式  : IPAM_DEMO_SEED=%s（%s）\n' "$SEED" "$([ "$SEED" = "0" ] && printf '纯净' || printf '演示')"
printf '   运维命令  : sudo systemctl status|restart|stop %s\n' "$SERVICE_NAME"
printf '               sudo journalctl -u %s -f\n' "$SERVICE_NAME"
printf '==============================================================\n'
