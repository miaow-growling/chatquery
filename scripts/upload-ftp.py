#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
智询 (ChatQuery) 官网静态网页自动化 FTP 上传部署脚本 (适配 1Panel)

特性:
  1. 零第三方依赖：基于 Python 标准库 ftplib，开箱即用
  2. 自动读取 .env.ftp 配置文件（自动加入 .gitignore，安全不泄露）
  3. 递归自动同步 website/ 目录下的所有文件与静态资源 (index.html, assets/*)
  4. 支持标准被动模式 (PASV)，完美适配 1Panel (Pure-FTPd / vsftpd)
"""

import os
import sys
import ftplib
import time
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
WEBSITE_DIR = ROOT_DIR / "website"
ENV_FTP_PATH = ROOT_DIR / ".env.ftp"

def load_env_file(filepath: Path) -> dict:
    env = {}
    if not filepath.exists():
        return env
    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("'\"")
    return env

def main():
    print("=" * 60)
    print("🌐 智询 (ChatQuery) 官网自动化 FTP 部署 -> 1Panel")
    print("=" * 60)

    # 1. 检查配置
    file_env = load_env_file(ENV_FTP_PATH)
    host = os.getenv("FTP_HOST") or file_env.get("FTP_HOST")
    port = int(os.getenv("FTP_PORT") or file_env.get("FTP_PORT") or "21")
    user = os.getenv("FTP_USER") or file_env.get("FTP_USER")
    password = os.getenv("FTP_PASS") or file_env.get("FTP_PASS") or ""
    remote_dir = os.getenv("FTP_REMOTE_DIR") or file_env.get("FTP_REMOTE_DIR") or "/"

    if not host or not user:
        print("\n❌ 缺少 FTP 连接配置！")
        print("   请在项目根目录下创建 \033[36m.env.ftp\033[0m 文件，或配置环境变量。")
        print("   配置模板请参考: \033[33m.env.ftp.example\033[0m")
        print("\n示例 .env.ftp 内容:")
        print("----------------------------------------")
        print("FTP_HOST=你的服务器IP或域名")
        print("FTP_PORT=21")
        print("FTP_USER=你在1Panel创建的FTP用户名")
        print("FTP_PASS=你的FTP密码")
        print("FTP_REMOTE_DIR=/")
        print("----------------------------------------")
        sys.exit(1)

    if not WEBSITE_DIR.exists():
        print(f"❌ 网站目录不存在: {WEBSITE_DIR}")
        sys.exit(1)

    print(f"\n📡 正在连接 FTP 服务器: \033[36m{host}:{port}\033[0m (用户: \033[33m{user}\033[0m)...")

    # 2. 建立 FTP 连接并智能选择模式 (PASV vs Active 主动模式)
    try:
        ftp = ftplib.FTP()
        ftp.connect(host, port, timeout=15)
        ftp.login(user, password)
        print("✓ FTP 控制连接与身份鉴权成功！")

        # 智能探测数据传输通道
        use_pasv = True
        pasv_cfg = os.getenv("FTP_PASV") or file_env.get("FTP_PASV", "auto").lower()

        if pasv_cfg in ["false", "0", "active"]:
            use_pasv = False
            ftp.set_pasv(False)
            print("⚙️  已配置使用 Active 主动模式传输")
        elif pasv_cfg in ["true", "1", "pasv"]:
            use_pasv = True
            ftp.set_pasv(True)
            print("⚙️  已配置使用 PASV 被动模式传输")
        else:
            # 自动探测：先测试 PASV 数据端口连通性
            try:
                ftp.set_pasv(True)
                # 尝试用 3 秒超时的快速探针测试被动数据通道
                ftp.timeout = 3
                ftp.nlst()
                ftp.timeout = 30
                use_pasv = True
                print("✓ 检测到 PASV 被动传输通道通畅，启用被动模式")
            except Exception:
                ftp.timeout = 30
                ftp.set_pasv(False)
                try:
                    ftp.nlst()
                    use_pasv = False
                    print("⚡ PASV 被动端口受防火墙限制，已自动无缝切换为 Active 主动传输模式！")
                except Exception as act_err:
                    print(f"⚠️ 主动模式探测异常: {act_err}")
                    ftp.set_pasv(True)
    except Exception as e:
        print(f"\n❌ FTP 连接失败: {e}")
        print("💡 1Panel 排查建议:")
        print("   1. 检查 1Panel -> 网站 -> FTP 或 主机 -> 容器中的 FTP 服务是否正常运行")
        print("   2. 检查服务器安全组是否已放行端口: 21 (控制端口)")
        print("   3. 检查用户名和密码是否正确")
        sys.exit(1)

    # 3. 切换到目标远程目录
    if remote_dir and remote_dir != "/":
        try:
            parts = [p for p in remote_dir.split("/") if p]
            for p in parts:
                try:
                    ftp.cwd(p)
                except ftplib.error_perm:
                    ftp.mkd(p)
                    ftp.cwd(p)
            print(f"✓ 已切换到远程工作目录: {remote_dir}")
        except Exception as e:
            print(f"⚠️ 切换远程目录 {remote_dir} 异常: {e}，将直接上传到 FTP 根目录")

    # 4. 收集本地需要上传的文件
    local_files = []
    for root, dirs, files in os.walk(WEBSITE_DIR):
        for file in files:
            if file.startswith("."):
                continue
            full_path = Path(root) / file
            rel_path = full_path.relative_to(WEBSITE_DIR)
            local_files.append((full_path, rel_path))

    print(f"\n📦 扫描到 {len(local_files)} 个待上传网站静态资源，开始同步...")

    # 5. 执行递归上传
    success_count = 0
    t0 = time.time()

    def ensure_remote_dir(path_parts):
        cur = ftp.pwd()
        for p in path_parts:
            try:
                ftp.cwd(p)
            except ftplib.error_perm:
                try:
                    ftp.mkd(p)
                    ftp.cwd(p)
                except Exception as mk_err:
                    print(f"   ⚠️ 创建远程子目录失败: {p} ({mk_err})")
        ftp.cwd(cur)

    for i, (full_path, rel_path) in enumerate(local_files):
        rel_str = str(rel_path).replace("\\", "/")
        parts = rel_str.split("/")
        filename = parts[-1]
        dir_parts = parts[:-1]

        # 确保子目录存在
        if dir_parts:
            ensure_remote_dir(dir_parts)

        # 切换到子目录上传
        cur_pwd = ftp.pwd()
        if dir_parts:
            for dp in dir_parts:
                ftp.cwd(dp)

        size_kb = full_path.stat().st_size / 1024
        print(f"⬆️  [{i+1}/{len(local_files)}] 正在上传: \033[36m{rel_str}\033[0m ({size_kb:.1f} KB)...", end="", flush=True)

        try:
            with open(full_path, "rb") as fp:
                ftp.storbinary(f"STOR {filename}", fp)
            print(" \033[32m[完成]\033[0m")
            success_count += 1
        except Exception as up_err:
            print(f" \033[31m[失败: {up_err}]\033[0m")
        finally:
            ftp.cwd(cur_pwd)

    # 6. 关闭连接
    try:
        ftp.quit()
    except Exception:
        pass

    elapsed = time.time() - t0
    print("\n" + "=" * 60)
    print(f"🎉 网站自动化部署完成！共上传 {success_count}/{len(local_files)} 个文件，耗时 {elapsed:.2f} 秒。")
    print("=" * 60 + "\n")

if __name__ == "__main__":
    main()
