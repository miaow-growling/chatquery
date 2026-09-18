# =========================================================================
# 智询 (ChatQuery) 官网静态站点 Dockerfile (从仓库根目录构建)
#
# 特性:
# 1. 构建期全自动联网拉取阿里云 OSS 上的 latest.json 最新版本元数据
# 2. 自动将最新版本号、各平台下载直链（macOS / Windows）直接注入到静态 HTML
# 3. 运行环境采用轻量高效的 nginx:alpine 镜像，占用仅约 15MB 内存
# 4. 内置 Gzip 压缩与静态资源高效缓存配置
#
# 无论是使用 1Panel 容器构建、Docker CLI 还是 CI 流水线，执行：
#   docker build -t chatquery-website .
# =========================================================================

# 默认使用稳定高速的国内加速镜像源 (使用 1.26-alpine 保证对 CentOS 7 老内核 3.10 完美兼容)
ARG NODE_IMAGE=docker.m.daocloud.io/library/node:20-alpine
ARG NGINX_IMAGE=docker.m.daocloud.io/library/nginx:1.26-alpine

# --- 阶段 1: 预构建与最新发版信息自动注入 ---
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

# 仅复制代码库中的官网静态资源及注入脚本
COPY website/ .

# 自动联网拉取最新的版本号与各平台下载直链，并静态注入 index.html
RUN node inject-latest.mjs

# --- 阶段 2: Nginx 生产环境服务镜像 ---
FROM ${NGINX_IMAGE}

# 替换默认 Nginx 配置 (支持 Gzip 压缩与缓存控制)
COPY website/nginx.conf /etc/nginx/conf.d/default.conf

# 移除默认的慢速 ipv6 检测脚本以实现毫秒级即时冷启动
RUN rm -f /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh

# 从构建阶段复制处理完成的纯静态网站文件
COPY --from=builder /app /usr/share/nginx/html

# 清理镜像内无用的构建脚本和配置文件
RUN rm -f /usr/share/nginx/html/Dockerfile \
          /usr/share/nginx/html/nginx.conf \
          /usr/share/nginx/html/inject-latest.mjs

EXPOSE 80

STOPSIGNAL SIGQUIT

CMD ["nginx", "-g", "daemon off;"]
