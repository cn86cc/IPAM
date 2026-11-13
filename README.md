# IPAM · IPv4 地址管理平台

一套可直接本机运行、也可部署到内网服务器的 IPv4 地址管理（IPAM）系统。前端 React + TypeScript，后端 FastAPI，数据存 SQLite，**无需安装数据库服务**，一条命令即可跑起来。

> 首次登录账号：`admin`　密码：`Admin@123`　（登录后请立刻在「访问控制 → 用户与权限」中修改）

---

## 目录

1. [简介](#1-简介)
2. [环境要求](#2-环境要求)
3. [一键部署步骤](#3-一键部署步骤)
4. [启动命令速查](#4-启动命令速查)
5. [配置说明](#5-配置说明)
6. [常见排错](#6-常见排错)
7. [用 GitHub Desktop 上传到 GitHub](#7-用-github-desktop-上传到-github)
8. [目录结构](#8-目录结构)

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
  ▼
FastAPI / Uvicorn  ──  backend/*.py（统一鉴权、VRF 上下文、RBAC、审计）
  │
  ▼
SQLite  ipam.db（WAL 模式，21 张表，启动时自动建表 / 幂等迁移）
```

`VRF 地址平面`是全局概念：顶栏切换器决定当前平面，所有地址类数据按 `(vrf, cidr)` / `(vrf, addr)` 隔离；选择「全部 VRF」是只读汇总视图，写操作会被后端拒绝。不同平面可以复用相同的地址段，系统提供跨平面重叠报告与迁移删除。

> 根目录的 `index.html` 是最早的静态产品原型页，仅作参考，系统实际入口是 `frontend/` 构建出的页面。

---

## 2. 环境要求

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | macOS 12+ / Ubuntu 20.04+ / Debian / CentOS 等 Linux | Windows 请用 WSL2 |
| Python | **3.10 及以上**（推荐 3.11 / 3.12） | 脚本优先兼容 3.10+；需带 `venv` 模块 |
| Node.js | 18+（推荐 20 / 22 LTS） | **仅构建前端时需要**。仓库已带 `frontend/dist/`，若不改前端代码，可不装 Node |
| npm | 随 Node.js 一起安装 | 同上 |
| 浏览器 | Chrome / Edge / Safari 新版 | 需启用 Cookie |
| 端口 | 8000（生产/API）、5173（开发态前端） | 可自定义 |
| 网络 | 首次安装需访问 PyPI / npm | 内网可配镜像，见[配置说明](#5-配置说明) |

依赖清单：`backend/requirements.txt`（fastapi、uvicorn、ldap3）、`frontend/package.json`（React 19、Vite 6、TypeScript 5）。测试只用 Python 标准库 `unittest`，不额外装 pytest。

---

## 3. 一键部署步骤

### 第 1 步：取得代码

从 GitHub clone，或直接把项目文件夹复制到目标机器（例如 `~/IPAM`）。打开终端进入目录：

```bash
cd ~/IPAM
```

### 第 2 步：赋权并运行安装脚本

```bash
chmod +x install.sh start.sh
./install.sh
```

脚本会按顺序做 6 件事，**每一步都会先判断，已完成的自动跳过，不会重复安装**：

1. 检测系统、Python 版本（≥3.10）、必要时检测 Node/npm 版本（≥18）；
2. 检查 `.venv`：存在且可用就复用，不存在才创建；
3. 检查 `fastapi / uvicorn / ldap3` 是否已安装且版本达标，齐备就**跳过 pip install**；
4. 检查 `frontend/node_modules` 关键包与 `frontend/dist/index.html`，已存在就跳过安装与构建；
5. 初始化 / 幂等迁移数据库 `ipam.db`（已有数据不会被覆盖）；
6. 自检后端模块能否导入。

> 想先看一眼状态、不想改动任何文件：`./install.sh --check`。
> 修改了 `frontend/src` 里的代码：`./install.sh --rebuild`。

重要：脚本默认 `IPAM_DEMO_SEED=1`，**首次初始化会写入演示业务数据**（示例设备、工单、对账记录等），方便新手体验。如果你要一个干净的空库（生产部署），请用下面这条命令代替：

```bash
IPAM_DEMO_SEED=0 ./install.sh
```

### 第 3 步：启动并访问

```bash
./install.sh --start
```

看到 `启动服务： http://127.0.0.1:8000/` 后，浏览器打开该地址，用 `admin / Admin@123` 登录。按 `Ctrl + C` 停止服务。

想用「前端热更新」的开发模式，则改用：

```bash
./start.sh          # 同时启动 8000(API) + 5173(Vite)，访问 http://127.0.0.1:5173
```

---

## 4. 启动命令速查

| 目的 | 命令 | 访问地址 |
| --- | --- | --- |
| 一键安装（不启动） | `./install.sh` | — |
| 只检查环境 | `./install.sh --check` | — |
| 单端口生产模式（推荐） | `./install.sh --start` | http://127.0.0.1:8000 |
| 允许局域网/服务器访问 | `IPAM_HOST=0.0.0.0 ./install.sh --start` | http://服务器IP:8000 |
| 换端口 | `IPAM_PORT=8001 ./install.sh --start` | http://127.0.0.1:8001 |
| 前端改动后重建 | `./install.sh --rebuild` | — |
| 开发热更新 | `./start.sh` | http://127.0.0.1:5173 |
| 运行回归测试 | `./install.sh --test` | — |
| 直接启动后端（等价手写） | `.venv/bin/python -m uvicorn backend.app:app --host 0.0.0.0 --port 8000` | http://127.0.0.1:8000 |
| 单独构建前端 | `cd frontend && npm run build` | — |
| API 文档 | 服务启动后访问 | http://127.0.0.1:8000/docs |

### 服务器常驻运行（systemd，可选）

新建 `/etc/systemd/system/ipam.service`：

```ini
[Unit]
Description=IPAM Service
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/ipam
Environment=PYTHONUNBUFFERED=1
Environment=IPAM_DEMO_SEED=0
ExecStart=/opt/ipam/.venv/bin/python -m uvicorn backend.app:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips=127.0.0.1
Restart=always

[Install]
WantedBy=multi-user.target
```

然后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ipam
sudo systemctl status ipam
```

---

## 5. 配置说明

### 环境变量（脚本 / 服务层）

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `IPAM_DEMO_SEED` | `1` | 设为 `0` 关闭演示业务数据灌入；生产环境务必设为 `0`，否则清空后的数据会在服务重启时被幂等种子补回 |
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
- **用户与权限**：本地用户、角色（admin / viewer）、模块可见性、CIDR 可见范围（`vrf:CIDR` 形式）。
- **认证源**：本地、LDAP/AD、SSO(OIDC) 的开关与参数；`ldap3` 已随依赖安装。
- **集成来源 / Webhook / 自定义页面**：对账数据源、事件推送、VRF 页面文案等。

### 数据与端口

- 数据库固定为项目根目录的 `ipam.db`（SQLite，WAL 模式会额外产生 `ipam.db-wal` / `ipam.db-shm`）；`DB_PATH` 定义见 `backend/db.py`。
- 备份文件放在 `backups/`。这些文件**都含账号密码哈希与业务数据，已在 `.gitignore` 中排除，切勿上传 GitHub**。
- CORS 白名单写在 `backend/app.py`（默认只允许 `127.0.0.1:5173` / `localhost:5173`）；只有用独立前端域名时才需要改代码。
- 想启用 HTTPS：在 nginx 上做 443 的 TLS 终止并反代到 8000，同时把 8000 收敛到 `127.0.0.1` 或防火墙拦截，再让 nginx 传 `X-Forwarded-Proto`；uvicorn 启动参数加 `--proxy-headers --forwarded-allow-ips=127.0.0.1`（上方 systemd 示例已带）。应用代码基本不用改（前端 API 全部是相对路径 `/api`）。

---

## 6. 常见排错

| 现象 | 原因 / 解决 |
| --- | --- |
| `python3: command not found` | 没装 Python。macOS：`brew install python@3.12`；Ubuntu：`sudo apt install -y python3 python3-venv` |
| `Python 版本过低` | 需 3.10+。用 `python3 -V` 确认；macOS 自带版本较旧时请装 Homebrew 版并把它放在 PATH 前面 |
| `No module named venv` / 创建虚拟环境失败 | Debian/Ubuntu 缺组件：`sudo apt install -y python3-venv python3-pip` |
| `.venv 已存在但 .venv/bin/python 不可执行` | 残留的损坏环境。手动删除 `.venv` 目录后重跑 `./install.sh`（只删这个目录是安全的，它可重建） |
| `缺少 Node.js` | 仅当 `frontend/dist` 缺失或用了 `--rebuild` 时才需要。安装 Node 20 LTS，或改用已提交 dist 的方式运行 |
| `npm ci` 报 lock 不一致 | 脚本会自动回退 `npm install`；仍失败可删除 `frontend/node_modules` 后重跑 |
| pip / npm 下载超时 | 设镜像：`PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple npm_config_registry=https://registry.npmmirror.com ./install.sh` |
| `端口 8000 已被占用` | 换端口 `IPAM_PORT=8001 ./install.sh --start`；或 `lsof -i :8000` 找出旧进程并停止 |
| 打开页面 404 / 白屏 | `frontend/dist` 没构建或已过期：`./install.sh --rebuild`；生产模式请访问 8000 而不是 5173 |
| 改了前端代码但页面没变化 | 生产模式读的是 dist，必须重建：`./install.sh --rebuild`；开发模式请用 `./start.sh` |
| 登录失败 / 忘记密码 | 默认 `admin / Admin@123`；若改过且忘记，只能从备份恢复，或删除 `ipam.db` 重建（**会丢失全部数据，务必先备份**） |
| 重启后演示数据又冒出来 | `IPAM_DEMO_SEED` 没关。用 `IPAM_DEMO_SEED=0` 启动，并在 systemd 里写上该环境变量 |
| `database is locked` | 同一目录启动了多个服务进程；停掉重复的，只保留一个 |
| 局域网访问不到 | 需要 `IPAM_HOST=0.0.0.0`，并放行服务器防火墙 / 云安全组的 8000 端口 |
| `Permission denied: ./install.sh` | 执行 `chmod +x install.sh start.sh` |
| SSO / LDAP 回调失败 | 检查回调地址与认证源配置；前后端域名变化后还要检查 `backend/app.py` 的 CORS 白名单 |

还有问题时，先跑 `./install.sh --check` 看各组件状态，再跑 `./install.sh --test` 确认后端回归测试（14 项）是否通过。

---

## 7. 用 GitHub Desktop 上传到 GitHub

### 准备

1. 确认项目根目录里有 `.gitignore`、`README.md`、`install.sh`；
2. **确认敏感文件不会被提交**：`ipam.db`、`ipam.db-wal`、`backups/`、`.venv/`、`frontend/node_modules/`、`.workbuddy/`、`.DS_Store` 都不应出现在待提交列表里（它们已被 `.gitignore` 排除）；
3. 安装并登录 [GitHub Desktop](https://desktop.github.com/)。

### 上传步骤

1. 打开 GitHub Desktop → 菜单 **File → Add Local Repository…**（或首页 `Add an Existing Repository`）。
2. 点 **Choose…**，选中整个项目文件夹（就是含 `backend/`、`frontend/`、`install.sh` 的那一层），点 **Add Repository**。
3. 若提示 *"This directory does not appear to be a Git repository"*，点 **create a repository**：
   - Name 填 `ipam`；
   - **Git Ignore 选 `None`**（我们已经有手写 `.gitignore`，别让软件覆盖它）；
   - License 按需选择，可不选；
   - 点 **Create Repository**。
4. 左侧 **Changes** 里检查文件清单：应该看到 `backend/`、`frontend/`（不含 `node_modules`）、`tests/`、`README.md`、`install.sh`、`start.sh`、`.gitignore`；**不应该**看到 `.venv/`、`ipam.db`、`backups/`、`*.log`。
5. 左下角 **Summary** 填提交说明，例如 `feat: IPAM v1.0 初始交付`，点 **Commit to main**。
6. 点右上角 **Publish repository**：
   - 填仓库名（默认同本地名）；
   - 取消勾选 *Keep this code private* 才是公开仓库；涉及内网地址、账号策略时**建议保持私有**；
   - 点 **Publish Repository**，等待上传完成。
7. 以后改了代码：在 Changes 里填 Summary → **Commit to main** → 右上角 **Push origin** 同步到 GitHub。

如果 GitHub 上已经建好空仓库：先 **File → Clone Repository** 克隆到本地，把项目文件复制进去（不要复制 `.git`、`.venv`、`ipam.db`），再 Commit + Push。

> 万一不小心把 `ipam.db` 提交上去了：先删除本地文件再提交一次，并**立刻修改所有账号密码**；Git 历史里仍留有旧文件，公开仓库需要进一步清理历史（超出本指南范围，建议直接新建仓库重新上传）。

---

## 8. 目录结构

```text
IPAM/
├── .gitignore              # GitHub 提交过滤规则
├── README.md               # 本使用指南
├── install.sh              # 一键部署脚本（macOS / Linux）
├── start.sh                # 开发模式启动（API 8000 + Vite 5173）
├── index.html              # 早期静态产品原型页（仅供参考）
├── backend/                # FastAPI 后端
│   ├── requirements.txt    # Python 依赖
│   ├── app.py              # 路由、鉴权中间件、静态托管
│   ├── db.py               # SQLite 建表 / 迁移 / VRF 上下文 / 阈值
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
│   └── test_vrf_isolation.py   # VRF 隔离回归测试（unittest，14 项）
├── ipam.db                 # 运行后自动生成，已忽略，不提交
└── backups/                # 本地备份，已忽略，不提交
```

---

## 安全提醒

- 默认密码 `Admin@123` 仅用于首次登录，正式使用前必须修改。
- `ipam.db` 内含密码哈希与会话 token，不要上传、不要放进公开网盘。
- 直接暴露到公网前，请配置 HTTPS、修改默认密码、限制 8000 端口访问，并按需开启 SSO/LDAP。
