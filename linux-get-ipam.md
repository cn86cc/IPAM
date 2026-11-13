# 在 Linux 上从 GitHub 获取并运行 IPAM

> 仓库地址：https://github.com/cn86cc/IPAM （公开仓库，匿名克隆即可）
>
> 完整指南（[README.md](README.md)）：一键安装详解、[依赖环境完整说明](README.md#4-依赖环境完整说明)、[系统配置详解](README.md#6-系统配置详解)、[验收清单](README.md#9-验收清单)、[常见排错](README.md#10-常见排错)。

## 1. 最省事：纯净服务器一键安装

连 git 都没装的新机器也能用。复制这两行：

```bash
curl -fsSL -o /tmp/ipam-bootstrap.sh https://raw.githubusercontent.com/cn86cc/IPAM/main/bootstrap.sh
bash /tmp/ipam-bootstrap.sh
```

脚本自动完成：装 `git` / `curl` → clone 到 `/opt/ipam` → 装 `python3-venv` / `pip` / `nginx` 等系统依赖 → 建 `.venv` 与 Python 依赖 → 初始化纯净数据库 → 19 项回归测试 → 写 systemd + nginx 配置 → 开机自启 → HTTP 验收。

过程会提示输入 sudo 密码。看到下面这段就成功了：

```text
users=1  prefixes=3  ip_addresses=0  业务表合计=0  integrity=ok
[OK] 纯净库验收通过（三段根 / 仅 admin / 业务表全空)
Ran 19 tests ... OK
[OK] ipam active=active enabled=enabled
系统配置完成，IPAM 已常驻运行
   访问地址  : http://服务器IP/
```

浏览器打开 `http://服务器IP/`，用 `admin` / `Admin@123` 登录（**登录后立刻改密码**）。

## 2. 传统方式：手动 clone 再一键部署

```bash
sudo apt update && sudo apt install -y git curl
git clone https://github.com/cn86cc/IPAM.git /opt/ipam
cd /opt/ipam
./install.sh --deploy
```

`--deploy` 与第 1 节的后半段完全相同，只是代码由你自己 clone。

## 3. 只在本机跑起来（不装 nginx、不做系统服务）

```bash
sudo apt update && sudo apt install -y git python3 python3-venv python3-pip
git clone https://github.com/cn86cc/IPAM.git
cd IPAM
chmod +x install.sh
IPAM_DEMO_SEED=0 ./install.sh --start
```

访问 `http://127.0.0.1:8000`，按 `Ctrl + C` 停止。

> `python3-venv` 是 Ubuntu 最小安装最常缺的组件。缺了会报 `The virtual environment was not created successfully because ensurepip is not available`；注意 `python3 -m venv --help` 会假阳性，**别用它判断**。

## 4. 常用变体

| 目的 | 命令 | 访问地址 |
| --- | --- | --- |
| 纯净服务器一键部署 | `bash /tmp/ipam-bootstrap.sh` | `http://服务器IP/` |
| 已 clone 后一键部署 | `./install.sh --deploy` | `http://服务器IP/` |
| 只看状态、不改动 | `./install.sh --check` | — |
| 本机安装不启动 | `./install.sh` | — |
| 本机单端口启动 | `IPAM_DEMO_SEED=0 ./install.sh --start` | `http://127.0.0.1:8000` |
| 想带演示数据体验 | `./install.sh --start` | `http://127.0.0.1:8000` |
| 顺带跑回归测试 | `IPAM_DEMO_SEED=0 ./install.sh --test` | — |
| 局域网访问（本机模式） | `IPAM_HOST=0.0.0.0 ./install.sh --start` | `http://服务器IP:8000` |
| 换端口 | `IPAM_PORT=8001 ./install.sh --start` | `http://127.0.0.1:8001` |
| 不配 nginx，只留 systemd | `IPAM_WITH_NGINX=0 IPAM_NEED_NGINX=0 ./install.sh --deploy` | `http://服务器IP:8000` |
| 单独重装系统依赖 | `sudo ./scripts/system-deps.sh --apply` | — |
| 单独重配系统服务 | `sudo ./scripts/system-config.sh --apply` | — |
| 拿到旧副本后更新 | `cd IPAM && git pull --ff-only && sudo systemctl restart ipam` | — |
| 不装 git，下载压缩包 | `curl -L -o IPAM.tar.gz https://github.com/cn86cc/IPAM/archive/refs/heads/main.tar.gz && tar -xzf IPAM.tar.gz && cd IPAM-main && ./install.sh --deploy` | — |

## 5. 说明

- 仓库自带 `frontend/dist/`，**不需要 Node.js**；后端直接托管前端静态页。
- 只需 **Python 3.10+** + `venv` + `pip`；SQLite 由 Python 内置模块提供，无需数据库服务。
- `IPAM_DEMO_SEED=0` 是纯净 / 生产模式（三段 RFC1918 根 + 仅 admin + 内置配置，业务表全空）；不加变量在本机默认灌演示数据。一键部署与 systemd unit 都会自动设成 0，**重启不会灌回演示数据**。
- 三个脚本都是幂等的，重复执行不会重复安装、不会覆盖已有数据。
- 允许外部访问时需放行防火墙 / 安全组的 80 与 8000 端口。
- 默认口令 `admin / Admin@123` 写在公开仓库里，首次登录后请立即修改。
