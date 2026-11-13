#!/usr/bin/env bash
# =============================================================================
# IPAM · IPv4 地址管理平台 —— 一键部署脚本（macOS / Linux）
# -----------------------------------------------------------------------------
# 用法： ./install.sh [选项]
#   （无参数） 检测环境 -> 复用/创建虚拟环境 -> 只补装缺失依赖 -> 构建前端 -> 初始化数据库
#   --start    完成上述步骤后，前台启动单端口服务（Ctrl+C 停止）
#   --rebuild  强制重新构建前端（修改了 frontend/src 之后使用）
#   --test     额外运行回归测试（tests/，基于标准库 unittest，无需额外依赖）
#   --check    只检查环境与各组件状态，不安装、不修改任何文件
#   --help     显示帮助
#
# 环境变量：
#   IPAM_DEMO_SEED=0        纯净/生产模式：不灌演示业务数据（默认 1，会灌演示数据）
#   IPAM_HOST / IPAM_PORT   --start 的监听地址/端口（默认 127.0.0.1 / 8000）
#   PIP_INDEX_URL            Python 镜像，例如 https://pypi.tuna.tsinghua.edu.cn/simple
#   npm_config_registry      npm 镜像，例如 https://registry.npmmirror.com
#
# 兼容：Python 3.10+ / bash 3.2+（macOS 自带 bash） / Ubuntu、Debian、CentOS、macOS
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
VENV="$ROOT/.venv"
PY="$VENV/bin/python"
DIST="$ROOT/frontend/dist"

START=0
REBUILD=0
RUN_TEST=0
CHECK_ONLY=0

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --start)   START=1 ;;
    --rebuild) REBUILD=1 ;;
    --test)    RUN_TEST=1 ;;
    --check)   CHECK_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf '未知参数：%s（用 --help 查看用法）\n' "$arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '    [OK] %s\n' "$*"; }
warn() { printf '    [!] %s\n' "$*"; }
die()  { printf '\n[错误] %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 0. 环境检测
OS_NAME="$(uname -s)"
case "$OS_NAME" in
  Darwin|Linux) ;;
  *) die "仅支持 macOS / Linux，当前系统：${OS_NAME}（Windows 请用 WSL2）" ;;
esac

check_python() {
  command -v python3 >/dev/null 2>&1 || die "未找到 python3。macOS: brew install python@3.12；Ubuntu: sudo apt install -y python3 python3-venv"
  python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' \
    || die "Python 版本过低（$(python3 -V 2>&1)），本项目要求 3.10+，推荐 3.11 / 3.12"
  ok "Python $(python3 -V 2>&1 | awk '{print $2}')（满足 3.10+）"
}

# 后端直接托管 frontend/dist；只有需要构建前端时才强制要求 Node.js
NEED_NODE=0
if [[ ! -f "$DIST/index.html" || "$REBUILD" -eq 1 ]]; then NEED_NODE=1; fi

check_node() {
  if [[ "$NEED_NODE" -eq 0 ]]; then
    ok "已有前端构建产物 frontend/dist，本次无需 Node.js"
    return 0
  fi
  command -v node >/dev/null 2>&1 || die "缺少 Node.js。macOS: brew install node；Ubuntu: sudo apt install -y nodejs npm（需 18+）"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [[ "$major" -ge 18 ]] || die "Node.js 版本过低（v${major}），Vite 6 要求 18+，推荐 20 / 22 LTS"
  command -v npm >/dev/null 2>&1 || die "缺少 npm（通常随 Node.js 一起安装）"
  ok "Node.js $(node -v) / npm $(npm -v)（满足 18+）"
}

# 检查 Python 依赖是否齐备且版本达标：只在缺失/过低时才调用 pip
py_deps_ok() {
  "$PY" - <<'PYCODE' >/dev/null 2>&1
import re
import sys
from importlib import metadata

need = {"fastapi": (0, 115, 0), "uvicorn": (0, 30, 0), "ldap3": (2, 9, 0)}
bad = []
for name, minimum in need.items():
    try:
        raw = metadata.version(name)
    except metadata.PackageNotFoundError:
        bad.append(name + "(未安装)")
        continue
    nums = [int(x) for x in re.findall(r"\d+", raw)[:3]]
    nums += [0] * (3 - len(nums))
    if tuple(nums) < minimum:
        bad.append("%s %s < %s" % (name, raw, ".".join(map(str, minimum))))
if bad:
    print("; ".join(bad), file=sys.stderr)
    sys.exit(1)
PYCODE
}

show_status() {
  printf '\n--- 组件状态 ---\n'
  [[ -x "$PY" ]] && printf '  虚拟环境 .venv        : 已存在\n' || printf '  虚拟环境 .venv        : 不存在（将创建）\n'
  if [[ -x "$PY" ]] && py_deps_ok; then
    printf '  Python 依赖           : 齐备（跳过安装）\n'
  else
    printf '  Python 依赖           : 缺失或版本过低（将安装）\n'
  fi
  [[ -d "$ROOT/frontend/node_modules" ]] \
    && printf '  frontend/node_modules : 已存在\n' \
    || printf '  frontend/node_modules : 不存在（需要时安装）\n'
  [[ -f "$DIST/index.html" ]] \
    && printf '  frontend/dist         : 已构建（跳过构建）\n' \
    || printf '  frontend/dist         : 未构建（将执行 npm run build）\n'
  [[ -f "$ROOT/ipam.db" ]] \
    && printf '  数据库 ipam.db        : 已存在（执行幂等迁移，不覆盖数据）\n' \
    || printf '  数据库 ipam.db        : 不存在（将自动创建）\n'
  printf '  IPAM_DEMO_SEED        : %s（0 = 纯净模式）\n' "${IPAM_DEMO_SEED:-1}"
  printf '\n检查完成，未修改任何文件。\n'
}

say "环境检测（系统：${OS_NAME}）"
check_python
check_node
ok "项目目录：$ROOT"

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  show_status
  exit 0
fi

if [[ "${IPAM_DEMO_SEED:-1}" != "0" ]]; then
  warn "当前 IPAM_DEMO_SEED=1：首次初始化会写入演示业务数据（设备/工单/对账样例）。"
  warn "如需纯净空库，请先按 Ctrl+C 中断，改用： IPAM_DEMO_SEED=0 ./install.sh"
fi

# ---------------------------------------------------------------- 1. 虚拟环境
say "[1/6] 检查 Python 虚拟环境"
if [[ -x "$PY" ]]; then
  ok "复用已有 .venv，跳过创建"
else
  if [[ -d "$VENV" ]]; then
    die ".venv 已存在但 $PY 不可执行，可能是残留的损坏环境；请先手动移除 .venv 后重跑"
  fi
  python3 -m venv "$VENV" \
    || die "创建虚拟环境失败。Ubuntu/Debian 请先执行：sudo apt install -y python3-venv"
  ok "已创建 .venv"
fi
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' \
  || die ".venv 内的 Python 低于 3.10，请移除 .venv 后重跑"

# ---------------------------------------------------------------- 2. Python 依赖
say "[2/6] 检查 Python 依赖"
if py_deps_ok; then
  ok "fastapi / uvicorn / ldap3 已齐备，跳过 pip install"
else
  printf '    正在安装 backend/requirements.txt ...\n'
  "$PY" -m pip install --disable-pip-version-check -r "$ROOT/backend/requirements.txt" \
    || die "pip 安装失败。可设置镜像后重试：PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple ./install.sh"
  py_deps_ok || die "安装后依赖校验仍未通过，请查看上方 pip 报错"
  ok "依赖安装完成"
fi

# ---------------------------------------------------------------- 3. 前端依赖
say "[3/6] 检查前端依赖"
if [[ "$NEED_NODE" -eq 0 ]]; then
  ok "已有 dist，跳过 node_modules 检查"
else
  missing=0
  for pkg in react react-dom vite typescript @vitejs/plugin-react; do
    [[ -d "$ROOT/frontend/node_modules/$pkg" ]] || missing=1
  done
  if [[ "$missing" -eq 0 ]]; then
    ok "复用已有 frontend/node_modules，跳过 npm install"
  else
    printf '    正在安装前端依赖 ...\n'
    if [[ -f "$ROOT/frontend/package-lock.json" ]]; then
      (cd "$ROOT/frontend" && npm ci --no-audit --no-fund) || {
        warn "npm ci 失败（lock 与 package.json 可能不同步），回退 npm install"
        (cd "$ROOT/frontend" && npm install --no-audit --no-fund)
      }
    else
      (cd "$ROOT/frontend" && npm install --no-audit --no-fund)
    fi
    ok "前端依赖安装完成"
  fi
fi

# ---------------------------------------------------------------- 4. 前端构建
say "[4/6] 检查前端构建产物"
if [[ -f "$DIST/index.html" && "$REBUILD" -eq 0 ]]; then
  ok "复用已有 frontend/dist（改了前端代码请用 ./install.sh --rebuild）"
else
  printf '    正在构建（tsc --noEmit && vite build）...\n'
  (cd "$ROOT/frontend" && npm run build) || die "前端构建失败，请查看上方 TypeScript / Vite 报错"
  [[ -f "$DIST/index.html" ]] || die "构建结束但未生成 frontend/dist/index.html"
  ok "已生成 frontend/dist"
fi

# ---------------------------------------------------------------- 5. 数据库
say "[5/6] 初始化 / 迁移数据库"
"$PY" -c 'from backend import db; db.init_db(); print("    [OK] 数据库就绪：" + str(db.DB_PATH))' \
  || die "数据库初始化失败（检查磁盘权限与 backend/ 目录是否完整）"

# ---------------------------------------------------------------- 6. 自检与测试
say "[6/6] 自检"
"$PY" -c 'import backend.app' || die "后端模块导入失败，请查看上方报错"
ok "后端可正常导入"

if [[ "$RUN_TEST" -eq 1 ]]; then
  say "运行回归测试"
  "$PY" -m unittest discover -s tests -v || die "回归测试未通过"
  ok "回归测试通过"
fi

# ---------------------------------------------------------------- 启动 / 收尾
if [[ "$START" -eq 1 ]]; then
  HOST="${IPAM_HOST:-127.0.0.1}"
  PORT="${IPAM_PORT:-8000}"
  "$PY" -c 'import socket,sys; h,p=sys.argv[1],int(sys.argv[2]); s=socket.socket(); s.settimeout(0.5); sys.exit(0 if s.connect_ex((h,p))!=0 else 1)' "$HOST" "$PORT" \
    || die "端口 $HOST:$PORT 已被占用；可用 IPAM_PORT=8001 ./install.sh --start 换端口"
  SHOW_HOST="$HOST"
  if [[ "$HOST" == "0.0.0.0" ]]; then SHOW_HOST="127.0.0.1"; fi
  say "启动服务： http://$SHOW_HOST:$PORT/"
  printf '    默认管理员：admin / Admin@123（登录后请立即修改密码）\n'
  printf '    API 文档  ：http://%s:%s/docs\n' "$SHOW_HOST" "$PORT"
  printf '    按 Ctrl+C 停止服务\n\n'
  exec "$PY" -m uvicorn backend.app:app --host "$HOST" --port "$PORT"
fi

printf '\n==============================================================\n'
printf ' 部署完成！接下来任选一种方式启动：\n'
printf '   生产/单端口（推荐）: ./install.sh --start        -> http://127.0.0.1:8000\n'
printf '   开发/热更新        : ./start.sh                 -> http://127.0.0.1:5173\n'
printf '   允许局域网访问     : IPAM_HOST=0.0.0.0 ./install.sh --start\n'
printf '   换端口             : IPAM_PORT=8001 ./install.sh --start\n'
printf '   运行测试           : ./install.sh --test\n'
printf '   默认管理员         : admin / Admin@123\n'
printf '==============================================================\n'
