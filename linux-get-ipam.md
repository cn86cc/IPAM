# 在 Linux 上从 GitHub 获取 IPAM 项目

> 仓库地址：https://github.com/cn86cc/IPAM
> 公开仓库，匿名克隆即可，不需要账号或密码。
> 完整的服务器常驻部署（systemd + nginx）、验收清单与排错见 [README.md 第 5 节](README.md#5-生产服务器部署)。

## 1. 安装基础依赖（已安装可跳过）

```bash
# Ubuntu / Debian
sudo apt update && sudo apt install -y git python3 python3-venv python3-pip
```

`python3-venv` 是创建虚拟环境必需的组件，Ubuntu 常缺；缺了会报 `No module named venv` 或 `ensurepip is not available`。

## 2. 克隆项目

```bash
git clone https://github.com/cn86cc/IPAM.git
cd IPAM
```

## 3. 拿到代码后一键部署（纯净空库 / 生产模式）

```bash
chmod +x install.sh start.sh
IPAM_DEMO_SEED=0 ./install.sh --start
```

启动后访问 `http://127.0.0.1:8000`，按 `Ctrl + C` 停止服务。

纯净模式首次初始化会打印验收结果：

```text
users=1  prefixes=3  ip_addresses=0  业务表合计=0  integrity=ok
[OK] 纯净库验收通过（三段根 / 仅 admin / 业务表全空）
```

即只保留三段 RFC1918 根、`admin` 账号和内置配置，没有任何演示业务数据。

## 4. 常用变体

| 目的 | 命令 | 访问地址 |
| --- | --- | --- |
| 想带演示数据体验 | `./install.sh --start` | `http://127.0.0.1:8000` |
| 只安装不启动 | `./install.sh` | — |
| 顺带跑回归测试 | `IPAM_DEMO_SEED=0 ./install.sh --test` | — |
| 局域网 / 服务器访问 | `IPAM_DEMO_SEED=0 IPAM_HOST=0.0.0.0 ./install.sh --start` | `http://服务器IP:8000` |
| 换端口 | `IPAM_PORT=8001 ./install.sh --start` | `http://127.0.0.1:8001` |
| 拿到旧副本后更新 | `cd IPAM && git pull --ff-only` | — |
| 不装 git，下载压缩包 | `curl -L -o IPAM.tar.gz https://github.com/cn86cc/IPAM/archive/refs/heads/main.tar.gz && tar -xzf IPAM.tar.gz && cd IPAM-main` | — |

## 5. 说明

- 仓库已随附 `frontend/dist/`，**不需要安装 Node.js** 也能直接运行。
- 脚本只要求 **Python 3.10+**，会自动创建 `.venv`、安装依赖、初始化 SQLite 数据库，并在纯净模式下验收空库。
- `IPAM_DEMO_SEED=0` 是纯净 / 生产模式；不加则默认灌入完整演示业务数据。用 systemd 常驻时，必须把 `Environment=IPAM_DEMO_SEED=0` 写进 unit，否则服务重启会按演示模式补灌示例数据。
- 允许外部访问时，除了 `IPAM_HOST=0.0.0.0`，还需放行服务器的 8000 端口。
- 默认口令 `admin / Admin@123` 写在公开仓库里，首次登录后请立即修改。
