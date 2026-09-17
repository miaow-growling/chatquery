#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync, spawnSync } from 'node:child_process';

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
const shouldBuild = args.includes('--build');

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

// 对目标文件进行签名（使用本地私钥）
function ensureSignature(targetFile, privateKey, password = '') {
  const sigFile = `${targetFile}.sig`;
  if (fs.existsSync(sigFile)) {
    return fs.readFileSync(sigFile, 'utf-8').trim();
  }
  if (!privateKey) {
    return null;
  }
  try {
    console.log(`🔐 正在为更新包生成数字签名: ${path.basename(targetFile)}...`);
    const env = {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: privateKey,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
    };
    const cmd = `npx --prefix frontend tauri signer sign "${targetFile}"`;
    execSync(cmd, {
      cwd: ROOT_DIR,
      env,
      stdio: 'inherit',
    });
    if (fs.existsSync(sigFile)) {
      return fs.readFileSync(sigFile, 'utf-8').trim();
    }
  } catch (err) {
    console.warn(`⚠️  签名生成失败: ${targetFile}`, err);
  }
  return null;
}

// 如果需要，执行编译并自动注入签名私钥
function performBuildIfRequested(privateKey, password = '') {
  if (!shouldBuild) return;
  console.log('🔨 检测到 --build 参数，正在执行 Tauri 桌面打包...');
  const env = {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: privateKey || process.env.TAURI_SIGNING_PRIVATE_KEY || '',
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password || process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || '',
  };
  const isWin = process.platform === 'win32';
  const buildCmd = isWin
    ? 'npx --prefix frontend tauri build --bundles nsis'
    : 'npx --prefix frontend tauri build';

  execSync(buildCmd, {
    cwd: ROOT_DIR,
    env,
    stdio: 'inherit',
  });
  console.log('✅ Tauri 打包完成！\n');
}

// 扫描所有已构建好的桌面安装包、绿色版及自动更新增量包
function scanArtifacts(privateKey, password = '') {
  const artifacts = [];
  const updaterArtifacts = [];
  const bundleDir = path.join(ROOT_DIR, 'src-tauri', 'target', 'release', 'bundle');
  const releaseDir = path.join(ROOT_DIR, 'src-tauri', 'target', 'release');

  // 1. Windows NSIS 安装包与绿色便携版
  const nsisDir = path.join(bundleDir, 'nsis');
  if (fs.existsSync(nsisDir)) {
    const files = fs.readdirSync(nsisDir);
    for (const f of files) {
      if (f.endsWith('.exe')) {
        const fullPath = path.join(nsisDir, f);
        const isPortable = f.includes('免安装') || f.includes('portable');
        const art = {
          platform: isPortable ? 'windows-portable' : 'windows-installer',
          targetPlatform: 'windows-x86_64',
          name: f,
          filePath: fullPath,
        };
        artifacts.push(art);

        // 如果存在安装包的对应 .sig 签名或 .nsis.zip
        const sigFile = `${fullPath}.sig`;
        if (fs.existsSync(sigFile)) {
          art.signature = fs.readFileSync(sigFile, 'utf-8').trim();
          updaterArtifacts.push(art);
        }
      } else if (f.endsWith('.nsis.zip')) {
        // Tauri v2 NSIS 增量更新包
        const fullPath = path.join(nsisDir, f);
        const sigFile = `${fullPath}.sig`;
        let sig = fs.existsSync(sigFile) ? fs.readFileSync(sigFile, 'utf-8').trim() : null;
        if (!sig && privateKey) {
          sig = ensureSignature(fullPath, privateKey, password);
        }
        const art = {
          platform: 'windows-updater',
          targetPlatform: 'windows-x86_64',
          name: f,
          filePath: fullPath,
          signature: sig,
        };
        artifacts.push(art);
        updaterArtifacts.push(art);
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
      if (!fs.existsSync(nsisDir)) {
        fs.mkdirSync(nsisDir, { recursive: true });
      }
      fs.copyFileSync(rawExe, targetPortable);
      artifacts.push({
        platform: 'windows-portable',
        name: portableName,
        filePath: targetPortable,
      });
    }
  }

  // 2. macOS DMG 安装包与 .app.tar.gz 自动更新增量包
  const dmgDir = path.join(bundleDir, 'dmg');
  if (fs.existsSync(dmgDir)) {
    const files = fs.readdirSync(dmgDir);
    for (const f of files) {
      // 忽略临时文件如 rw.*.dmg
      if (f.endsWith('.dmg') && !f.startsWith('rw.')) {
        const isArm = f.includes('aarch64') || f.includes('arm64');
        artifacts.push({
          platform: isArm ? 'macos-arm64' : 'macos-x64',
          targetPlatform: isArm ? 'darwin-aarch64' : 'darwin-x86_64',
          name: f,
          filePath: path.join(dmgDir, f),
        });
      }
    }
  }

  const macosDir = path.join(bundleDir, 'macos');
  if (fs.existsSync(macosDir)) {
    // 检查是否有现有 .tar.gz 更新包
    const macosFiles = fs.readdirSync(macosDir);
    for (const f of macosFiles) {
      if (f.endsWith('.tar.gz')) {
        const fullPath = path.join(macosDir, f);
        const sigFile = `${fullPath}.sig`;
        let sig = fs.existsSync(sigFile) ? fs.readFileSync(sigFile, 'utf-8').trim() : null;
        if (!sig && privateKey) {
          sig = ensureSignature(fullPath, privateKey, password);
        }
        const isArm = f.includes('aarch64') || f.includes('arm64') || process.arch === 'arm64';
        const art = {
          platform: isArm ? 'macos-arm64-updater' : 'macos-x64-updater',
          targetPlatform: isArm ? 'darwin-aarch64' : 'darwin-x86_64',
          name: f,
          filePath: fullPath,
          signature: sig,
        };
        artifacts.push(art);
        updaterArtifacts.push(art);
      }
    }

    // 如果有 智询.app 但没有 .tar.gz，自动打包出 智询.app.tar.gz 供自动更新
    const hasTarGz = artifacts.some(a => a.name.endsWith('.app.tar.gz'));
    const appFolder = macosFiles.find(f => f.endsWith('.app'));
    if (!hasTarGz && appFolder) {
      const appPath = path.join(macosDir, appFolder);
      const isArm = process.arch === 'arm64';
      const tarGzName = `${appFolder}.tar.gz`;
      const tarGzPath = path.join(macosDir, tarGzName);
      try {
        console.log(`📦 正在生成 macOS 应用内增量更新包: ${tarGzName}...`);
        execSync(`tar -czf "${tarGzName}" "${appFolder}"`, { cwd: macosDir });
        let sig = null;
        if (privateKey) {
          sig = ensureSignature(tarGzPath, privateKey, password);
        }
        const art = {
          platform: isArm ? 'macos-arm64-updater' : 'macos-x64-updater',
          targetPlatform: isArm ? 'darwin-aarch64' : 'darwin-x86_64',
          name: tarGzName,
          filePath: tarGzPath,
          signature: sig,
        };
        artifacts.push(art);
        updaterArtifacts.push(art);
      } catch (err) {
        console.warn('⚠️  自动压缩 .app.tar.gz 失败:', err);
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
          targetPlatform: 'linux-x86_64',
          name: f,
          filePath: path.join(appImageDir, f),
        });
      }
    }
  }

  return { artifacts, updaterArtifacts };
}

// 推断 Content-Type
function getContentType(filename) {
  if (filename.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  if (filename.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (filename.endsWith('.zip')) return 'application/zip';
  if (filename.endsWith('.tar.gz')) return 'application/gzip';
  if (filename.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filename.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (filename.endsWith('.sig')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

async function main() {
  console.log('====================================================');
  console.log('🚀 智询 (ChatQuery) 自动化发布与应用内热更新 -> 阿里云 OSS');
  console.log('====================================================');

  const version = resolveVersion();
  const versionTag = `v${version}`;
  const prefix = (getArgValue('--prefix') || getEnv('OSS_PREFIX', 'chatquery/releases')).replace(/\/+$/, '');

  const privateKey = getEnv('TAURI_SIGNING_PRIVATE_KEY');
  const privateKeyPassword = getEnv('TAURI_SIGNING_PRIVATE_KEY_PASSWORD', '');

  // 若带 --build 参数，先打包并注入私钥
  performBuildIfRequested(privateKey, privateKeyPassword);

  console.log(`📦 当前发布版本: \x1b[32m${versionTag}\x1b[0m`);
  console.log(`📁 存储路径前缀: \x1b[36m${prefix}\x1b[0m`);
  if (privateKey) {
    console.log(`🔑 自动更新签名私钥: \x1b[32m已配置 (可生成防篡改签名)\x1b[0m`);
  } else {
    console.log(`⚠️  自动更新签名私钥: \x1b[33m未配置 (将无法生成新的 .sig 签名)\x1b[0m`);
  }
  if (isDryRun) {
    console.log(`⚠️  当前运行模式: \x1b[33mDRY-RUN (仅预览，不实际连接与上传)\x1b[0m\n`);
  }

  // 扫描本地构建产物
  const { artifacts, updaterArtifacts } = scanArtifacts(privateKey, privateKeyPassword);
  if (artifacts.length === 0) {
    console.error('⚠️  未扫描到任何待发布的安装包产物！');
    console.error('   请先运行打包命令:');
    console.error('   macOS:   npm run release:oss');
    console.error('   Windows: npm run release:oss');
    process.exit(1);
  }

  console.log(`🔍 本地扫描到 ${artifacts.length} 个新构建产物:`);
  for (const art of artifacts) {
    const info = getFileInfo(art.filePath);
    art.size = info.size;
    art.sizeFormatted = info.sizeFormatted;
    art.sha256 = info.sha256;
    console.log(`   - [${art.platform}] ${art.name} (${art.sizeFormatted})`);
    if (art.signature) {
      console.log(`     签名 (.sig): ${art.signature.slice(0, 32)}...`);
    }
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

  let client = null;
  if (!isDryRun) {
    client = new OSS({
      accessKeyId,
      accessKeySecret,
      bucket,
      region,
      endpoint,
      secure: true,
    });
  }

  // 1. 先上传本次本地构建的安装包二进制文件及对应签名文件
  const uploadedArtifacts = [];
  const filesToUpload = [...artifacts];

  // 检查是否有伴随的 .sig 文件需要上传
  for (const art of artifacts) {
    const sigPath = `${art.filePath}.sig`;
    if (fs.existsSync(sigPath) && !filesToUpload.some(f => f.filePath === sigPath)) {
      filesToUpload.push({
        name: `${art.name}.sig`,
        platform: 'signature',
        filePath: sigPath,
        sizeFormatted: '0.1 KB',
        sha256: crypto.createHash('sha256').update(fs.readFileSync(sigPath)).digest('hex'),
      });
    }
  }

  for (let i = 0; i < filesToUpload.length; i++) {
    const art = filesToUpload[i];
    const ossKey = `${prefix}/${versionTag}/${art.name}`;
    const progressText = `[${i + 1}/${filesToUpload.length}]`;
    console.log(`\n⬆️  ${progressText} 正在上传文件: \x1b[36m${art.name}\x1b[0m (${art.sizeFormatted})...`);
    console.log(`   目标路径: ${ossKey}`);

    const headers = {
      'Content-Type': getContentType(art.name),
      'Cache-Control': 'public, max-age=31536000, immutable',
    };

    if (!isDryRun && client) {
      try {
        const stats = fs.statSync(art.filePath);
        if (stats.size > 5 * 1024 * 1024) {
          await client.multipartUpload(ossKey, art.filePath, {
            parallel: 4,
            partSize: 2 * 1024 * 1024,
            headers,
            progress: (p) => {
              process.stdout.write(`   上传进度: ${(p * 100).toFixed(1)}%\r`);
            },
          });
          console.log(`   上传进度: 100.0% [完成]`);
        } else {
          await client.put(ossKey, art.filePath, { headers });
          console.log(`   上传成功 [完成]`);
        }
      } catch (err) {
        console.error(`❌ 上传失败: ${art.name}`, err);
        process.exit(1);
      }
    } else {
      console.log(`   [Dry-Run] 模拟上传完成`);
    }

    uploadedArtifacts.push({
      name: art.name,
      platform: art.platform,
      targetPlatform: art.targetPlatform,
      size: art.sizeFormatted,
      sha256: art.sha256,
      signature: art.signature,
      url: `${publicDomain}/${ossKey}`,
    });
  }

  // 2. 智能合并：获取 OSS 远端已有的 latest.json 与 SHA256SUMS.txt
  console.log(`\n🔄 正在检查远端已有清单并执行多平台智能合并...`);

  const sha256Key = `${prefix}/${versionTag}/SHA256SUMS.txt`;
  const latestKey = `${prefix}/latest.json`;

  const mergedSha256Map = new Map();
  const mergedFilesMap = new Map();
  const mergedUpdaterPlatforms = {};

  // 尝试拉取远程已有 latest.json
  let remoteLatest = null;
  if (!isDryRun && client) {
    try {
      const res = await client.get(latestKey);
      if (res && res.content) {
        remoteLatest = JSON.parse(res.content.toString('utf-8'));
      }
    } catch {
      // 404 说明首次发版，直接跳过
    }

    // 尝试拉取远程同版本的 SHA256SUMS.txt
    try {
      const resSha = await client.get(sha256Key);
      if (resSha && resSha.content) {
        const lines = resSha.content.toString('utf-8').split('\n');
        for (const line of lines) {
          const match = line.trim().match(/^([a-f0-9]{64})\s+(.+)$/i);
          if (match) {
            mergedSha256Map.set(match[2].trim(), match[1].toLowerCase());
          }
        }
      }
    } catch {
      // 忽略
    }
  }

  // 合并规则：
  // 如果远端的 latest.json 与当前构建版本相同，保留远端已有产物与 updater platforms
  if (remoteLatest && remoteLatest.version === version) {
    if (Array.isArray(remoteLatest.files)) {
      for (const f of remoteLatest.files) {
        if (f.name && f.name !== 'latest.json' && f.name !== 'SHA256SUMS.txt') {
          mergedFilesMap.set(f.name, f);
          if (f.sha256) {
            mergedSha256Map.set(f.name, f.sha256);
          }
        }
      }
    }
    if (remoteLatest.platforms && typeof remoteLatest.platforms === 'object') {
      for (const [pKey, pVal] of Object.entries(remoteLatest.platforms)) {
        if (pVal && pVal.signature && pVal.url) {
          mergedUpdaterPlatforms[pKey] = pVal;
        }
      }
    }
  }

  // 注入本次构建并上传的本地产物（同名产物更新覆盖，新平台产物追加合并）
  for (const item of uploadedArtifacts) {
    mergedFilesMap.set(item.name, item);
    if (item.sha256) {
      mergedSha256Map.set(item.name, item.sha256);
    }
    // 如果是自动更新包并带有签名，注入到 Tauri Updater 的 platforms 结构中
    if (item.targetPlatform && item.signature) {
      mergedUpdaterPlatforms[item.targetPlatform] = {
        signature: item.signature,
        url: item.url,
      };
    }
  }

  const allMergedFiles = Array.from(mergedFilesMap.values());
  console.log(`🤝 合并完成！当前 ${versionTag} 版本共聚合 ${allMergedFiles.length} 个跨平台产物:`);
  for (const f of allMergedFiles) {
    console.log(`   - [${f.platform}] ${f.name} (${f.size})`);
  }

  // 3. 生成并上传合并后的 SHA256SUMS.txt
  const mergedSha256Content = Array.from(mergedSha256Map.entries())
    .map(([name, hash]) => `${hash}  ${name}`)
    .join('\n') + '\n';

  const sha256FilePath = path.join(ROOT_DIR, 'src-tauri', 'target', 'release', 'SHA256SUMS.txt');
  fs.writeFileSync(sha256FilePath, mergedSha256Content, 'utf-8');

  console.log(`\n⬆️  正在同步更新合并后的校验文件: ${sha256Key}...`);
  if (!isDryRun && client) {
    await client.put(sha256Key, Buffer.from(mergedSha256Content, 'utf-8'), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, max-age=0, must-revalidate',
      },
    });
  }

  // 4. 生成并上传合并后的符合 Tauri v2 自动更新规范的 latest.json
  const mergedLatestManifest = {
    version,
    tag: versionTag,
    notes: `智询 (ChatQuery) ${versionTag} 官方发布版本。\n支持多平台自动更新与安装包一键安装。`,
    pub_date: new Date().toISOString(),
    platforms: mergedUpdaterPlatforms,
    files: [
      ...allMergedFiles,
      {
        name: 'SHA256SUMS.txt',
        platform: 'checksum',
        size: (Buffer.byteLength(mergedSha256Content) / 1024).toFixed(1) + ' KB',
        sha256: crypto.createHash('sha256').update(mergedSha256Content).digest('hex'),
        url: `${publicDomain}/${sha256Key}`,
      },
    ],
  };

  const latestJsonPath = path.join(ROOT_DIR, 'src-tauri', 'target', 'release', 'latest.json');
  fs.writeFileSync(latestJsonPath, JSON.stringify(mergedLatestManifest, null, 2), 'utf-8');

  console.log(`⬆️  正在发布合并后的版本元信息 (Tauri v2 Updater 兼容): ${latestKey}...`);
  if (!isDryRun && client) {
    await client.put(latestKey, Buffer.from(JSON.stringify(mergedLatestManifest, null, 2), 'utf-8'), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, max-age=0, must-revalidate',
      },
    });
  }

  console.log('\n====================================================');
  console.log('🎉 智询 (ChatQuery) 安装包与应用内自动更新发布成功！');
  console.log('====================================================');
  console.log(`版本号: ${versionTag}`);
  console.log(`Tauri 自动更新端点: ${publicDomain}/${latestKey}\n`);
  console.log('Tauri In-App Updater 签名平台列表:');
  for (const [targetKey, targetObj] of Object.entries(mergedUpdaterPlatforms)) {
    console.log(`  - \x1b[32m${targetKey}\x1b[0m:`);
    console.log(`    下载包: ${targetObj.url}`);
    console.log(`    签名:   ${targetObj.signature.slice(0, 32)}...`);
  }

  console.log('\n全平台下载直链清单:');
  for (const res of allMergedFiles) {
    if (res.name.endsWith('.sig')) continue;
    console.log(`  - \x1b[1m[${res.platform}] ${res.name}\x1b[0m:`);
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
