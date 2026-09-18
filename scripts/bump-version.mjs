#!/usr/bin/env node

/**
 * 智询 (ChatQuery) 智能版本号与发布更新自动化脚本
 *
 * 支持三种模式:
 *   1. 全自动模式 (推荐):
 *      npm run bump           -> 自动扫描 Git Commit 规范 (feat/fix/BREAKING) 智能推断版本，并自动提取更新日志写入 RELEASE_NOTES.md
 *   2. 语义化级别模式:
 *      npm run bump patch     -> 自动升补丁版本号 (0.1.0 -> 0.1.1)
 *      npm run bump minor     -> 自动升次版本号 (0.1.0 -> 0.2.0)
 *      npm run bump major     -> 自动升主版本号 (0.1.0 -> 1.0.0)
 *   3. 显式指定版本模式:
 *      npm run bump 0.2.0     -> 强制指定版本号为 0.2.0
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// 1. 读取当前基准版本号 (从 tauri.conf.json)
function getCurrentVersion() {
  const tauriConfPath = path.join(ROOT_DIR, 'src-tauri', 'tauri.conf.json');
  if (fs.existsSync(tauriConfPath)) {
    const conf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf-8'));
    if (conf.version) return conf.version;
  }
  return '0.1.0';
}

const currentVersion = getCurrentVersion();
let [major, minor, patch] = currentVersion.split('.').map(Number);
if (isNaN(major)) major = 0;
if (isNaN(minor)) minor = 1;
if (isNaN(patch)) patch = 0;

// 2. 解析运行参数
let arg = process.argv[2]?.trim().toLowerCase().replace(/^v/, '');

let bumpType = 'patch';
let targetVersion = '';
let autoAnalyze = false;

if (!arg || arg === 'auto') {
  autoAnalyze = true;
} else if (arg === 'patch' || arg === 'minor' || arg === 'major') {
  bumpType = arg;
} else if (/^\d+\.\d+\.\d+.*$/.test(arg)) {
  targetVersion = arg;
} else {
  console.error(`❌ 参数不合法: "${arg}"\n可选用法: npm run bump [auto | patch | minor | major | <指定版本号>]`);
  process.exit(1);
}

// 3. 全自动分析 Git 提交记录
let detectedChangelog = [];

if (autoAnalyze) {
  console.log(`🔍 正在扫描最近的 Git 提交记录推断新版本与提取更新说明...`);
  try {
    // 获取最近的 tag（如果有的话），否则默认拉取最近 15 次提交
    let range = 'HEAD~15..HEAD';
    try {
      const latestTag = execSync('git describe --tags --abbrev=0', { cwd: ROOT_DIR, encoding: 'utf-8' }).trim();
      if (latestTag) {
        range = `${latestTag}..HEAD`;
      }
    } catch {
      range = '-n 15';
    }

    const logOutput = execSync(`git log ${range} --pretty=format:"%h|%s"`, {
      cwd: ROOT_DIR,
      encoding: 'utf-8',
    }).trim();

    const lines = logOutput.split('\n').filter(Boolean);
    let hasBreaking = false;
    let hasFeat = false;
    let hasFix = false;

    for (const line of lines) {
      const [hash, ...msgParts] = line.split('|');
      const msg = msgParts.join('|').trim();

      // 忽略自动发版自身的 chore commit
      if (/^chore\(release\)|^chore\(backup\)/i.test(msg)) {
        continue;
      }

      if (/BREAKING CHANGE/i.test(msg) || /^[a-z]+(\([^\)]+\))?!:/i.test(msg)) {
        hasBreaking = true;
        detectedChangelog.push(`• 🚨 破坏性变更: ${msg} (${hash})`);
      } else if (/^feat/i.test(msg)) {
        hasFeat = true;
        const cleanMsg = msg.replace(/^feat(\([^\)]+\))?:\s*/i, '');
        detectedChangelog.push(`• 🚀 新增: ${cleanMsg}`);
      } else if (/^fix/i.test(msg)) {
        hasFix = true;
        const cleanMsg = msg.replace(/^fix(\([^\)]+\))?:\s*/i, '');
        detectedChangelog.push(`• 🐞 修复: ${cleanMsg}`);
      } else if (/^(perf|style|refactor)/i.test(msg)) {
        const cleanMsg = msg.replace(/^[a-z]+(\([^\)]+\))?:\s*/i, '');
        detectedChangelog.push(`• ⚡ 优化: ${cleanMsg}`);
      }
    }

    if (hasBreaking) {
      bumpType = 'major';
      console.log(`  ➔ 检测到破坏性变更，自动选择升级 [主版本号 (Major)]`);
    } else if (hasFeat) {
      bumpType = 'minor';
      console.log(`  ➔ 检测到新增功能 (feat)，自动选择升级 [次版本号 (Minor)]`);
    } else {
      bumpType = 'patch';
      console.log(`  ➔ 未检测到新功能，自动选择升级 [修订补丁号 (Patch)]`);
    }
  } catch (err) {
    console.warn(`⚠️ Git 日志读取受限，默认回退为 patch 升级`);
    bumpType = 'patch';
  }
}

// 4. 计算新版本号
if (!targetVersion) {
  if (bumpType === 'major') {
    targetVersion = `${major + 1}.0.0`;
  } else if (bumpType === 'minor') {
    targetVersion = `${major}.${minor + 1}.0`;
  } else {
    targetVersion = `${major}.${minor}.${patch + 1}`;
  }
}

console.log(`\n======================================================`);
console.log(`📌 当前版本: v${currentVersion}`);
console.log(`✨ 目标版本: v${targetVersion} (${bumpType.toUpperCase()} 升级)`);
console.log(`======================================================\n`);

// 5. 更新所有版本文件
const filesToUpdate = [
  {
    path: path.join(ROOT_DIR, 'src-tauri', 'tauri.conf.json'),
    update: (content) => content.replace(/"version":\s*"[^"]+"/, `"version": "${targetVersion}"`),
    label: 'src-tauri/tauri.conf.json',
  },
  {
    path: path.join(ROOT_DIR, 'Cargo.toml'),
    update: (content) => content.replace(/(\[package\][\s\S]*?version\s*=\s*)"[^"]+"/, `$1"${targetVersion}"`),
    label: 'Cargo.toml',
  },
  {
    path: path.join(ROOT_DIR, 'src-tauri', 'Cargo.toml'),
    update: (content) => content.replace(/(\[package\][\s\S]*?version\s*=\s*)"[^"]+"/, `$1"${targetVersion}"`),
    label: 'src-tauri/Cargo.toml',
  },
  {
    path: path.join(ROOT_DIR, 'frontend', 'package.json'),
    update: (content) => content.replace(/"version":\s*"[^"]+"/, `"version": "${targetVersion}"`),
    label: 'frontend/package.json',
  },
  {
    path: path.join(ROOT_DIR, 'frontend', 'src', 'App.tsx'),
    update: (content) => content.replace(/const CURRENT_APP_VERSION = "[^"]+";/, `const CURRENT_APP_VERSION = "${targetVersion}";`),
    label: 'frontend/src/App.tsx',
  },
  {
    path: path.join(ROOT_DIR, 'website', 'index.html'),
    update: (content) => content.replace(/<span class="brand-pill">v[^<]+<\/span>/, `<span class="brand-pill">v${targetVersion}</span>`),
    label: 'website/index.html (官网展示)',
    optional: true,
  },
];

let updatedCount = 0;
for (const item of filesToUpdate) {
  if (!fs.existsSync(item.path)) continue;
  const oldText = fs.readFileSync(item.path, 'utf-8');
  const newText = item.update(oldText);
  if (oldText !== newText) {
    fs.writeFileSync(item.path, newText, 'utf-8');
    console.log(`  ✓ 已更新: ${item.label}`);
    updatedCount++;
  } else {
    console.log(`  - 无变动 (已是目标版本): ${item.label}`);
  }
}

// 6. 如果自动解析到了更新日志，自动更新写入 RELEASE_NOTES.md
const releaseNotesPath = path.join(ROOT_DIR, 'RELEASE_NOTES.md');
if (detectedChangelog.length > 0) {
  const notesHeader = `# 智询 (ChatQuery) v${targetVersion} 更新日志\n# 运行发布命令时会自动读取并下发给所有用户客户端！\n\n`;
  const generatedNotes = notesHeader + detectedChangelog.join('\n') + '\n';
  fs.writeFileSync(releaseNotesPath, generatedNotes, 'utf-8');
  console.log(`  ✓ 已自动从 Git 提交记录生成并更新: RELEASE_NOTES.md`);
}

console.log(`\n🎉 自动化升级完毕！所有项目配置已就绪。`);
console.log(`\n💡 接下来你可以:`);
console.log(`  • 查看/微调 RELEASE_NOTES.md 中的更新日志`);
console.log(`  • 运行发版命令: npm run release:oss 即可一键完成全平台打包、签名并推送到阿里云 OSS！\n`);
