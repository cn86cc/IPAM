# IPAM · IPv4 地址管理平台

一套 IPv4 地址管理（IPAM）系统：前端 React + TypeScript，后端 FastAPI，数据存 SQLite，**不需要安装数据库服务**。

本文档面向**第一次接触这个项目、甚至第一次用 Linux 的人**。只要按第 3 节复制命令，在一台全新装好的 Ubuntu 服务器上就能从零装到浏览器能打开页面。第 4、5、6 节解释每一步到底装了什么、为什么装，出问题先看第 10 节。

> 首次登录：`admin` / `Admin@123`（公开仓库里写着，**登录后请立刻修改密码**）
>
> 只想快速看 Linux 拉取命令？看精简版 [linux-get-ipam.md](linux-get-ipam.md)。

---

## 目录

1. [简介](#1-简介)
2. [开始之前](#2-开始之前)
3. [一键安装](#3-一键安装)
4. [依赖环境完整说明](#4-依赖环境完整说明)
5. [手动分步安装](#5-手动分步安装)
6. [系统配置详解](#6-系统配置详解)
7. [启动命令速查](#7-启动命令速查)
8. [配置说明](#8-配置说明)
9. [验收清单](#9-验收清单)
10. [常见排错](#10-常见排错)
11. [目录结构](#11-目录结构)
12. [安全提醒](#12-安全提醒)

---

## 1. 简介

### 主要功能

| 模块 | 能做什么 |
| --- | --- |
| 工作台 | 地址利用率看板、容量阈值告警、全局模糊搜索 |
| 地址管理 | 地址空间树（可编辑）、RFC1918 三段私有根、VRF 地址平面真隔离、子网等分划分、IP 自动分配 / 手动指定 / 回收、子网 IP 使用位图 |
| 设备管理 | 位置 → 机柜 → 设备 → 链路 → 设备角色，含机柜 U 位视图 |
| 工单管理 | 分配申请、审批工单 |
| 治理与对账 | 发现记录、对账差异、审计日志、维护快照 |
| 分析与集成 | 报表、自定义页面、集成来源与 Webhook |
| 访问控制 | 本地账号 / LDAP / SSO(OIDC)、角色与模块授权、CIDR 可见范围（RBAC） |

### 技术架构

```text
浏览器
  │  http://服务器IP/          ← nginx :80（一键部署时自动配置）
  │  http://服务器IP:8000/     ← 也可直连后端
  ▼
FastAPI / Uvicorn  ──  backend/*.py（鉴权、VRF 上下文、RBAC、审计）
  │
  ▼
SQLite  ipam.db（WAL 模式，启动时自动建表 / 幂等迁移）
```

前端静态页由后端直接托管，所以**前后端只需一个端口 8000**；nginx 只是把它映射到 80，方便用 `http://服务器IP/` 访问。仓库自带 `frontend/dist/`，**不用装 Node.js 也能跑**。

### 两种数据模式

| 模式 | 环境变量 | 全新库内容 | 适用 |
| --- | --- | --- | --- |
| 纯净 / 生产 | `IPAM_DEMO_SEED=0` | 三段 RFC1918 根 + 内置配置 + 仅 admin，业务表全空 | 服务器部署、正式使用（**一键部署默认**） |
| 演示 | `IPAM_DEMO_SEED=1` | 17 个前缀、2104 个 IP、设备 / 工单 / 对账样例、admin + viewer | 本机体验功能（本机安装默认） |

`VRF 地址平面`是全局概念：顶栏切换器决定当前平面，地址类数据按 `(vrf, cidr)` / `(vrf, addr)` 隔离；「全部 VRF」是只读汇总视图，写操作会被后端拒绝。

---

## 2. 开始之前

| 你需要 | 说明 |
| --- | --- |
| 一台 Linux 服务器 | Ubuntu 22.04 / 24.04 或 Debian / Rocky / CentOS 均可；**全新刚装好的系统完全没问题**，脚本会把缺的东西装齐 |
| 一个能 `sudo` 的普通用户 | 例如 `sysop`。脚本会提示你输入 sudo 密码，密码**不会写入任何文件** |
| 能访问互联网 | 需要访问 `github.com`（拉代码）和 PyPI（装 Python 包）。内网可配镜像，见 [8. 配置说明](#8-配置说明) |
| 一个终端 | 服务器本机终端，或从你的电脑 SSH 上去：`ssh 用户名@服务器IP` |
| 两个端口空闲 | `80`（nginx）和 `8000`（后端）。被占用了看 [10. 常见排错](#10-常见排错) |

> macOS 用户：一键部署脚本只用于 Linux 服务器；本机开发请直接看 [7. 启动命令速查](#7-启动命令速查) 里的「本机安装」。

---

## 3. 一键安装

### 3.1 这一条命令做了什么

```text
bootstrap.sh（引导）
  ├─ 1. 装最小引导工具 git / curl（纯净系统往往连 git 都没有）
  ├─ 2. git clone 到 /opt/ipam
  └─ 3. 调用 install.sh --deploy
          ├─ 3.1 scripts/system-deps.sh    装 python3-venv / pip / nginx 等系统依赖
          ├─ 3.2 应用安装                  建 .venv → 装 16 个 Python 包 → 复用前端 dist
          │                              → 初始化 SQLite → 纯净库硬验收 → 19 项回归测试
          └─ 3.3 scripts/system-config.sh 写 systemd unit + nginx 站点
                                        → 处理默认站点冲突 → 开机自启 → HTTP 验收
```

完成后服务就**已经在后台运行**，不需要你再敲启动命令。

### 3.2 复制这两行

在服务器上打开终端，依次执行：

```bash
curl -fsSL -o /tmp/ipam-bootstrap.sh https://raw.githubusercontent.com/cn86cc/IPAM/main/bootstrap.sh
bash /tmp/ipam-bootstrap.sh
```

- 第一行：把引导脚本下载到 `/tmp`。**不执行**，只是下载。
- 第二行：执行它。过程中会有一到两次 `sudo` 密码提示，输入你自己的 sudo 密码即可（输入时屏幕不显示字符，这是正常的）。

> 也可以一行搞定：`curl -fsSL https://raw.githubusercontent.com/cn86cc/IPAM/main/bootstrap.sh | bash`。但**推荐两行写法**，因为从管道执行时个别环境的 sudo 密码提示不好交互。

如果你不想从网上下载脚本、想先看清楚内容，用传统方式同样是一键：

```bash
sudo apt update && sudo apt install -y git curl
git clone https://github.com/cn86cc/IPAM.git /opt/ipam
cd /opt/ipam && ./install.sh --deploy
```

### 3.3 你会看到什么（关键片段）

```
==> IPAM 一键安装引导（ubuntu / 包管理器 apt）
==> 安装最小引导工具：git curl
    [OK] 引导工具就绪
==> 从 GitHub 拉取代码到 /opt/ipam
    [OK] 代码就绪：5dbf6fb Summary
==> 开始完整部署（系统依赖 → 应用安装 → 系统配置 → 启动验收）

==> [部署 1/3] 检查并安装系统依赖
    [OK] python3 3.12.3 / venv+pip 可真实创建
    [OK] git 2.43.0 / curl 8.5.0
    [OK] nginx nginx/1.24.0 (Ubuntu)

==> [1/6] 检查 Python 虚拟环境
    [OK] 已创建 .venv
==> [2/6] 检查 Python 依赖
    [OK] 依赖安装完成
==> [5/6] 初始化 / 迁移数据库并验收
    users=1  prefixes=3  ip_addresses=0  业务表合计=0  integrity=ok
    [OK] 纯净库验收通过（三段根 / 仅 admin / 业务表全空）
Ran 19 tests in 4.360s / OK

==> [部署 3/3] 配置 systemd + nginx 并启动
    [OK] ipam active=active enabled=enabled
    [OK] nginx active=active enabled=enabled
==============================================================
 系统配置完成，IPAM 已常驻运行
   访问地址  : http://服务器IP/
   首次登录  : admin / Admin@123（请立即修改密码）
==============================================================
```

只要最后出现「系统配置完成」和 `active=active`，就是装好了。

### 3.4 打开页面

浏览器访问 `http://服务器IP/`（把「服务器IP」换成你机器的实际地址，例如 `192.168.1.50`），用 `admin` / `Admin@123` 登录。也可访问 `http://服务器IP:8000/` 直连后端，API 文档在 `http://服务器IP/docs`。

### 3.5 可选参数

所有参数都是「环境变量 + 命令」，放在命令前面即可：

```bash
# 换代码目录（默认 /opt/ipam）
IPAM_DIR=/srv/ipam bash /tmp/ipam-bootstrap.sh

# 不装 nginx，只让后端跑在 8000
IPAM_WITH_NGINX=0 IPAM_NEED_NGINX=0 bash /tmp/ipam-bootstrap.sh

# 换端口
IPAM_PORT=8080 IPAM_HTTP_PORT=8081 bash /tmp/ipam-bootstrap.sh

# 带演示数据体验（生产别这么用）
IPAM_DEMO_SEED=1 bash /tmp/ipam-bootstrap.sh

# 只想先看会做什么，不装任何东西（在已 clone 的目录里）
cd /opt/ipam && ./install.sh --check
```

---

## 4. 依赖环境完整说明

这一节把**每一个依赖**讲清楚：它是干什么的、缺了会报什么错、怎么装、装完怎么验证。绝大多数情况你不需要手动执行这些命令 —— 第 3 节的一键脚本会自动做完，这里供理解和排障。

### 4.1 依赖总表

| 类别 | 依赖 | 是否必须 | 谁负责安装 |
| --- | --- | --- | --- |
| 引导工具 | `git`、`curl`、`ca-certificates` | 必须 | `bootstrap.sh` |
| Python 运行时 | `python3` ≥ 3.10 | 必须 | `scripts/system-deps.sh` |
| Python 工具链 | `python3-venv`、`python3-pip` / `ensurepip` | 必须 | `scripts/system-deps.sh` |
| Web 服务 | `nginx` | 服务器部署必须 | `scripts/system-deps.sh` |
| Python 包 | `fastapi`、`uvicorn`、`ldap3` 及 13 个传递依赖 | 必须 | `install.sh`（pip，装进 `.venv`） |
| 前端 | `frontend/dist/`（仓库自带） | 必须 | 仓库已提交，无需安装 |
| Node.js / npm | 仅当你要改前端源码时 | **不需要** | 改前端才需 Node 18+ |
| 数据库 | SQLite | 必须 | Python 内置 `sqlite3` 模块，**无需安装数据库服务** |
| 编译工具 | `gcc` / `make` / `build-essential` | 本项目不需要 | Ubuntu 装 `python3-pip` 时会作为依赖顺带装上 |

### 4.2 逐项说明

#### ① git —— 拉取代码

- **作用**：把 GitHub 上的项目复制到服务器。
- **缺失报错**：`bash: git: command not found`、`git clone: command not found`。
- **安装**：Ubuntu/Debian `sudo apt install -y git`；RHEL 系 `sudo dnf install -y git`；macOS `brew install git`。
- **验证**：`git --version` → `git version 2.43.0`。

#### ② curl —— 下载引导脚本、安装后做 HTTP 验收

- **作用**：下载 `bootstrap.sh`；部署结束时探测 `/api/health` 是否 200。
- **缺失报错**：`curl: command not found`，或一键命令第一行就失败。
- **安装**：`sudo apt install -y curl ca-certificates`（RHEL：`sudo dnf install -y curl ca-certificates`）。
- **验证**：`curl --version | head -1`。

#### ③ python3（≥ 3.10）—— 后端运行时

- **作用**：跑 FastAPI / Uvicorn / 数据库初始化 / 回归测试。
- **缺失报错**：`未找到 python3`；版本过低报 `Python 版本过低（3.9.x）`。
- **安装**：Ubuntu/Debian `sudo apt install -y python3`；RHEL `sudo dnf install -y python3`；macOS `brew install python@3.12`。
- **验证**：`python3 -V` → `Python 3.12.3`。

#### ④ python3-venv + pip —— **最容易踩的坑**

- **作用**：创建项目专属的 `.venv` 虚拟环境，把 16 个 Python 包装进去，不污染系统 Python；`.venv` 里必须自带 pip 才能装包。
- **缺失报错**（本次实录真实报错）：
  ```text
  The virtual environment was not created successfully because ensurepip is not
  available.  On Debian/Ubuntu systems, you need to install the python3-venv
  package using the following command.
      apt install python3.12-venv
  ```
- **坑点**：`python3 -m venv --help` **会返回成功**，即使 `ensurepip` 缺失。只看这个命令会误判「环境没问题」，等真正建 `.venv` 时才失败。本项目的 `system-deps.sh` 因此会**真的创建一次临时虚拟环境并探测内置 pip**，不看 `--help`。
- **安装**：
  ```bash
  # Ubuntu / Debian（关键就是 python3-venv）
  sudo apt update && sudo apt install -y python3-venv python3-pip

  # RHEL / Rocky / CentOS / Fedora（venv 已包含在 python3 里）
  sudo dnf install -y python3 python3-pip
  ```
- **验证**（真实创建，别用 --help）：
  ```bash
  tmp=$(mktemp -d) && python3 -m venv "$tmp/v" && "$tmp/v/bin/python" -m pip --version && rm -rf "$tmp"
  ```
  看到 `pip 24.0 ...` 才算好。
- **顺带效果**：Ubuntu 上装 `python3-pip` 会带出 `python3-dev` / `build-essential` / `gcc` / `make`，所以全新系统里缺的编译工具也一并补齐了。

#### ⑤ nginx —— 80 端口反向代理

- **作用**：让 `http://服务器IP/`（不带端口号）就能访问；传递 `X-Forwarded-Proto` 等请求头。
- **缺失报错**：`nginx: command not found`；`nginx -t` 失败；访问 80 端口连接被拒。
- **安装**：Ubuntu/Debian `sudo apt install -y nginx`；RHEL `sudo dnf install -y nginx`；macOS `brew install nginx`。
- **验证**：`nginx -v` → `nginx version: nginx/1.24.0 (Ubuntu)`。
- **注意**：apt 装完 nginx 会**自动启动并启用默认站点**，其中也声明了 `default_server`。一键脚本会自动移除 `sites-enabled/default` 软链，避免两个 `default_server` 冲突（源文件仍保留）。

#### ⑥ Python 依赖包（装进 `.venv`）

- **清单**：`backend/requirements.txt` 声明 `fastapi>=0.115,<1`、`uvicorn>=0.30,<1`、`ldap3>=2.9,<3`；实际会装 16 个包（含 starlette、pydantic、anyio、h11、click、pyasn1 等传递依赖）。
- **谁装**：`install.sh` 第 2 步用 `.venv/bin/python -m pip install -r backend/requirements.txt`。已装齐且版本达标时**跳过**，不会重复下载。
- **验证**：`.venv/bin/python -m pip list`（应看到 fastapi / uvicorn / ldap3）。
- **下载慢**：设镜像 `PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple ./install.sh`。

#### ⑦ 前端 `frontend/dist/` —— 不用装 Node.js

后端 `backend/app.py` 直接托管这个目录。**它已经随仓库提交**，所以 clone 下来就有，不需要 Node.js、不需要 `npm install`、不需要构建。只有当你修改了 `frontend/src/` 里的源码，才需要 Node.js 18+ 并执行 `./install.sh --rebuild`。

#### ⑧ SQLite —— 不用装数据库服务

Python 标准库自带 `sqlite3`。`ipam.db` 会在项目目录自动创建，WAL 模式会额外产生 `ipam.db-wal` / `ipam.db-shm`。`sqlite3` 命令行工具不是必须的，脚本用 Python 读写。

### 4.3 手动安装依赖的完整命令（Ubuntu 24.04 实录）

如果你想自己装全部系统依赖，等价于一键脚本的是：

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip git curl nginx
```

这次实录中，一台全新 Ubuntu 24.04.3 上该命令会装出：

| 包 | 版本 |
| --- | --- |
| python3 | 3.12.3-0ubuntu2.1 |
| python3-venv / python3.12-venv | 3.12.3-0ubuntu2.1 / 3.12.3-1ubuntu0.17 |
| python3-pip | 24.0+dfsg-1ubuntu1.3 |
| python3-dev / build-essential | 3.12.3-0ubuntu2.1 / 12.10ubuntu1 |
| nginx / nginx-common | 1.24.0-2ubuntu7.19 |
| git / curl | 2.43.0 / 8.5.0 |

共约 73 个包被配置、下载 87.5MB、占用约 274MB 磁盘。

RHEL / Rocky / CentOS / Fedora 等价命令：

```bash
sudo dnf install -y python3 python3-pip git curl nginx ca-certificates
```

macOS（Homebrew）等价命令：

```bash
brew install python@3.12 git curl
```

---

## 5. 手动分步安装

想理解每一步、或在某一步失败后单独重跑，可以手动调用三个脚本。**每一步都是幂等的**：已装好的会跳过，重复执行不会重复安装、不会覆盖数据。

### 第 1 步：取得代码

```bash
sudo apt update && sudo apt install -y git curl
git clone https://github.com/cn86cc/IPAM.git /opt/ipam
cd /opt/ipam
chmod +x install.sh bootstrap.sh scripts/*.sh
```

已有旧副本时更新：`cd /opt/ipam && git pull --ff-only`。

### 第 2 步：只检查（不装任何东西）

```bash
./install.sh --check                       # 应用层状态
./scripts/system-deps.sh --check           # 系统依赖缺哪些，会给安装命令
./scripts/system-config.sh --render        # 打印将要写入的 systemd / nginx 配置
```

### 第 3 步：装系统依赖

```bash
sudo ./scripts/system-deps.sh --apply
```

它只装真正缺的包。也可以先 `--render` 看会执行什么命令，再 `--apply`。

### 第 4 步：装应用（虚拟环境 / Python 包 / 前端 / 数据库 / 测试）

```bash
IPAM_DEMO_SEED=0 ./install.sh --test
```

预期看到 `users=1 prefixes=3 ip_addresses=0 业务表合计=0 integrity=ok` 和 `Ran 19 tests ... OK`。

### 第 5 步：配置系统服务并启动

```bash
sudo ./scripts/system-config.sh --apply
```

它会写 systemd unit 与 nginx 站点、处理默认站点冲突、`nginx -t`、`enable --now`、开机自启，最后做本机 HTTP 验收并打印访问地址。

> 卸载配置（不动代码和数据）：`sudo ./scripts/system-config.sh --remove`。

---

## 6. 系统配置详解

一键部署会写入下面两份配置。你不需要手写，但排障时可以对照。

### 6.1 `/etc/systemd/system/ipam.service`

```ini
[Unit]
Description=IPAM IPv4 Address Management
After=network.target

[Service]
Type=simple
User=sysop
Group=sysop
WorkingDirectory=/opt/ipam
Environment=PYTHONUNBUFFERED=1
Environment=IPAM_DEMO_SEED=0
ExecStart=/opt/ipam/.venv/bin/python -m uvicorn backend.app:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips=127.0.0.1
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

| 字段 | 为什么这样设 |
| --- | --- |
| `User` / `Group` | 取 `SUDO_USER`（你执行脚本时的普通用户），**不硬编码**成某个人名，也不建议用 root。可用 `IPAM_SERVICE_USER` 覆盖 |
| `WorkingDirectory` | 让后端能找到 `ipam.db`、`frontend/dist/`、`backend/` |
| `IPAM_DEMO_SEED=0` | **必须写进 unit**，否则服务重启时 `init_db()` 会以演示模式灌入示例数据 |
| `--host 0.0.0.0 --port 8000` | 允许 nginx 与局域网访问；只想本机访问可设 `IPAM_BIND_HOST=127.0.0.1` |
| `--proxy-headers --forwarded-allow-ips=127.0.0.1` | 让 uvicorn 信任 nginx 传来的 `X-Forwarded-Proto` / `X-Real-IP` |
| `Restart=always` | 崩溃自动拉起；配合 `enable` 实现开机自启 |

### 6.2 `/etc/nginx/sites-available/ipam`

```nginx
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

- 软链到 `/etc/nginx/sites-enabled/ipam`；
- 若 `sites-enabled/default` 也声明了 `default_server`，脚本会**移除该软链**（不删源文件），否则 `nginx -t` 报 `duplicate default server`；
- `X-Forwarded-Proto` 是未来上 HTTPS 时后端识别协议的关键；
- `client_max_body_size 16m` 放过较大的导入请求。

### 6.3 目录、权限与端口

| 项 | 值 |
| --- | --- |
| 代码目录 | `/opt/ipam`（可用 `IPAM_DIR` 改），属主为执行用户 |
| 虚拟环境 | `/opt/ipam/.venv` |
| 数据库 | `/opt/ipam/ipam.db`（含密码哈希，**不要上传 / 外发**） |
| 监听 | nginx `0.0.0.0:80`、uvicorn `0.0.0.0:8000` |
| 开机自启 | `systemctl enable ipam`、`systemctl enable nginx` |
| 防火墙 | Ubuntu 默认 `ufw inactive`；若你的环境启用了防火墙，需放行 80 / 8000 |

### 6.4 运维命令

```bash
sudo systemctl status ipam                  # 看状态
sudo systemctl restart ipam                 # 改了配置 / 拉了新代码后重启
sudo systemctl stop ipam                    # 停服务
sudo journalctl -u ipam -f                  # 实时日志
sudo nginx -t && sudo systemctl reload nginx

# 备份 / 回滚（先停服务，避免 WAL 未落盘）
sudo systemctl stop ipam
cp /opt/ipam/ipam.db /opt/ipam/backups/ipam.db.$(date +%Y%m%d-%H%M%S)
# 回滚：cp 备份文件 /opt/ipam/ipam.db && sudo systemctl start ipam

# 升级代码
cd /opt/ipam && git pull --ff-only && sudo systemctl restart ipam
```

---

## 7. 启动命令速查

| 目的 | 命令 | 访问地址 |
| --- | --- | --- |
| 纯净 Linux 一键部署 | `bash /tmp/ipam-bootstrap.sh` | `http://服务器IP/` |
| 已 clone 后一键部署 | `./install.sh --deploy` | `http://服务器IP/` |
| 只看状态不改动 | `./install.sh --check` | — |
| 本机安装（不启动） | `./install.sh` | — |
| 本机单端口启动 | `./install.sh --start` | `http://127.0.0.1:8000` |
| 本机允许局域网访问 | `IPAM_HOST=0.0.0.0 ./install.sh --start` | `http://本机IP:8000` |
| 换端口 | `IPAM_PORT=8001 ./install.sh --start` | `http://127.0.0.1:8001` |
| 开发热更新（需 Node 18+） | `./start.sh` | `http://127.0.0.1:5173` |
| 前端改动后重建 | `./install.sh --rebuild` | — |
| 运行回归测试 | `./install.sh --test` | — |
| 纯净模式安装 | `IPAM_DEMO_SEED=0 ./install.sh` | — |
| 单独重装系统依赖 | `sudo ./scripts/system-deps.sh --apply` | — |
| 单独重配系统服务 | `sudo ./scripts/system-config.sh --apply` | — |
| 移除系统服务配置 | `sudo ./scripts/system-config.sh --remove` | — |
| 直接手写启动后端 | `.venv/bin/python -m uvicorn backend.app:app --host 0.0.0.0 --port 8000` | `http://127.0.0.1:8000` |

---

## 8. 配置说明

### 环境变量总表

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `IPAM_DEMO_SEED` | 本机 `1` / `--deploy` `0` | `0` 纯净生产库；`1` 带演示数据。**生产必须是 0** |
| `IPAM_DIR` | 当前项目目录 | 部署目录；`bootstrap.sh` 默认 `/opt/ipam` |
| `IPAM_REPO` / `IPAM_BRANCH` | GitHub 仓库 / `main` | 引导脚本从哪拉代码 |
| `IPAM_HOST` | `127.0.0.1` | `--start` 的监听地址 |
| `IPAM_PORT` | `8000` | 后端端口；`--deploy` 时也用于 systemd / nginx |
| `IPAM_HTTP_PORT` | `80` | nginx 对外端口 |
| `IPAM_BIND_HOST` | `0.0.0.0` | systemd unit 里 uvicorn 的绑定地址 |
| `IPAM_SERVICE_USER` | `SUDO_USER` 或当前用户 | systemd 服务运行用户 |
| `IPAM_SERVICE_NAME` | `ipam` | 服务名 / nginx 站点名 |
| `IPAM_WITH_NGINX` | `1` | 设 `0` 则 `--deploy` 不配 nginx，只配 systemd |
| `IPAM_NEED_NGINX` | Linux `1` / macOS `0` | 是否检查并安装 nginx |
| `IPAM_SKIP_TESTS` | `0` | 设 `1` 让 `--deploy` 跳过回归测试 |
| `PIP_INDEX_URL` | 系统默认 | pip 镜像，如 `https://pypi.tuna.tsinghua.edu.cn/simple` |
| `npm_config_registry` | 系统默认 | npm 镜像，如 `https://registry.npmmirror.com` |

### 系统内配置（登录后在界面里改，不用改代码）

- **系统设置**：利用率告警阈值、预留 TTL、默认 VRF、网关偏移；阈值可按 VRF 单独设置。
- **VRF 地址平面**：新增 / 编辑 / 删除平面、跨平面地址复用报告、删除时迁移数据。
- **用户与权限**：本地用户、角色、模块可见性、CIDR 可见范围（`vrf:CIDR`）。
- **认证源**：本地、LDAP/AD、SSO(OIDC)。
- **集成来源 / Webhook / 自定义页面**：对账数据源、事件推送、页面文案。

### HTTPS（可选）

在 nginx 上做 443 的 TLS 终止并反代到 8000，同时把 8000 收敛到 `127.0.0.1` 或用防火墙挡掉外部访问，再让 nginx 传 `X-Forwarded-Proto`（现有配置已传）。前端 API 全是相对路径 `/api`，**应用代码基本不用改**。全站 HTTPS 后再给登录 Cookie 加 `secure=True`。纯内网 IP（如 RFC1918 私网段）无法申请公网 CA 证书，需内网域名 + 私有 CA，或自签证书（SAN 必须含该 IP）。

---

## 9. 验收清单

装完照这张表检查，全部满足即部署成功：

| # | 检查项 | 命令 / 期望 |
| --- | --- | --- |
| 1 | 服务状态 | `systemctl is-active ipam` → `active`；`is-enabled` → `enabled` |
| 2 | nginx 状态 | `systemctl is-active nginx` → `active` |
| 3 | 端口 | `ss -lntp \| grep -E ':(80\|8000) '` 两行 |
| 4 | 双入口 | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/` 与 `:8000/` → `200` |
| 5 | 静态资源 | `/assets/index-*.js`、`/assets/index-*.css` → `200` |
| 6 | 健康检查 | `/api/health` → `200` |
| 7 | 登录 | POST `/api/auth/login` 用 admin/默认口令 → `200` |
| 8 | API 文档 | `/docs` → `200` |
| 9 | VRF 隔离 | 带 `X-IPAM-VRF: default/vrf-lab/vrf-prod` 请求 `/api/spaces` 各 1 条根；`all` 为 3 条 |
| 10 | 汇总写保护 | `X-IPAM-VRF: all` 下 POST `/api/subnets` → `400` |
| 11 | 纯净库 | `users=1`、`prefixes=3`、`ip_addresses=0`、业务表合计 `0` |
| 12 | 重启不回灌 | `sudo systemctl restart ipam` 后再查第 11 项，仍为 0 |
| 13 | 回归测试 | `./install.sh --test` → `Ran 19 tests ... OK` |
| 14 | 日志 | `sudo journalctl -u ipam -n 400 \| grep -Ei 'error\|traceback'` → 无输出 |
| 15 | 完整性 | Python 查 `PRAGMA integrity_check` → `ok` |

---

## 10. 常见排错

### 依赖类

| 现象 | 原因 / 解决 |
| --- | --- |
| `git: command not found` | 纯净系统没装 git。`sudo apt install -y git curl`，或直接跑 `bootstrap.sh`（它会自动装） |
| `curl: command not found` | 同上，`sudo apt install -y curl ca-certificates` |
| **`python3 -m venv` 报 `ensurepip is not available`** | 缺 `python3-venv`。`sudo apt install -y python3-venv python3-pip`。**别用 `venv --help` 判断**，那会假阳性；用 4.2 ④ 的真实创建命令验证 |
| `No module named pip` / `pip3: command not found` | 缺 `python3-pip`。同上 |
| `Python 版本过低` | 需 3.10+。`python3 -V` 确认；Ubuntu 22.04+ / 24.04 默认满足 |
| `nginx: command not found` | `sudo apt install -y nginx`；或 `sudo ./scripts/system-deps.sh --apply` |
| apt / dnf 下载慢或失败 | 检查网络与软件源；`sudo apt update` 后重试。PyPI 慢设 `PIP_INDEX_URL` 镜像 |
| pip 安装失败 | 设镜像后重跑：`PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple ./install.sh` |
| `npm ci` 报 lock 不一致 | 只在 `--rebuild` 时发生；脚本会自动回退 `npm install`，仍失败可删 `frontend/node_modules` 后重跑 |
| 提示「缺少 Node.js」 | 说明 `frontend/dist` 没了或用了 `--rebuild`。装 Node 20 LTS，或重新 clone 恢复 dist |

### 系统配置类

| 现象 | 原因 / 解决 |
| --- | --- |
| `nginx: [emerg] a duplicate default server` | 默认站点与新站点都声明 `default_server`。一键脚本会自动处理；手动执行：`sudo rm /etc/nginx/sites-enabled/default && sudo nginx -t && sudo systemctl reload nginx` |
| 访问 80 端口出现 nginx 欢迎页 | 默认站点没被移除，或软链没生效。检查 `ls -l /etc/nginx/sites-enabled/` |
| `502 Bad Gateway` | 后端没起来。`sudo systemctl status ipam`、`sudo journalctl -u ipam -n 50`；确认 `ss -lntp \| grep 8000` |
| 页面 404 / 白屏 | `frontend/dist` 缺失或过期：`./install.sh --rebuild`；生产模式请访问 8000 或 80，不是 5173 |
| `端口 8000 已被占用` | 换端口 `IPAM_PORT=8080 ./install.sh --deploy`；或 `lsof -i :8000` 找出旧进程 |
| 局域网访问不到 | 需 `--host 0.0.0.0`（一键部署已是），并放行防火墙 / 安全组 80 与 8000 |
| `sudo: a terminal is required` | 从管道执行时 tty 不可用。改用第 3 节推荐的两行写法（先下载再 `bash` 执行） |
| `Permission denied: ./install.sh` | `chmod +x install.sh bootstrap.sh scripts/*.sh` |
| 服务用户变成 root | 直接以 root 运行导致。用普通用户执行（脚本内部自动 sudo），或显式 `IPAM_SERVICE_USER=sysop` |

### 数据与运行类

| 现象 | 原因 / 解决 |
| --- | --- |
| 重启后演示数据又冒出来 | `IPAM_DEMO_SEED` 没设 0。确认 unit 里有 `Environment=IPAM_DEMO_SEED=0`：`systemctl cat ipam` |
| 纯净模式全新库仍有 17 个前缀 / 2104 个 IP | 用了旧版代码。执行 `cd /opt/ipam && git pull --ff-only && sudo systemctl restart ipam`（新版已把种子纳入模式判断） |
| `custom_pages` 表为空 | 正常，页面文案由代码内置默认值兜底，`/api/pages/vrf` 仍返回 200 |
| `database is locked` | 同一目录启动了多个服务进程，停掉重复的 |
| 改了前端代码但页面没变化 | 生产模式读 dist，必须 `./install.sh --rebuild` |
| 登录失败 / 忘记密码 | 默认 `admin / Admin@123`；若改过且忘记，只能从备份恢复或删 `ipam.db` 重建（**会丢数据，先备份**） |
| `git status: M start.sh` | 手动 `chmod +x start.sh` 改了文件模式；`chmod 644 start.sh` 即可，systemd 不依赖它 |
| 一键脚本提示 `/opt/ipam 已存在且非空但不是 git 仓库` | 为防覆盖而拒绝。换 `IPAM_DIR=/opt/ipam2`，或自行确认后清理该目录 |

### 网络探测类（非错误）

- `curl https://files.pythonhosted.org/` 返回 `404`：CDN 根路径本就没有页面，只要 pip 能下载包即可。
- `curl https://pypi.org/simple/` 超时：那是全量索引根页（几十 MB），探测请改用具体包 `https://pypi.org/simple/fastapi/`。
- 首次 SSH 出现 `Warning: Permanently added ... to the list of known hosts`：首次信任主机密钥，正常。

还有问题先跑 `./install.sh --check`、`./scripts/system-deps.sh --check`、`./scripts/system-config.sh --check`，再跑 `./install.sh --test` 看 19 项回归是否通过。

---

## 11. 目录结构

```text
IPAM/
├── bootstrap.sh                # 纯净 Linux 一键引导（装 git → clone → --deploy）
├── install.sh                  # 安装主入口（本机安装 / --deploy 服务器一键部署）
├── scripts/
│   ├── system-deps.sh          # 系统依赖检测与自动安装（venv 真实探测）
│   └── system-config.sh        # systemd + nginx 配置（render/check/apply/remove）
├── start.sh                    # 开发模式（API 8000 + Vite 5173）
├── README.md                   # 本指南
├── linux-get-ipam.md           # 精简版：Linux 拉取与启动命令
├── .gitignore                  # GitHub 提交过滤规则
├── index.html                  # 早期静态产品原型页（仅供参考，不是系统入口）
├── backend/                    # FastAPI 后端
│   ├── requirements.txt        # Python 依赖（fastapi / uvicorn / ldap3）
│   ├── app.py                  # 路由、鉴权中间件、静态托管
│   ├── db.py                   # SQLite 建表 / 迁移 / VRF 上下文 / 纯净模式种子
│   ├── auth.py                 # 账号、RBAC、LDAP/SSO、会话
│   ├── extended.py / assets.py / domain.py / ...
├── frontend/
│   ├── src/                    # 页面源码（改这里才需要 Node.js）
│   ├── dist/                   # 构建产物（后端直接托管，随仓库提交）
│   └── package.json / package-lock.json
├── tests/
│   ├── test_vrf_isolation.py       # VRF 隔离回归（14 项）
│   ├── test_clean_install.py       # 纯净安装回归（5 项）
│   └── test_deploy_scripts.py      # 部署脚本自检
├── ipam.db                     # 运行后自动生成，已忽略，不提交
└── backups/                    # 本地备份，已忽略，不提交
```

---

## 12. 安全提醒

- 默认密码 `Admin@123` 写在公开仓库里，**首次登录后立刻修改**（访问控制 → 用户与权限）。
- `ipam.db` 内含密码哈希与会话 token，不要上传 GitHub、不要放进公开网盘；`.gitignore` 已排除它和 `backups/`。
- 默认部署是 HTTP 明文，且 8000 端口对外可直连。正式使用前建议：改密码 → 配 HTTPS → 把 8000 收敛到 `127.0.0.1` 或用防火墙拦截。
- 以 root 直接运行 `--deploy` 会让服务以 root 常驻，不推荐；用普通用户执行，脚本内部会自动 sudo。
