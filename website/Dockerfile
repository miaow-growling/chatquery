# =========================================================================
# 智询 (ChatQuery) 官网静态站点 Dockerfile (适配 1Panel 容器化部署)
#
# 特性:
# 1. 构建期全自动拉取阿里云 OSS 上的 latest.json 最新版本元数据
# 2. 自动将最新版本号、各平台下载直链（macOS / Windows）直接注入到静态 HTML
# 3. 运行环境采用轻量高效的 nginx:alpine 镜像，占用仅约 15MB 内存
# 4. 内置 Gzip 压缩与静态资源高效缓存配置
# =========================================================================

# --- 阶段 1: 预构建与最新发版信息自动注入 ---
FROM node:20-alpine AS builder

WORKDIR /app

# 复制当前静态网站源码及注入脚本
COPY . .

# 自动联网拉取最新的版本号与各平台下载直链，并静态注入 index.html
RUN node inject-latest.mjs

# --- 阶段 2: Nginx 生产环境服务镜像 ---
FROM nginx:alpine

# 替换默认 Nginx 配置 (支持 Gzip 压缩与缓存控制)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# 从构建阶段复制处理完成的纯静态网站文件
COPY --from=builder /app /usr/share/nginx/html

# 清理镜像内无用的构建脚本和配置文件
RUN rm -f /usr/share/nginx/html/Dockerfile \
          /usr/share/nginx/html/nginx.conf \
          /usr/share/nginx/html/inject-latest.mjs

EXPOSE 80

STOPSIGNAL SIGQUIT

CMD ["nginx", "-g", "daemon off;"]
