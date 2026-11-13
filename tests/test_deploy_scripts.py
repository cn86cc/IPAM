"""部署脚本自检：不需要 root、不修改项目文件、可在 macOS / Linux 上运行。

覆盖：脚本存在与编码、bash 语法、帮助、只读检查模式、systemd/nginx 配置渲染、
环境变量覆盖、模拟 Linux 的 --check 分支、README 锚点、敏感串。
"""

import os
import re
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = (
    "install.sh",
    "bootstrap.sh",
    "scripts/system-deps.sh",
    "scripts/system-config.sh",
)


def run(args, env=None, cwd=None, timeout=90):
    return subprocess.run(
        args,
        cwd=str(cwd or ROOT),
        env={**os.environ, **(env or {})},
        capture_output=True,
        text=True,
        timeout=timeout,
    )


class DeployScriptsTest(unittest.TestCase):
    def test_01_scripts_exist_utf8_executable(self):
        for rel in SCRIPTS:
            p = ROOT / rel
            self.assertTrue(p.is_file(), "缺少脚本：" + rel)
            p.read_bytes().decode("utf-8")  # 编码必须是 UTF-8
            self.assertTrue(p.stat().st_mode & stat.S_IXUSR, "缺少可执行位：" + rel)

    def test_02_bash_syntax(self):
        for rel in SCRIPTS:
            r = run(["bash", "-n", rel])
            self.assertEqual(r.returncode, 0, "%s 语法错误：%s" % (rel, r.stderr))

    def test_03_help_outputs(self):
        r = run(["./install.sh", "--help"])
        self.assertEqual(r.returncode, 0, r.stderr)
        for kw in ("--deploy", "--check", "--start", "--test", "bootstrap.sh"):
            self.assertIn(kw, r.stdout)
        for rel, kws in (
            ("scripts/system-deps.sh", ("--check", "--apply", "--render", "venv + 内置 pip")),
            ("scripts/system-config.sh", ("--render", "--apply", "--remove", "systemd")),
            ("bootstrap.sh", ("IPAM_DIR", "bootstrap.sh", "--deploy")),
        ):
            r = run(["./" + rel, "--help"])
            self.assertEqual(r.returncode, 0, "%s --help 失败：%s" % (rel, r.stderr))
            for kw in kws:
                self.assertIn(kw, r.stdout, "%s --help 缺少 %s" % (rel, kw))

    def test_04_install_check_is_readonly(self):
        r = run(["./install.sh", "--check"])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("应用层组件状态", r.stdout)
        self.assertIn("未安装、未修改任何文件", r.stdout)
        self.assertIn("IPAM_DEMO_SEED", r.stdout)

    def test_05_system_deps_check(self):
        r = run(["./scripts/system-deps.sh", "--check"])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("venv + 内置 pip", r.stdout)
        self.assertIn("包管理器", r.stdout)
        self.assertIn("未安装、未修改任何文件", r.stdout)
        # --render 不能真的执行安装
        r2 = run(["./scripts/system-deps.sh", "--render"])
        self.assertEqual(r2.returncode, 0, r2.stderr)
        self.assertIn("将要执行的命令", r2.stdout)

    def test_06_config_render_content(self):
        r = run(["./scripts/system-config.sh", "--render"])
        self.assertEqual(r.returncode, 0, r.stderr)
        out = r.stdout
        # systemd unit 关键项
        for kw in (
            "[Unit]", "[Service]", "[Install]", "Type=simple",
            "WorkingDirectory=", "Environment=IPAM_DEMO_SEED=0",
            "Restart=always", "RestartSec=3", "WantedBy=multi-user.target",
            "--proxy-headers", "--forwarded-allow-ips=127.0.0.1",
            "uvicorn backend.app:app",
        ):
            self.assertIn(kw, out, "unit 渲染缺少：" + kw)
        # nginx 站点关键项（$ 变量必须原样保留，不能被 shell 展开）
        for kw in (
            "listen 80 default_server", "proxy_pass http://127.0.0.1:8000",
            "proxy_set_header Host $host", "proxy_set_header X-Real-IP $remote_addr",
            "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for",
            "proxy_set_header X-Forwarded-Proto $scheme",
            "client_max_body_size 16m",
        ):
            self.assertIn(kw, out, "nginx 渲染缺少：" + kw)

    def test_07_config_render_env_override(self):
        r = run(
            ["./scripts/system-config.sh", "--render"],
            env={
                "IPAM_PORT": "9000",
                "IPAM_HTTP_PORT": "8081",
                "IPAM_SERVICE_USER": "alice",
                "IPAM_DEMO_SEED": "1",
                "IPAM_BIND_HOST": "127.0.0.1",
            },
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        out = r.stdout
        self.assertIn("User=alice", out)
        self.assertIn("Environment=IPAM_DEMO_SEED=1", out)
        self.assertIn("--port 9000", out)
        self.assertIn("--host 127.0.0.1", out)
        self.assertIn("listen 8081 default_server", out)
        self.assertIn("proxy_pass http://127.0.0.1:9000", out)

    def test_08_linux_check_branch_with_mock(self):
        """在 macOS 上用 mock 命令模拟 Linux，验证 --check 分支不会误写文件。"""
        with tempfile.TemporaryDirectory() as d:
            bin_dir = Path(d) / "bin"
            bin_dir.mkdir()
            (bin_dir / "uname").write_text("#!/bin/sh\nprintf 'Linux\\n'\n", encoding="utf-8")
            (bin_dir / "systemctl").write_text(
                "#!/bin/sh\ncase \"$1\" in\n"
                "  is-active) printf 'active\\n' ;;\n"
                "  is-enabled) printf 'enabled\\n' ;;\n"
                "  *) printf '' ;;\nesac\n",
                encoding="utf-8",
            )
            for name in ("uname", "systemctl"):
                (bin_dir / name).chmod(0o755)
            r = run(
                ["./scripts/system-config.sh", "--check"],
                env={"PATH": str(bin_dir) + os.pathsep + os.environ["PATH"]},
            )
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn("系统配置预览（Linux）", r.stdout)
            self.assertIn("IPAM_DEMO_SEED", r.stdout)
            self.assertIn("检查完成，未修改任何文件", r.stdout)
            self.assertNotIn("[错误]", r.stdout)
            # 确认确实没有写入 /etc 下的配置
            self.assertFalse(Path("/etc/systemd/system/ipam.service").exists()
                             or Path("/etc/nginx/sites-available/ipam").exists(),
                             "--check 不应写入系统配置")

    def test_09_system_deps_linux_apt_branch(self):
        """模拟 Ubuntu 24.04，验证 apt 包映射与 --render 命令不会误执行。"""
        with tempfile.TemporaryDirectory() as d:
            bin_dir = Path(d) / "bin"
            bin_dir.mkdir()
            (bin_dir / "uname").write_text("#!/bin/sh\nprintf 'Linux\\n'\n", encoding="utf-8")
            (bin_dir / "nginx").write_text(
                "#!/bin/sh\nprintf 'nginx version: nginx/1.24.0 (Ubuntu)\\n' >&2\n",
                encoding="utf-8",
            )
            for name in ("uname", "nginx"):
                (bin_dir / name).chmod(0o755)
            osrel = Path(d) / "os-release"
            osrel.write_text('ID=ubuntu\nVERSION_ID="24.04"\n', encoding="utf-8")
            base_env = {
                "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
                "IPAM_OS_RELEASE": str(osrel),
                "IPAM_NEED_NGINX": "1",
            }
            r = run(["./scripts/system-deps.sh", "--check"], env=base_env)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn("系统依赖检测（Linux / 包管理器：apt）", r.stdout)
            self.assertIn("全部依赖齐备", r.stdout)
            self.assertIn("venv + 内置 pip", r.stdout)

            # 强制把 nginx 视为缺失：不能只删 mock 文件，真实 Ubuntu 上
            # /usr/sbin/nginx 仍会被 command -v 找到，会让本用例假阳性失败。
            # IPAM_MOCK_MISSING 让断言与宿主机真实环境解耦（--render 只打印不执行）。
            force_missing = dict(base_env, IPAM_MOCK_MISSING="nginx")
            r2 = run(["./scripts/system-deps.sh", "--render"], env=force_missing)
            self.assertEqual(r2.returncode, 0, r2.stdout + r2.stderr)
            self.assertIn("apt-get install -y", r2.stdout)
            self.assertIn("nginx", r2.stdout)
            self.assertIn("将要执行的命令", r2.stdout)

    def test_10_readme_anchors(self):
        text = (ROOT / "README.md").read_text(encoding="utf-8")

        def slug(title):
            s = title.strip().lower()
            s = "".join(ch for ch in s if ch.isalnum() or ch in (" ", "-", "_"))
            return s.replace(" ", "-")

        heads = re.findall(r"^#{2,3} (.+)$", text, re.M)
        anchors = {slug(h) for h in heads}
        links = re.findall(r"\]\(#([^)]+)\)", text)
        bad = [a for a in links if a not in anchors]
        self.assertEqual(bad, [], "README 失效锚点：%s" % bad)
        self.assertIn("## 3. 一键安装", text)
        self.assertIn("## 4. 依赖环境完整说明", text)
        self.assertIn("## 6. 系统配置详解", text)
        self.assertEqual(text.count("```") % 2, 0, "代码围栏未配对")

    def test_11_no_sensitive_strings_in_delivery_files(self):
        # 片段拼接：避免本测试文件自身出现这些字面串，导致安全扫描自命中
        fragments = ("10" + ".255.99.", "Advai" + "2016", "Advai@" + "2016")
        key_pattern = re.compile(r"BEGIN (RSA|OPENSSH) PRIVATE KEY", re.I)
        files = list(SCRIPTS) + ["README.md", "linux-get-ipam.md", ".gitignore",
                                 "tests/test_deploy_scripts.py"]
        for rel in files:
            text = (ROOT / rel).read_text(encoding="utf-8")
            for frag in fragments:
                self.assertNotIn(frag, text, "交付文件含敏感串：%s -> %s" % (rel, frag))
            self.assertIsNone(key_pattern.search(text), "交付文件含私钥：" + rel)


if __name__ == "__main__":
    unittest.main()
