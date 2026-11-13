# IPAM · IPv4 地址管理平台

一套可直接本机运行、也可部署到内网服务器的 IPv4 地址管理（IPAM）系统。前端 React + TypeScript，后端 FastAPI，数据存 SQLite，**无需安装数据库服务**，一条命令即可跑起来。

> 首次登录账号：`admin`　密码：`Admin@123`　（公开仓库里写着，登录后请立刻在「访问控制 → 用户与权限」中修改）
>
> 只想在 Linux 上拉取并跑起来？看精简版 [linux-get-ipam.md](linux-get-ipam.md)；本文是完整指南，包含服务器常驻部署与排错。

---

## 目录

1. [简介](#1-简介)
2. [环境要求](#2-环境要求)
3. [快速开始](#3-快速开始)
4. [启动命令速查](#4-启动命令速查)
5. [生产服务器部署](#5-生产服务器部署)
6. [配置说明](#6-配置说明)
7. [常见排错](#7-常见排错)
8. [目录结构](#8-目录结构)
9. [安全提醒](#9-安全提醒)

---

## 1. 简介

### 主要功能

| 模块 | 能做什么 |
| --- | --- |
| 工作台 | 地址利用率看板、容量阈值告警、全局模糊搜索 |
| 地址管理 | 地址空间树（可编辑）、RFC1918 三段私有根、`VRF 地址平面` 真隔离、子网等分划分、IP 自动分配 / 手动指定 / 回收、子网 IP 使用位图 |
| 设备管理 | 位置 → 机柜 → 设备 → 链路 → 设备角色，含机柜 U 位视图与拖拽排序 |
| 工单管理 | 分配申请、审批工单 |
| 治理与对账 | 发现记录、对账差异、审计日志、维护快照 |
| 分析与集成 | 报表、自定义页面、集成来源与 Webhook |
| 访问控制 | 本地账号 / LDAP / SSO(OIDC)、角色与模块授权、CIDR 可见范围（RBAC）、会话与登录页配置 |

### 技术架构

```text
浏览器
  │  开发态：http://127.0.0.1:5173（Vite 把 /api 代理到 8000）
  │  生产态：http://127.0.0.1:8000（后端同时托管 API 与前端静态页）
  │  服务器：http://服务器IP/（nginx:80 反代到 127.0.0.1:8000）
  ▼
FastAPI / Uvicorn  ──  backend/*.py（统一鉴权、VRF 上下文、RBAC、审计）
  │
  ▼
SQLite  ipam.db（WAL 模式，21 张表，启动时自动建表 / 幂等迁移）
```

`VRF 地址平面` 是全局概念：顶栏切换器决定当前平面，所有地址类数据按 `(vrf, cidr)` / `(vrf, addr)` 隔离；选择「全部 VRF」是只读汇总视图，写操作会被后端拒绝。不同平面可以复用相同的地址段，系统提供跨平面重叠报告与迁移删除。

### 两种数据模式

由环境变量 `IPAM_DEMO_SEED` 决定，**只在数据库首次创建时生效**：

| 模式 | 命令 | 全新库内容 |
| --- | --- | --- |
| 演示模式（默认 `1`） | `./install.sh` | 完整示例：17 个前缀、2104 个 IP、14 天利用率快照、设备 / 工单 / 对账样例，以及 `admin` 和 `viewer` 两个账号 |
| 纯净模式（`0`） | `IPAM_DEMO_SEED=0 ./install.sh` | 仅三段 RFC1918 根 + 内置配置 + `admin`，**所有业务表为空** |

生产部署请用纯净模式。安装脚本会在初始化后打印数据库状态，并对「全新库」自动验收：三段根、仅 admin、业务表全空、SQLite 完整性 ok。

> 根目录的 `index.html` 是最早的静态产品原型页，仅作参考，系统实际入口是 `frontend/` 构建出的页面。

---

## 2. 环境要求

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | macOS 12+ / Ubuntu 20.04+ / Debian / CentOS 等 Linux | Windows 请用 WSL2 |
| Python | **3.10 及以上**（推荐 3.11 / 3.12） | 需带 `venv` 模块；已在 Ubuntu 24.04.3 LTS / Python 3.12.3 实测通过 |
| Node.js | 18+（推荐 20 / 22 LTS） | **仅构建前端时需要**。仓库已带 `frontend/dist/`，不改前端代码可不装 |
| npm | 随 Node.js 一起安装 | 同上 |
| 服务器额外依赖 | `git`、`python3-venv`、`nginx`（可选） | Ubuntu 常缺 `python3-venv`；nginx 用于 80 端口反代 |
| 浏览器 | Chrome / Edge / Safari 新版 | 需启用 Cookie |
| 端口 | 8000（生产 / API）、5173（开发态前端）、80（nginx 反代时） | 均可自定义 |
| 网络 | 首次安装需访问 PyPI / npm | 内网可配镜像，见[配置说明](#6-配置说明) |

依赖清单：`backend/requirements.txt`（fastapi、uvicorn、ldap3）、`frontend/package.json`（React 19、Vite 6、TypeScript 5）。测试只用 Python 标准库 `unittest`，不额外装 pytest。

---

## 3. 快速开始

### 第 1 步：取得代码

公开仓库，匿名克隆即可，不需要账号或密码：

```bash
git clone https://github.com/cn86cc/IPAM.git
cd IPAM
```

也可以直接把项目文件夹复制到目标机器。更详细的 Linux 拉取方式见 [linux-get-ipam.md](linux-get-ipam.md)。

### 第 2 步：赋权并运行安装脚本

```bash
chmod +x install.sh start.sh
./install.sh
```

脚本按顺序做 6 件事，**每一步都先判断，已完成的自动跳过，不会重复安装**：

1. 检测系统、Python 版本（≥3.10）、必要时检测 Node/npm 版本（≥18）；
2. 检查 `.venv`：存在且可用就复用，不存在才创建；
3. 检查 `fastapi / uvicorn / ldap3` 是否已安装且版本达标，齐备就**跳过 pip install**；
4. 检查 `frontend/node_modules` 关键包与 `frontend/dist/index.html`，已存在就跳过安装与构建；
5. 初始化 / 幂等迁移 `ipam.db`，打印数据库状态；纯净模式对全新库做硬验收；
6. 自检后端模块能否导入（`--test` 时额外跑 19 项回归测试）。

> 只看状态、不改任何文件：`./install.sh --check`
> 修改了 `frontend/src`：`./install.sh --rebuild`

脚本默认灌入演示数据方便体验。**要干净的空库（生产部署）请改用**：

```bash
IPAM_DEMO_SEED=0 ./install.sh
```

纯净模式安装成功时你会看到：

```text
模式：纯净 / 生产（IPAM_DEMO_SEED=0）
users=1  prefixes=3  ip_addresses=0  业务表合计=0  integrity=ok
[OK] 纯净库验收通过（三段根 / 仅 admin / 业务表全空）
```

### 第 3 步：启动并访问

```bash
./install.sh --start
```

看到 `启动服务： http://127.0.0.1:8000/` 后，浏览器打开该地址，用 `admin / Admin@123` 登录。按 `Ctrl + C` 停止服务。

想用「前端热更新」的开发模式：

```bash
./start.sh          # 同时启动 8000(API) + 5173(Vite)，访问 http://127.0.0.1:5173
```

---

## 4. 启动命令速查

| 目的 | 命令 | 访问地址 |
| --- | --- | --- |
| 一键安装（不启动） | `./install.sh` | — |
| 纯净模式安装 | `IPAM_DEMO_SEED=0 ./install.sh` | — |
| 只检查环境 | `./install.sh --check` | — |
| 单端口生产模式（推荐） | `./install.sh --start` | http://127.0.0.1:8000 |
| 纯净模式启动 | `IPAM_DEMO_SEED=0 ./install.sh --start` | http://127.0.0.1:8000 |
| 允许局域网 / 服务器访问 | `IPAM_HOST=0.0.0.0 ./install.sh --start` | `http://服务器IP:8000` |
| 换端口 | `IPAM_PORT=8001 ./install.sh --start` | http://127.0.0.1:8001 |
| 前端改动后重建 | `./install.sh --rebuild` | — |
| 开发热更新 | `./start.sh` | http://127.0.0.1:5173 |
| 运行全部回归测试 | `./install.sh --test` | — |
| 直接启动后端（等价手写） | `.venv/bin/python -m uvicorn backend.app:app --host 0.0.0.0 --port 8000` | http://127.0.0.1:8000 |
| 单独构建前端 | `cd frontend && npm run build` | — |
| API 文档 | 服务启动后访问 | http://127.0.0.1:8000/docs |

---

## 5. 生产服务器部署

以下是在 **Ubuntu 24.04.3 LTS** 上从 GitHub 全新部署的完整流程（实测通过）。CentOS / Debian 只需把 `apt` 换成对应包管理器。

### 5.1 安装基础依赖

```bash
sudo apt update
sudo apt install -y git python3 python3-venv python3-pip nginx
python3 -V      # 确认 ≥ 3.10
```

说明：

- Ubuntu 预装 `python3`，但 **`venv` / `ensurepip` 可能缺失**，不装 `python3-venv` 会导致创建虚拟环境失败；
- **不需要 Node.js**：仓库已提交 `frontend/dist/`，后端直接托管它；
- `nginx` 只在需要 80 端口访问时安装，也可以用防火墙直接放行 8000；
- 不需要单独安装 SQLite 或数据库服务，Python 内置模块即可。

### 5.2 放置代码

以 `/opt/ipam` 为例（换成你有写权限的目录也可以）：

```bash
sudo mkdir -p /opt/ipam
sudo chown "$USER":"$USER" /opt/ipam
git clone https://github.com/cn86cc/IPAM.git /opt/ipam
cd /opt/ipam
chmod +x install.sh start.sh
```

> 用 systemd 常驻时，`/opt/ipam` 必须对 unit 里的 `User` 可写（数据库要落盘）。

### 5.3 一键安装并跑回归

```bash
IPAM_DEMO_SEED=0 ./install.sh --test
```

这一步会复用随仓库提交的 `frontend/dist`、自动创建 `.venv`、安装 Python 依赖、初始化纯净库并验收、最后跑 19 项回归测试。看到 `OK` 和「纯净库验收通过」即可继续。

### 5.4 配置 systemd 常驻

新建 `/etc/systemd/system/ipam.service`（把 `User` / `Group` 换成实际运行用户）：

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

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ipam
sudo systemctl status ipam
```

⚠️ **`Environment=IPAM_DEMO_SEED=0` 必须写进 unit**。服务每次启动都会执行 `init_db()`；缺少这一行时，环境变量回落为演示模式，清空过的库会被示例数据重新灌满。

### 5.5 配置 nginx 反代（80 → 8000）

新建 `/etc/nginx/sites-available/ipam`：

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

```bash
sudo rm -f /etc/nginx/sites-enabled/default   # 避免两个 default_server 冲突
sudo ln -sfn /etc/nginx/sites-available/ipam /etc/nginx/sites-enabled/ipam
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl restart nginx
```

`X-IPAM-VRF` 等自定义请求头默认会被 nginx 透传，VRF 地址平面切换在反代后仍可用；`X-Forwarded-Proto` 配合 uvicorn 的 `--proxy-headers` 让后端识别真实协议。

### 5.6 验收清单

| 检查项 | 命令 / 期望结果 |
| --- | --- |
| 健康检查 | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/api/health` → `200` |
| 80 与 8000 双入口、静态 JS/CSS、`/docs` | `curl -s -o /dev/null -w '%{http_code}' http://服务器IP/` → `200` |
| 登录 | `curl -s -c /tmp/ipam-cookie -X POST http://127.0.0.1/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"Admin@123"}'` → 200 + Cookie |
| VRF 视角 | `curl -s -b /tmp/ipam-cookie -H 'X-IPAM-VRF: all' http://127.0.0.1/api/spaces` → 3 个根；换成 `default` / `vrf-lab` / `vrf-prod` 各 1 个 |
| `all` 写保护 | 带 `X-IPAM-VRF: all` 的 POST → `400` |
| 空库状态 | 见下方 Python 片段：业务表合计 0、`prefixes=3`、`users=1` |
| 回归测试 | `./install.sh --test` → `Ran 19 tests ... OK` |
| 重启不回灌 | `sudo systemctl restart ipam` 后再查库，业务表仍为 0 |
| 服务日志 | `sudo journalctl -u ipam --no-pager -n 200` 无 `ERROR` / `Traceback` |

数据库检查：

```bash
cd /opt/ipam && .venv/bin/python - <<'PY'
import sqlite3
c = sqlite3.connect('ipam.db')
print('users     =', c.execute('select count(*) from users').fetchone()[0])
print('prefixes  =', list(c.execute('select vrf,cidr,kind from prefixes order by cidr')))
print('ip_addresses =', c.execute('select count(*) from ip_addresses').fetchone()[0])
print('integrity =', c.execute('pragma integrity_check').fetchone()[0])
PY
```

访问地址：`http://服务器IP/`（nginx）、`http://服务器IP:8000/`（后端直连）、`http://服务器IP/docs`（API 文档）。

> 验收时登录会写入会话与审计；正式交付前如需「零痕迹」空库，可执行 `DELETE FROM sessions; DELETE FROM audit_logs;` 并让 admin 的 `last_login_at` 归零。

### 5.7 纯净库保留什么

| 类别 | 内容 |
| --- | --- |
| 地址空间 | 三段 RFC1918 根：`default/10.0.0.0/8`、`vrf-lab/172.16.0.0/12`、`vrf-prod/192.168.0.0/16` |
| 账号 | 仅 `admin` |
| 内置配置 | 3 个 VRF、5 项系统设置、8 个设备角色、3 个认证源、6 个集成来源 |
| 业务数据 | 全空：IP、设备、机柜、链路、位置、工单、发现、对账、审计、会话、快照、Webhook |

自定义页面（如「VRF 地址平面」）的文案由 `extended.get_page()` 用代码内置默认值兜底，不依赖数据库种子；在界面里保存一次后才会写入 `custom_pages` 表。

### 5.8 备份、回滚与运维

```bash
# 备份（数据库含账号密码哈希，务必保管好）
cp /opt/ipam/ipam.db /opt/ipam/backups/ipam.db.$(date +%Y%m%d-%H%M%S)

# 回滚
sudo systemctl stop ipam
cp /opt/ipam/backups/ipam.db.<时间戳> /opt/ipam/ipam.db
sudo systemctl start ipam
```

| 操作 | 命令 |
| --- | --- |
| 查看 / 重启 / 停止服务 | `sudo systemctl status\|restart\|stop ipam` |
| 跟踪日志 | `sudo journalctl -u ipam -f` |
| 校验并重载 nginx | `sudo nginx -t && sudo systemctl reload nginx` |
| 更新代码 | `cd /opt/ipam && git pull --ff-only && sudo systemctl restart ipam` |
| 更新后跑回归 | `cd /opt/ipam && IPAM_DEMO_SEED=0 ./install.sh --test` |

> `git pull` 前注意：部署时若执行过 `chmod +x start.sh`，会显示 `M start.sh`（文件模式变化）。可执行 `chmod 644 start.sh` 恢复，避免本地改动挡住 pull；systemd 启动不依赖该文件。

---

## 6. 配置说明

### 环境变量（脚本 / 服务层）

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `IPAM_DEMO_SEED` | `1` | `0` = 纯净模式：全新库仅三段 RFC1918 根 + 内置配置 + admin，且重启不回灌演示数据；生产环境必须设为 `0`，并写进 systemd unit |
| `IPAM_HOST` | `127.0.0.1` | `--start` 的监听地址；服务器对外访问设 `0.0.0.0` |
| `IPAM_PORT` | `8000` | `--start` 的监听端口 |
| `PIP_INDEX_URL` | 系统默认 | 内网 pip 镜像，例：`https://pypi.tuna.tsinghua.edu.cn/simple` |
| `npm_config_registry` | 系统默认 | 内网 npm 镜像，例：`https://registry.npmmirror.com` |

用法示例：

```bash
IPAM_DEMO_SEED=0 IPAM_HOST=0.0.0.0 IPAM_PORT=8000 ./install.sh --start
```

### 系统内配置（登录后在界面里改，无需改代码）

- **系统设置**：利用率告警阈值、预留 TTL、默认 VRF、网关偏移；阈值可按 VRF 单独设置。
- **VRF 地址平面**：新增 / 编辑 / 删除平面、跨平面地址复用报告、删除时把数据迁移到目标平面。
- **用户与权限**：本地用户、角色、模块可见性、CIDR 可见范围（`vrf:CIDR` 形式）。
- **认证源**：本地、LDAP/AD、SSO(OIDC) 的开关与参数；`ldap3` 已随依赖安装，默认是演示配置。
- **集成来源 / Webhook / 自定义页面**：对账数据源、事件推送、VRF 页面文案等。

### 数据与端口

- 数据库固定为项目根目录的 `ipam.db`（SQLite，WAL 模式会额外产生 `ipam.db-wal` / `ipam.db-shm`）；`DB_PATH` 定义见 `backend/db.py`。
- 备份放在 `backups/`。这些文件**含账号密码哈希与业务数据，已在 `.gitignore` 中排除，切勿上传 GitHub**。
- CORS 白名单写在 `backend/app.py`（默认只允许 `127.0.0.1:5173` / `localhost:5173`）；只有用独立前端域名时才需要改代码。
- 想启用 HTTPS：在 nginx 上做 443 的 TLS 终止并反代到 8000，同时把 8000 收敛到 `127.0.0.1` 或用防火墙拦截，再让 nginx 传 `X-Forwarded-Proto`；uvicorn 参数加 `--proxy-headers --forwarded-allow-ips=127.0.0.1`（[5.4](#54-配置-systemd-常驻) 的 unit 已带）。应用代码基本不用改（前端 API 全部是相对路径 `/api`）。内网 IP 无法申请公网 CA 证书，通常用企业私有 CA 或自签证书（SAN 必须包含该 IP）。

---

## 7. 常见排错

| 现象 | 原因 / 解决 |
| --- | --- |
| `python3: command not found` | 没装 Python。macOS：`brew install python@3.12`；Ubuntu：`sudo apt install -y python3 python3-venv` |
| `Python 版本过低` | 需 3.10+。用 `python3 -V` 确认；macOS 自带版本较旧时请装 Homebrew 版并把它放在 PATH 前面 |
| `No module named venv` / `ensurepip is not available` / 创建虚拟环境失败 | Ubuntu / Debian 缺组件：`sudo apt install -y python3-venv python3-pip`，然后删除残留 `.venv` 重跑 |
| `.venv 已存在但 .venv/bin/python 不可执行` | 残留的损坏环境。删除 `.venv` 目录后重跑 `./install.sh`（该目录可重建，删除是安全的） |
| `缺少 Node.js` | 仅当 `frontend/dist` 缺失或用了 `--rebuild` 时才需要。装 Node 20 LTS，或改用随仓库提交的 dist |
| `npm ci` 报 lock 不一致 | 脚本会自动回退 `npm install`；仍失败可删除 `frontend/node_modules` 后重跑 |
| pip / npm 下载慢或超时 | 设镜像：`PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple npm_config_registry=https://registry.npmmirror.com ./install.sh`。注意直接 curl 探测 `https://pypi.org/simple/` 全量索引（数十 MB）超时是正常现象，pip 只请求具体包的小索引页 |
| `端口 8000 已被占用` | 换端口 `IPAM_PORT=8001 ./install.sh --start`；或 `sudo lsof -i :8000` 找出旧进程 |
| `nginx: [emerg] a duplicate default server for 0.0.0.0:80` | 新站点与自带默认站点都声明了 `default_server`。执行 `sudo rm -f /etc/nginx/sites-enabled/default` 后 `sudo nginx -t` |
| nginx 返回 502 / 504 | 反代本身没问题，是后端没起来：`sudo systemctl status ipam`、`sudo journalctl -u ipam -n 100` |
| 打开页面 404 / 白屏 | `frontend/dist` 没构建或已过期：`./install.sh --rebuild`；生产模式请访问 8000（或 nginx 的 80）而不是 5173 |
| 改了前端代码但页面没变化 | 生产模式读的是 dist，必须重建：`./install.sh --rebuild`；开发模式请用 `./start.sh` |
| 纯净模式安装后仍出现一大堆演示地址 / `viewer` 账号 | 使用了修复前的旧版本（该版本 `init_db()` 的地址种子不受 `IPAM_DEMO_SEED` 控制）。先 `git pull --ff-only` 升级，备份后删除 `ipam.db` 重新执行 `IPAM_DEMO_SEED=0 ./install.sh` |
| 服务重启后演示数据又冒出来 | systemd unit 缺 `Environment=IPAM_DEMO_SEED=0`；补上后 `sudo systemctl daemon-reload && sudo systemctl restart ipam`，再按 5.6 清一次库 |
| `install.sh` 报「纯净模式全新库验收失败」 | 说明库不是干净新建的（或代码版本旧）。检查 `ipam.db` 是否为旧文件、`git log -1` 是否为最新提交，必要时备份后删库重装 |
| `custom_pages` 表为空 / VRF 页面显示默认文案 | 正常。文案由代码内置默认值兜底，在界面保存一次后才会持久化 |
| `git status: M start.sh` | 部署时 `chmod +x` 改了文件模式。执行 `chmod 644 start.sh` 恢复（systemd 启动不依赖该文件） |
| 登录失败 / 忘记密码 | 默认 `admin / Admin@123`；若改过且忘记，只能从备份恢复，或删除 `ipam.db` 重建（**会丢失全部数据，务必先备份**） |
| `database is locked` | 同一目录启动了多个服务进程；停掉重复的，只保留一个 |
| 局域网访问不到 | 需要 `IPAM_HOST=0.0.0.0`，并放行服务器防火墙 / 云安全组的 8000（或 80）端口 |
| `Permission denied: ./install.sh` | 执行 `chmod +x install.sh start.sh` |
| SSO / LDAP 回调失败 | 检查回调地址与认证源配置；前后端域名变化后还要检查 `backend/app.py` 的 CORS 白名单 |

排查顺序建议：先 `./install.sh --check` 看各组件状态，再 `./install.sh --test` 确认 19 项回归测试是否通过，最后看 `sudo journalctl -u ipam -n 200` 的服务日志。

---

## 8. 目录结构

```text
IPAM/
├── .gitignore              # GitHub 提交过滤规则
├── README.md               # 本使用指南
├── linux-get-ipam.md       # Linux 拉取 / 运行的精简版速查
├── install.sh              # 一键部署脚本（macOS / Linux，含纯净库验收）
├── start.sh                # 开发模式启动（API 8000 + Vite 5173）
├── index.html              # 早期静态产品原型页（仅供参考）
├── backend/                # FastAPI 后端
│   ├── requirements.txt    # Python 依赖
│   ├── app.py              # 路由、鉴权中间件、静态托管
│   ├── db.py               # SQLite 建表 / 迁移 / 种子（含纯净模式三段根）/ VRF 上下文 / 阈值
│   ├── domain.py           # 地址分配与回收领域逻辑
│   ├── auth.py             # 账号、RBAC、LDAP/SSO、会话
│   ├── extended.py         # 设置、报表、快照、VRF 管理与配置种子
│   ├── assets.py           # 位置 / 机柜 / 设备 / 链路
│   ├── prefix_admin.py / ip_admin.py / device_roles.py
├── frontend/               # React + TypeScript + Vite
│   ├── src/                # 页面源码
│   ├── dist/               # 构建产物（后端直接托管，故随仓库提交）
│   ├── package.json / package-lock.json
├── tests/
│   ├── test_vrf_isolation.py   # VRF 隔离回归测试（14 项）
│   └── test_clean_install.py   # 纯净模式全新安装 / 幂等 / 不回灌测试（5 项）
├── ipam.db                 # 运行后自动生成，已忽略，不提交
└── backups/                # 本地备份，已忽略，不提交
```

---

## 9. 安全提醒

- **默认密码 `Admin@123` 已写在公开仓库的 README、脚本和 `backend/auth.py` 里**，任何能看到仓库的人都知道。首次登录后请立刻在「访问控制 → 用户与权限」修改；演示模式的 `viewer / Viewer@123` 同理，纯净模式不会创建该账号。
- `ipam.db` 内含密码哈希与会话 token，不要上传 GitHub、不要放进公开网盘；`backups/` 同样敏感。
- 默认 `uvicorn --host 0.0.0.0 --port 8000` 会让用户**绕过 nginx 直接以 HTTP 明文访问**。生产环境建议把 8000 收敛到 `127.0.0.1` 或防火墙拦截，只开放 nginx 的 80 / 443。
- 直接暴露到公网前，请配置 HTTPS、修改默认密码、限制 8000 端口访问，并按需开启 SSO / LDAP。全站 HTTPS 稳定后，再考虑给登录 Cookie 加 `secure=True`（否则 http 直连会无法保持登录），HSTS 更要等证书在客户端可信后再开。
- 若整个项目文件夹（含隐藏文件）被打包外发，注意排除 `.workbuddy/`、`.venv/`、`ipam.db`、`backups/` 等本地数据目录。
