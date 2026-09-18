#!/usr/bin/env node

/**
 * 智询 (ChatQuery) 官网 Docker 构建期最新版本注入脚本
 *
 * 在 docker build 阶段自动拉取阿里云 OSS 上的 latest.json，
 * 并直接将最新的版本号、更新日志和各平台下载直链静态写入到 index.html 中。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INDEX_HTML_PATH = path.join(__dirname, 'index.html');
const LATEST_RELEASE_URL = 'https://chatquery.oss-cn-shenzhen.aliyuncs.com/chatquery/releases/latest.json';

async function main() {
  console.log('🌐 [Docker Build] 正在从阿里云 OSS 拉取最新版本元数据 (latest.json)...');

  let releaseData = null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${LATEST_RELEASE_URL}?t=${Date.now()}`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      releaseData = await res.json();
      console.log(`✓ 成功获取远程最新版本信息: v${releaseData.version}`);
    } else {
      console.warn(`⚠️ 获取 latest.json 失败 (HTTP ${res.status})，将保留本地已有配置。`);
    }
  } catch (err) {
    console.warn(`⚠️ 无法连接远程 OSS latest.json (${err.message})，将使用本地默认配置进行构建。`);
  }

  if (!fs.existsSync(INDEX_HTML_PATH)) {
    console.error(`❌ 未找到目标文件: ${INDEX_HTML_PATH}`);
    process.exit(1);
  }

  let html = fs.readFileSync(INDEX_HTML_PATH, 'utf-8');

  if (releaseData && releaseData.version) {
    const versionStr = `v${releaseData.version.replace(/^v/, '')}`;

    // 1. 替换导航栏与标牌上的版本号
    html = html.replace(/<span class="brand-pill">v[^<]+<\/span>/g, `<span class="brand-pill">${versionStr}</span>`);

    // 2. 替换 Hero 元信息
    html = html.replace(/<span id="heroVersionLabel">[^<]+<\/span>/, `<span id="heroVersionLabel">最新版本 ${versionStr} 已就绪</span>`);

    // 3. 提取并替换各平台下载链接
    const files = releaseData.files || [];
    const macArm = files.find(f => f.name.includes('aarch64') || f.name.includes('arm64') || (f.platform && f.platform.includes('arm')));
    const macIntel = files.find(f => f.name.endsWith('.dmg') && !f.name.includes('aarch64') && !f.name.includes('arm64'));
    const winSetup = files.find(f => f.name.includes('setup.exe') || (f.name.endsWith('.exe') && !f.name.includes('绿色') && !f.name.includes('portable')));
    const winPortable = files.find(f => f.name.includes('绿色') || f.name.includes('portable'));

    if (macArm?.url) {
      html = html.replace(/(id="linkMacArm"\s+href=")[^"]+(")/, `$1${macArm.url}$2`);
      const sizeText = macArm.size ? `${macArm.size} · .dmg 镜像` : '.dmg 镜像';
      html = html.replace(/(id="linkMacArm"[\s\S]*?id="sizeMacArm">)[^<]+(<\/div>)/, `$1${sizeText}$2`);
      // 默认主按钮回退为 Mac 格式
      html = html.replace(/(id="heroDownloadBtn"\s+href=")[^"]+(")/, `$1${macArm.url}$2`);
      html = html.replace(/(id="heroDownloadText">)[^<]+(<\/span>)/, `$1下载 macOS 版 (${macArm.size || versionStr})$2`);
    }

    if (macIntel?.url) {
      html = html.replace(/(id="linkMacIntel"\s+href=")[^"]+(")/, `$1${macIntel.url}$2`);
      const sizeText = macIntel.size ? `${macIntel.size} · .dmg 镜像` : '.dmg 镜像';
      html = html.replace(/(id="linkMacIntel"[\s\S]*?id="sizeMacIntel">)[^<]+(<\/div>)/, `$1${sizeText}$2`);
    }

    if (winSetup?.url) {
      html = html.replace(/(id="linkWinSetup"\s+href=")[^"]+(")/, `$1${winSetup.url}$2`);
      const sizeText = winSetup.size ? `${winSetup.size} · .exe 安装包` : '.exe 安装包';
      html = html.replace(/(id="linkWinSetup"[\s\S]*?id="sizeWinSetup">)[^<]+(<\/div>)/, `$1${sizeText}$2`);
    }

    if (winPortable?.url) {
      html = html.replace(/(id="linkWinPortable"\s+href=")[^"]+(")/, `$1${winPortable.url}$2`);
      const sizeText = winPortable.size ? `${winPortable.size} · 免安装直接运行` : '免安装直接运行';
      html = html.replace(/(id="linkWinPortable"[\s\S]*?id="sizeWinPortable">)[^<]+(<\/div>)/, `$1${sizeText}$2`);
    }

    fs.writeFileSync(INDEX_HTML_PATH, html, 'utf-8');
    console.log(`✓ 成功将最新版本 ${versionStr} 及下载链接静态注入到 index.html 中！`);
  } else {
    console.log('ℹ️ 使用现有静态版本配置进行打包构建');
  }
}

main().catch(err => {
  console.error('❌ 执行注入异常:', err);
  process.exit(1);
});
