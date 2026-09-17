#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// 优先从 frontend 目录加载 ali-oss
const require = createRequire(path.join(ROOT_DIR, 'frontend', 'package.json'));

let OSS;
try {
  const ossModule = require('ali-oss');
  OSS = ossModule.default || ossModule;
} catch {
  try {
    const fallbackModule = await import('ali-oss');
    OSS = fallbackModule.default || fallbackModule;
  } catch {
    console.error('❌ 未找到 ali-oss 依赖。请先在项目根目录运行:');
    console.error('   npm --prefix frontend install');
    process.exit(1);
  }
}

// 简易解析 .env 文件（避免引入额外依赖）
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf-8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

// 加载环境变量：进程环境变量 > .env.oss > .env
const envFromFile = {
  ...loadEnvFile(path.join(ROOT_DIR, '.env')),
  ...loadEnvFile(path.join(ROOT_DIR, '.env.oss')),
};

function getEnv(key, defaultVal = '') {
  return process.env[key] || envFromFile[key] || defaultVal;
}

// 命令行参数解析
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return null;
}

// 获取发布版本号
function resolveVersion() {
  const argVer = getArgValue('--version');
  if (argVer) return argVer.replace(/^v/, '');

  if (process.env.RELEASE_VERSION) {
    return process.env.RELEASE_VERSION.replace(/^v/, '');
  }

  // 检查 CI 中的 tag 环境变量 (GitHub Actions 或 Azure Pipelines)
  const gitTag = process.env.GITHUB_REF_NAME || process.env.BUILD_SOURCEBRANCHNAME;
  if (gitTag && gitTag.startsWith('v')) {
    return gitTag.replace(/^v/, '');
  }

  // 从 src-tauri/tauri.conf.json 获取
  const tauriConfPath = path.join(ROOT_DIR, 'src-tauri', 'tauri.conf.json');
  if (fs.existsSync(tauriConfPath)) {
    try {
      const conf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf-8'));
      if (conf.version) return conf.version;
    } catch {
      // ignore
    }
  }

  return '0.1.0';
}

// 计算文件的 SHA256 哈希值与大小
function getFileInfo(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(fileBuffer);
  const sha256 = hashSum.digest('hex');
  const stats = fs.statSync(filePath);
  return {
    size: stats.size,
    sizeFormatted: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
    sha256,
  };
}

// 扫描所有已构建好的桌面安装包和免安装程序
function scanArtifacts() {
  const artifacts = [];
  const bundleDir = path.join(ROOT_DIR, 'src-tauri', 'target', 'release', 'bundle');
  const releaseDir = path.join(ROOT_DIR, 'src-tauri', 'target', 'release');

  // 1. Windows NSIS 安装包与绿色便携版
  const nsisDir = path.join(bundleDir, 'nsis');
  if (fs.existsSync(nsisDir)) {
    const files = fs.readdirSync(nsisDir);
    for (const f of files) {
      if (f.endsWith('.exe')) {
        artifacts.push({
          platform: f.includes('免安装') || f.includes('portable') ? 'windows-portable' : 'windows-installer',
          name: f,
          filePath: path.join(nsisDir, f),
        });
      }
    }
  }

  // 如果 release 目录下有编译好的 chatquery.exe 但 nsis 目录没有绿色版，则检查并归集
  const rawExe = path.join(releaseDir, 'chatquery.exe');
  if (fs.existsSync(rawExe)) {
    const alreadyHasPortable = artifacts.some(a => a.name.includes('免安装') || a.name.includes('portable'));
    if (!alreadyHasPortable) {
      const portableName = '智询_免安装绿色版.exe';
      const targetPortable = path.join(nsisDir, portableName);
      if (fs.existsSync(nsisDir)) {
        fs.copyFileSync(rawExe, targetPortable);
        artifacts.push({
          platform: 'windows-portable',
          name: portableName,
          filePath: targetPortable,
        });
      }
    }
  }

  // 2. macOS DMG 安装包
  const dmgDir = path.join(bundleDir, 'dmg');
  if (fs.existsSync(dmgDir)) {
    const files = fs.readdirSync(dmgDir);
    for (const f of files) {
      // 忽略临时文件如 rw.*.dmg
      if (f.endsWith('.dmg') && !f.startsWith('rw.')) {
        artifacts.push({
          platform: f.includes('aarch64') || f.includes('arm64') ? 'macos-arm64' : 'macos-x64',
          name: f,
          filePath: path.join(dmgDir, f),
        });
      }
    }
  }

  // 3. Linux AppImage / Deb (若有)
  const appImageDir = path.join(bundleDir, 'appimage');
  if (fs.existsSync(appImageDir)) {
    const files = fs.readdirSync(appImageDir);
    for (const f of files) {
      if (f.endsWith('.AppImage')) {
        artifacts.push({
          platform: 'linux-appimage',
          name: f,
          filePath: path.join(appImageDir, f),
        });
      }
    }
  }

  return artifacts;
}

// 推断 Content-Type
function getContentType(filename) {
  if (filename.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  if (filename.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (filename.endsWith('.zip')) return 'application/zip';
  if (filename.endsWith('.tar.gz')) return 'application/gzip';
  if (filename.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filename.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

async function main() {
  console.log('====================================================');
  console.log('🚀 智询 (ChatQuery) 安装包自动发布 -> 阿里云 OSS');
  console.log('====================================================');

  const version = resolveVersion();
  const versionTag = `v${version}`;
  const prefix = (getArgValue('--prefix') || getEnv('OSS_PREFIX', 'chatquery/releases')).replace(/\/+$/, '');

  console.log(`📦 当前发布版本: \x1b[32m${versionTag}\x1b[0m`);
  console.log(`📁 存储路径前缀: \x1b[36m${prefix}\x1b[0m`);
  if (isDryRun) {
    console.log(`⚠️  当前运行模式: \x1b[33mDRY-RUN (仅预览，不实际连接与上传)\x1b[0m\n`);
  }

  // 扫描本地构建产物
  const artifacts = scanArtifacts();
  if (artifacts.length === 0) {
    console.error('⚠️  未扫描到任何待发布的安装包产物！');
    console.error('   请先运行打包命令:');
    console.error('   macOS:   npx --prefix frontend tauri build');
    console.error('   Windows: npx --prefix frontend tauri build --bundles nsis');
    process.exit(1);
  }

  console.log(`🔍 扫描到 ${artifacts.length} 个待发布产物:`);
  for (const art of artifacts) {
    const info = getFileInfo(art.filePath);
    art.size = info.size;
    art.sizeFormatted = info.sizeFormatted;
    art.sha256 = info.sha256;
    console.log(`   - [${art.platform}] ${art.name} (${art.sizeFormatted})`);
    console.log(`     SHA256: ${art.sha256}`);
  }
  console.log('');

  // 准备配置
  const accessKeyId = getEnv('OSS_ACCESS_KEY_ID');
  const accessKeySecret = getEnv('OSS_ACCESS_KEY_SECRET');
  const bucket = getEnv('OSS_BUCKET');
  const region = getEnv('OSS_REGION', 'oss-cn-hangzhou');
  const endpoint = getEnv('OSS_ENDPOINT', `https://${region}.aliyuncs.com`);
  const publicDomain = (getEnv('OSS_PUBLIC_DOMAIN') || `https://${bucket}.${region}.aliyuncs.com`).replace(/\/+$/, '');

  if (!isDryRun) {
    const missing = [];
    if (!accessKeyId) missing.push('OSS_ACCESS_KEY_ID');
    if (!accessKeySecret) missing.push('OSS_ACCESS_KEY_SECRET');
    if (!bucket) missing.push('OSS_BUCKET');

    if (missing.length > 0) {
      console.error('❌ 缺少必需的 OSS 配置环境变量: ' + missing.join(', '));
      console.error('   请在项目根目录创建 .env.oss 或在系统/CI 中配置上述环境变量。');
      console.error('   参考模板请查看项目根目录下的: .env.oss.example');
      process.exit(1);
    }
  }

  // 计算并生成 SHA256SUMS.txt
  const sha256Content = artifacts
    .map(a => `${a.sha256}  ${a.name}`)
    .join('\n') + '\n';
  const sha256FilePath = path.join(ROOT_DIR, 'src-tauri', 'target', 'release', 'SHA256SUMS.txt');
  fs.writeFileSync(sha256FilePath, sha256Content, 'utf-8');

  // 构建待上传清单
  const uploadList = [
    ...artifacts.map(a => ({
      localPath: a.filePath,
      ossKey: `${prefix}/${versionTag}/${a.name}`,
      contentType: getContentType(a.name),
      isImmutable: true,
      name: a.name,
      sizeFormatted: a.sizeFormatted,
      sha256: a.sha256,
      platform: a.platform,
    })),
    {
      localPath: sha256FilePath,
      ossKey: `${prefix}/${versionTag}/SHA256SUMS.txt`,
      contentType: 'text/plain; charset=utf-8',
      isImmutable: true,
      name: 'SHA256SUMS.txt',
      sizeFormatted: (Buffer.byteLength(sha256Content) / 1024).toFixed(1) + ' KB',
      sha256: crypto.createHash('sha256').update(sha256Content).digest('hex'),
      platform: 'checksum',
    },
  ];

  // 生成最新版本元数据清单 latest.json
  const latestManifest = {
    version: version,
    tag: versionTag,
    release_date: new Date().toISOString(),
    files: uploadList.map(item => ({
      name: item.name,
      platform: item.platform,
      size: item.sizeFormatted,
      sha256: item.sha256,
      url: `${publicDomain}/${item.ossKey}`,
    })),
  };

  const latestJsonPath = path.join(ROOT_DIR, 'src-tauri', 'target', 'release', 'latest.json');
  fs.writeFileSync(latestJsonPath, JSON.stringify(latestManifest, null, 2), 'utf-8');

  uploadList.push({
    localPath: latestJsonPath,
    ossKey: `${prefix}/latest.json`,
    contentType: 'application/json; charset=utf-8',
    isImmutable: false, // 每次发布更新，不得使用 immutable 缓存
    name: 'latest.json',
    sizeFormatted: (Buffer.byteLength(JSON.stringify(latestManifest)) / 1024).toFixed(1) + ' KB',
    sha256: crypto.createHash('sha256').update(JSON.stringify(latestManifest)).digest('hex'),
    platform: 'manifest',
  });

  if (isDryRun) {
    console.log('📋 [Dry-Run] 计划上传的对象清单:');
    for (const item of uploadList) {
      console.log(`   - 本地文件: ${item.localPath}`);
      console.log(`     目标 OSS: oss://${bucket || '<BUCKET>'}/${item.ossKey}`);
      console.log(`     公开 URL: ${publicDomain}/${item.ossKey}`);
      console.log(`     头部设置: Content-Type=${item.contentType}, Immutable=${item.isImmutable}`);
    }
    console.log('\n✨ Dry-run 模拟完成，所有产物校验通过！');
    return;
  }

  // 初始化 OSS Client
  console.log(`🔌 正在连接阿里云 OSS Bucket: \x1b[32m${bucket}\x1b[0m (${region})...`);
  const client = new OSS({
    accessKeyId,
    accessKeySecret,
    bucket,
    region,
    endpoint,
    secure: true,
  });

  const uploadResults = [];

  for (let i = 0; i < uploadList.length; i++) {
    const item = uploadList[i];
    const progressText = `[${i + 1}/${uploadList.length}]`;
    console.log(`\n⬆️  ${progressText} 正在上传: \x1b[36m${item.name}\x1b[0m (${item.sizeFormatted})...`);
    console.log(`   目标路径: ${item.ossKey}`);

    const headers = {
      'Content-Type': item.contentType,
      'Cache-Control': item.isImmutable
        ? 'public, max-age=31536000, immutable'
        : 'no-cache, max-age=0, must-revalidate',
    };

    try {
      const stats = fs.statSync(item.localPath);
      // 大于 5MB 采用分片并发上传
      if (stats.size > 5 * 1024 * 1024) {
        await client.multipartUpload(item.ossKey, item.localPath, {
          parallel: 4,
          partSize: 2 * 1024 * 1024,
          headers,
          progress: (p) => {
            process.stdout.write(`   上传进度: ${(p * 100).toFixed(1)}%\r`);
          },
        });
        console.log(`   上传进度: 100.0% [完成]`);
      } else {
        await client.put(item.ossKey, item.localPath, { headers });
        console.log(`   上传成功 [完成]`);
      }

      const publicUrl = `${publicDomain}/${item.ossKey}`;
      uploadResults.push({
        name: item.name,
        size: item.sizeFormatted,
        sha256: item.sha256,
        url: publicUrl,
        success: true,
      });
    } catch (err) {
      console.error(`❌ 上传失败: ${item.name}`, err);
      process.exit(1);
    }
  }

  console.log('\n====================================================');
  console.log('🎉 智询 (ChatQuery) 自动化发布成功！');
  console.log('====================================================');
  console.log(`版本号: ${versionTag}`);
  console.log(`版本元信息地址: ${publicDomain}/${prefix}/latest.json\n`);
  console.log('各平台正式下载地址:');
  for (const res of uploadResults) {
    if (res.name === 'latest.json') continue;
    console.log(`  - \x1b[1m${res.name}\x1b[0m:`);
    console.log(`    下载链接: \x1b[34m${res.url}\x1b[0m`);
    console.log(`    文件大小: ${res.size}`);
    console.log(`    SHA256:   ${res.sha256}`);
  }
  console.log('====================================================\n');
}

main().catch(err => {
  console.error('❌ 发布脚本执行异常:', err);
  process.exit(1);
});
