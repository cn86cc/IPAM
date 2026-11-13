#!/usr/bin/env bash
# =============================================================================
# IPAM · 系统依赖检测与自动安装（第 1 层脚本）
# -----------------------------------------------------------------------------
# 用法： ./scripts/system-deps.sh [选项]
#   --check    只检查并打印缺失项，不安装、不修改任何文件（推荐先跑一次）
#   --apply    自动安装缺失的依赖（默认；需要 sudo 权限，密码由你本人输入）
#   --render   只打印「将要执行」的安装命令，不执行（排障 / 审阅用）
#   --help     显示帮助
#
# 环境变量：
#   IPAM_NEED_NGINX=0|1   是否需要 nginx（默认 1；只跑本机单端口可设 0）
#   IPAM_ASSUME_YES        apt/dnf 是否加 -y（默认加）
#   PIP_INDEX_URL          仅影响后续 Python 依赖，不影响本脚本
#
# 检测项：python3 >= 3.10、venv + 内置 pip 可真实创建、git、curl、nginx。
# 兼容：bash 3.2+ / Ubuntu Debian / RHEL CentOS Rocky Fedora / macOS(brew)
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="apply"

say()    { printf '\n==> %s\n' "$*"; }
ok()     { printf '    [OK] %s\n' "$*"; }
warn()   { printf '    [!] %s\n' "$*"; }
die()    { printf '\n[错误] %s\n' "$*" >&2; exit 1; }
has_cmd(){ command -v "$1" >/dev/null 2>&1; }

usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; }

for arg in "$@"; do
  case "$arg" in
    --check)  MODE="check" ;;
    --apply)  MODE="apply" ;;
    --render) MODE="render" ;;
    -h|--help) usage; exit 0 ;;
    *) printf '未知参数：%s（用 --help 查看用法）\n' "$arg" >&2; exit 2 ;;
  esac
done

# ------------------------------------------------------------ 1. 识别包管理器
OS_NAME="$(uname -s)"
PKG=""
case "$OS_NAME" in
  Darwin)
    has_cmd brew || die "macOS 缺少 Homebrew，请先安装：/bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    PKG="brew"
    ;;
  Linux)
    # IPAM_OS_RELEASE 仅用于离线排障 / 自动化测试，生产环境读系统自带文件
    OS_RELEASE_FILE="${IPAM_OS_RELEASE:-/etc/os-release}"
    [ -r "$OS_RELEASE_FILE" ] || die "无法读取 $OS_RELEASE_FILE，无法识别 Linux 发行版"
    # shellcheck disable=SC1090
    . "$OS_RELEASE_FILE"
    DISTRO="${ID:-unknown}"
    case "$DISTRO" in
      ubuntu|debian|linuxmint|raspbian|pop) PKG="apt" ;;
      rhel|centos|rocky|almalinux|fedora|ol|amzn)
        if has_cmd dnf; then PKG="dnf"; elif has_cmd yum; then PKG="yum"; else die "未找到 dnf / yum"; fi
        ;;
      *) die "暂未适配的发行版：${DISTRO}。请参考 README 手动安装：python3(>=3.10) python3-venv python3-pip git curl nginx" ;;
    esac
    ;;
  *) die "仅支持 macOS / Linux，当前系统：${OS_NAME}（Windows 请用 WSL2）" ;;
esac

# ------------------------------------------------------------ 2. 逐项检测
# 关键：不能只看 `python3 -m venv --help`！Ubuntu 最小化镜像里该命令会返回 0，
# 但真正创建时因缺 ensurepip 而失败。这里必须做一次「真实创建 + pip 探测」。
python_ok() {
  has_cmd python3 || return 1
  python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1
}

venv_pip_ok() {
  python_ok || return 1
  local tmp
  tmp="$(mktemp -d 2>/dev/null)" || return 1
  if python3 -m venv "$tmp/probe" >/dev/null 2>&1 \
     && [ -x "$tmp/probe/bin/python" ] \
     && "$tmp/probe/bin/python" -m pip --version >/dev/null 2>&1; then
    rm -rf "$tmp"
    return 0
  fi
  rm -rf "$tmp"
  return 1
}

state_python="缺失或版本过低"
state_venv="不可用"
state_git="缺失"
state_curl="缺失"
state_nginx="缺失"
python_ok   && state_python="$(python3 -V 2>&1 | awk '{print $2}')"
venv_pip_ok && state_venv="可真实创建（含 pip）"
has_cmd git && state_git="$(git --version 2>&1 | awk '{print $3}')"
has_cmd curl && state_curl="$(curl --version 2>&1 | head -1 | awk '{print $2}')"
has_cmd nginx && state_nginx="$(nginx -v 2>&1 | sed 's#nginx version: ##')"

# nginx 只在 Linux 服务器部署时需要；macOS 本机开发默认不需要
if [ -n "${IPAM_NEED_NGINX:-}" ]; then
  NEED_NGINX="$IPAM_NEED_NGINX"
elif [ "$OS_NAME" = "Linux" ]; then
  NEED_NGINX=1
else
  NEED_NGINX=0
fi

# 只把真正缺的东西加进安装清单；包名按发行版映射
PKGS=""
add_pkg() { PKGS="$PKGS $1"; }

if ! python_ok || ! venv_pip_ok; then
  case "$PKG" in
    apt)      add_pkg python3; add_pkg python3-venv; add_pkg python3-pip ;;
    dnf|yum)  add_pkg python3; add_pkg python3-pip ;;
    brew)     add_pkg python@3.12 ;;
  esac
fi
if ! has_cmd git; then
  case "$PKG" in brew) add_pkg git ;; *) add_pkg git ;; esac
fi
if ! has_cmd curl; then
  case "$PKG" in brew) add_pkg curl ;; *) add_pkg curl ;; esac
fi
if [ "$NEED_NGINX" = "1" ] && ! has_cmd nginx; then
  add_pkg nginx
fi
PKGS="$(printf '%s' "$PKGS" | sed 's/^ *//')"

install_cmd_1="无（依赖已齐备）"
install_cmd_2=""
if [ -n "$PKGS" ]; then
  case "$PKG" in
    apt)
      install_cmd_1="apt-get update -qq"
      install_cmd_2="env DEBIAN_FRONTEND=noninteractive apt-get install -y $PKGS"
      ;;
    dnf|yum) install_cmd_2="$PKG install -y $PKGS" ;;
    brew)    install_cmd_2="brew install $PKGS" ;;
  esac
fi

# ------------------------------------------------------------ 3. 输出状态
say "系统依赖检测（${OS_NAME} / 包管理器：${PKG}）"
printf '    %-22s %s\n' "python3 (>=3.10)" "$state_python"
printf '    %-22s %s\n' "venv + 内置 pip" "$state_venv"
printf '    %-22s %s\n' "git" "$state_git"
printf '    %-22s %s\n' "curl" "$state_curl"
printf '    %-22s %s\n' "nginx (需要=$NEED_NGINX)" "$state_nginx"
if [ -n "$PKGS" ]; then
  warn "缺失，需安装：$PKGS"
else
  ok "全部依赖齐备，无需安装"
fi

if [ "$MODE" = "render" ]; then
  printf '\n--- 将要执行的命令（未执行）---\n'
  if [ -n "$PKGS" ]; then
    [ "$install_cmd_1" = "无（依赖已齐备）" ] || printf '    sudo %s\n' "$install_cmd_1"
    if [ "$PKG" = "brew" ]; then printf '    %s\n' "$install_cmd_2"; else printf '    sudo %s\n' "$install_cmd_2"; fi
  else
    printf '    （无）\n'
  fi
  exit 0
fi

if [ "$MODE" = "check" ]; then
  printf '\n检查完成，未安装、未修改任何文件。\n'
  printf '确认无误后执行： sudo ./scripts/system-deps.sh --apply\n'
  exit 0
fi

# ------------------------------------------------------------ 4. 安装
if [ -z "$PKGS" ]; then
  ok "跳过安装（幂等：已装过的包不会重复安装）"
  exit 0
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  has_cmd sudo || die "当前不是 root 且系统没有 sudo，请用 root 用户执行本脚本"
  SUDO="sudo"
  if ! sudo -n true 2>/dev/null; then
    printf '\n    === 接下来需要管理员权限，请在提示处输入 sudo 密码 ===\n'
    printf '    （密码只用于本次认证，不会被写入任何文件）\n\n'
    sudo -v || die "sudo 认证失败。请改用 root 执行，或先手动运行一次 sudo -v"
  fi
fi

say "安装缺失依赖：$PKGS"
case "$PKG" in
  apt)
    if [ "$install_cmd_1" != "无（依赖已齐备）" ]; then
      $SUDO apt-get update -qq || die "apt-get update 失败（检查网络或 apt 源）"
    fi
    # shellcheck disable=SC2086
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y $PKGS \
      || die "apt-get install 失败，可先手动执行：sudo apt-get update && sudo apt-get install -y $PKGS"
    ;;
  dnf|yum)
    # shellcheck disable=SC2086
    $SUDO "$PKG" install -y $PKGS || die "$PKG install 失败"
    ;;
  brew)
    # shellcheck disable=SC2086
    brew install $PKGS || die "brew install 失败"
    ;;
esac

# ------------------------------------------------------------ 5. 复验
say "安装后复验"
python_ok   || die "python3 仍不可用或低于 3.10"
venv_pip_ok || die "venv 仍无法真实创建或缺少内置 pip。Ubuntu/Debian 请手动执行：sudo apt install -y python3.12-venv"
has_cmd git || die "git 仍不可用"
has_cmd curl || die "curl 仍不可用"
if [ "$NEED_NGINX" = "1" ]; then has_cmd nginx || die "nginx 仍不可用"; fi
ok "python3 $(python3 -V 2>&1 | awk '{print $2}') / venv+pip 可真实创建"
ok "git $(git --version 2>&1 | awk '{print $3}') / curl $(curl --version 2>&1 | head -1 | awk '{print $2}')"
if has_cmd nginx; then ok "nginx $(nginx -v 2>&1 | sed 's#nginx version: ##')"; fi
printf '\n系统依赖就绪。下一步： ./install.sh --deploy（或先跑 --check）\n'
