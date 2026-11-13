# 在 Linux 上从 GitHub 获取 IPAM 项目

> 仓库地址：https://github.com/cn86cc/IPAM
> 公开仓库，匿名克隆即可，不需要账号或密码。

## 1. 安装 git（已安装可跳过）

```bash
# Ubuntu / Debian
sudo apt update && sudo apt install -y git
```

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

## 4. 常用变体

| 目的 | 命令 | 访问地址 |
| --- | --- | --- |
| 想带演示数据体验 | `./install.sh --start` | `http://127.0.0.1:8000` |
| 局域网 / 服务器访问 | `IPAM_DEMO_SEED=0 IPAM_HOST=0.0.0.0 ./install.sh --start` | `http://服务器IP:8000` |
| 只安装不启动 | `./install.sh` | — |
| 换端口 | `IPAM_PORT=8001 ./install.sh --start` | `http://127.0.0.1:8001` |
| 拿到旧副本后更新 | `cd IPAM && git pull --ff-only` | — |
| 不装 git，下载压缩包 | `curl -L -o IPAM.tar.gz https://github.com/cn86cc/IPAM/archive/refs/heads/main.tar.gz && tar -xzf IPAM.tar.gz && cd IPAM-main` | — |

## 5. 说明

- 仓库已随附 `frontend/dist/`，**不需要安装 Node.js** 也能直接运行。
- 脚本只要求 **Python 3.10+**，会自动创建 `.venv`、安装依赖、初始化 SQLite 数据库。
- 默认 `./install.sh --start` 会灌入演示业务数据；生产 / 纯净部署务必加 `IPAM_DEMO_SEED=0`，否则服务重启后演示数据会被幂等种子补回。
- 允许外部访问时，除了 `IPAM_HOST=0.0.0.0`，还需放行服务器的 8000 端口。
- 更详细的配置与排错见仓库里的 `README.md`。
