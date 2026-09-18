# =========================================================================
# 智询 (ChatQuery) 官网静态站点 Dockerfile (支持从仓库根目录直接构建)
#
# 无论是使用 1Panel、Docker CLI 还是 CI 流水线，直接在根目录执行：
#   docker build -t chatquery-website .
# =========================================================================

# --- 阶段 1: 预构建与最新发版信息自动注入 ---
FROM node:20-alpine AS builder

WORKDIR /app

# 仅复制代码库中的官网静态资源
COPY website/ .

# 自动联网拉取最新的版本号与各平台下载直链，并静态注入 index.html
RUN node inject-latest.mjs

# --- 阶段 2: Nginx 生产环境服务镜像 ---
FROM nginx:alpine

# 替换默认 Nginx 配置 (支持 Gzip 压缩与缓存控制)
COPY website/nginx.conf /etc/nginx/conf.d/default.conf

# 从构建阶段复制处理完成的纯静态网站文件
COPY --from=builder /app /usr/share/nginx/html

# 清理镜像内无用的构建脚本和配置文件
RUN rm -f /usr/share/nginx/html/Dockerfile \
          /usr/share/nginx/html/nginx.conf \
          /usr/share/nginx/html/inject-latest.mjs

EXPOSE 80

STOPSIGNAL SIGQUIT

CMD ["nginx", "-g", "daemon off;"]
