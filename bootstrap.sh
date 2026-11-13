#!/usr/bin/env bash
# =============================================================================
# IPAM · 纯净 Linux 服务器「一键安装」引导脚本
# -----------------------------------------------------------------------------
# 这是整条命令的起点：连 git 都没装的新机器也能用。
# 它会：装最小引导工具 -> 拉取代码 -> 调用 install.sh --deploy 完成余下全部工作。
#
# 用法（推荐，两行，sudo 密码可正常交互）：
#   curl -fsSL -o /tmp/ipam-bootstrap.sh https://raw.githubusercontent.com/cn86cc/IPAM/main/bootstrap.sh
#   bash /tmp/ipam-bootstrap.sh
#
# 也可以一行（sudo 会从终端读密码）：
#   curl -fsSL https://raw.githubusercontent.com/cn86cc/IPAM/main/bootstrap.sh | bash
#
# 如果已经在项目目录里，直接： ./bootstrap.sh
#
# 环境变量（可选）：
#   IPAM_DIR        代码安装目录（默认 /opt/ipam）
#   IPAM_REPO       Git 仓库地址（默认 https://github.com/cn86cc/IPAM.git）
#   IPAM_BRANCH     分支（默认 main）
#   IPAM_DEMO_SEED  数据模式（默认 0，纯净生产库）
#   IPAM_PORT       后端端口（默认 8000）
#   IPAM_HTTP_PORT  nginx 端口（默认 80）
#
# 兼容：bash 3.2+ / Ubuntu Debian / RHEL CentOS Rocky Fedora
# =============================================================================
set -euo pipefail

say()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '    [OK] %s\n' "$*"; }
warn() { printf '    [!] %s\n' "$*"; }
die()  { printf '\n[错误] %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf '未知参数：%s（本脚本通常不需要参数）\n' "$arg" >&2; exit 2 ;;
  esac
done

REPO="${IPAM_REPO:-https://github.com/cn86cc/IPAM.git}"
BRANCH="${IPAM_BRANCH:-main}"
SEED="${IPAM_DEMO_SEED:-0}"
PORT="${IPAM_PORT:-8000}"
HTTP_PORT="${IPAM_HTTP_PORT:-80}"

# ------------------------------------------------------------ 1. 系统识别
OS_NAME="$(uname -s)"
[ "$OS_NAME" = "Linux" ] || die "本脚本用于 Linux 服务器；macOS 请在项目目录执行 ./install.sh --start"
[ -r /etc/os-release ] || die "无法读取 /etc/os-release"
# shellcheck disable=SC1091
. /etc/os-release
DISTRO="${ID:-unknown}"
case "$DISTRO" in
  ubuntu|debian|linuxmint|raspbian|pop) PKG="apt" ;;
  rhel|centos|rocky|almalinux|fedora|ol|amzn)
    if command -v dnf >/dev/null 2>&1; then PKG="dnf"; else PKG="yum"; fi ;;
  *) die "暂未适配的发行版：${DISTRO}（README 有手动安装说明）" ;;
esac

say "IPAM 一键安装引导（${DISTRO} / 包管理器 ${PKG}）"
if [ ! -t 0 ]; then
  warn "检测到脚本从管道读取：sudo 会在终端提示输入密码，若无法输入请改用两行写法（先 curl -o 下载，再 bash 执行）"
fi

# ------------------------------------------------------------ 2. sudo 准备
SUDO=""
RUN_USER="$(id -un)"
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "当前不是 root 且没有 sudo，请用 root 用户执行"
  SUDO="sudo"
  RUN_USER="${SUDO_USER:-$RUN_USER}"
  if ! sudo -n true 2>/dev/null; then
    printf '\n    === 接下来会安装系统依赖，请在提示处输入 sudo 密码 ===\n'
    printf '    （密码只用于本次认证，不会被写入任何文件）\n\n'
    sudo -v || die "sudo 认证失败。请用 root 执行，或先手动运行 sudo -v"
  fi
fi

# ------------------------------------------------------------ 3. 最小引导依赖
# 冷启动只需要 git（拉代码）和 curl（后续 HTTP 验收）；其余依赖交给 install.sh --deploy
BOOT_PKGS=""
command -v git  >/dev/null 2>&1 || BOOT_PKGS="$BOOT_PKGS git"
command -v curl >/dev/null 2>&1 || BOOT_PKGS="$BOOT_PKGS curl"
BOOT_PKGS="$(printf '%s' "$BOOT_PKGS" | sed 's/^ *//')"

if [ -n "$BOOT_PKGS" ]; then
  say "安装最小引导工具：$BOOT_PKGS"
  case "$PKG" in
    apt)
      $SUDO apt-get update -qq || die "apt-get update 失败（检查网络 / apt 源）"
      # shellcheck disable=SC2086
      $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y $BOOT_PKGS ca-certificates \
        || die "安装 $BOOT_PKGS 失败"
      ;;
    dnf|yum)
      # shellcheck disable=SC2086
      $SUDO "$PKG" install -y $BOOT_PKGS ca-certificates || die "安装 $BOOT_PKGS 失败"
      ;;
  esac
  ok "引导工具就绪"
else
  ok "git / curl 已存在，跳过安装"
fi

# ------------------------------------------------------------ 4. 取得代码
# 若已经在项目目录内运行，就直接用当前目录，避免重复 clone
if [ -f "./install.sh" ] && [ -f "./scripts/system-deps.sh" ]; then
  IPAM_DIR="$(pwd)"
  ok "检测到已在项目目录：$IPAM_DIR（跳过 clone）"
else
  IPAM_DIR="${IPAM_DIR:-/opt/ipam}"
fi

if [ -d "$IPAM_DIR/.git" ]; then
  say "代码已存在，更新到最新（git pull --ff-only）"
  git -C "$IPAM_DIR" pull --ff-only \
    || die "git pull 失败：目录里可能有本地改动。请到 $IPAM_DIR 执行 git status 检查后再试"
  ok "已是最新：$(git -C "$IPAM_DIR" log -1 --format='%h %s')"
elif [ -e "$IPAM_DIR" ] && [ -n "$(ls -A "$IPAM_DIR" 2>/dev/null)" ]; then
  die "$IPAM_DIR 已存在且非空、但不是 git 仓库。为安全起见不覆盖，请换一个 IPAM_DIR 或手动清理该目录"
else
  say "从 GitHub 拉取代码到 $IPAM_DIR"
  PARENT="$(dirname "$IPAM_DIR")"
  $SUDO mkdir -p "$PARENT" "$IPAM_DIR"
  $SUDO chown "$RUN_USER" "$IPAM_DIR"
  git clone --branch "$BRANCH" --depth 1 "$REPO" "$IPAM_DIR" \
    || die "git clone 失败（检查网络能否访问 github.com）"
  ok "代码就绪：$(git -C "$IPAM_DIR" log -1 --format='%h %s')"
fi

chmod +x "$IPAM_DIR/install.sh" "$IPAM_DIR/bootstrap.sh" "$IPAM_DIR"/scripts/*.sh 2>/dev/null || true

# ------------------------------------------------------------ 5. 交棒给一键部署
say "开始完整部署（系统依赖 → 应用安装 → 系统配置 → 启动验收）"
printf '    这一步会依次自动完成，期间可能再次提示 sudo 密码。\n'
cd "$IPAM_DIR"
IPAM_DEMO_SEED="$SEED" IPAM_PORT="$PORT" IPAM_HTTP_PORT="$HTTP_PORT" \
  ./install.sh --deploy
