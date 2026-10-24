#!/usr/bin/env node
/**
 * 生成 Tauri v2 updater 所需的 latest.json 静态清单文件。
 *
 * 用法: node scripts/generate-latest-json.mjs <tag> <artifacts-dir>
 *
 * 平台 key 由「产物子目录名」显式决定 —— release.yml 的构建矩阵给每个条目带上一个
 * 明确的 platform key，并把产物上传到以该 key 命名的子目录：
 *
 *   <artifacts-dir>/darwin-aarch64   ->  "darwin-aarch64"
 *   <artifacts-dir>/darwin-x86_64   ->  "darwin-x86_64"
 *   <artifacts-dir>/windows-x86_64  ->  "windows-x86_64"
 *   <artifacts-dir>/linux-x86_64    ->  "linux-x86_64"
 *
 * 不再从文件名猜平台：macOS 的 updater 产物名固定是 `<product>.app.tar.gz`，
 * 完全不含架构信息，arm64 与 x86_64 同名。旧的 detectTarget() 只会返回
 * darwin-aarch64，Intel 包会被错标成 aarch64；而 key 写错时 updater 的 check()
 * 会直接抛 TargetsNotFound，前端又把它显示成「当前已是最新版本」，用户永远拿不到
 * 更新且看不到任何提示。
 *
 * @see https://tauri.app/plugin/updater/#static-json-file
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { REQUIRED_PLATFORM_KEYS } from './verify-latest-json.mjs';

const [tag, artifactsDir] = process.argv.slice(2);

if (!tag || !artifactsDir) {
  console.error('用法: node scripts/generate-latest-json.mjs <tag> <artifacts-dir>');
  process.exit(1);
}

const version = tag.replace(/^v/, '');
const repo = process.env.GITHUB_REPOSITORY;
if (!repo) {
  console.error('缺少 GITHUB_REPOSITORY 环境变量，无法拼出 Release 资产地址');
  process.exit(1);
}
const baseUrl = `https://github.com/${repo}/releases/download/${tag}`;

/**
 * 每个平台目录内「updater 产物」的判定规则。
 *
 * 平台 key 来自目录名，这里只负责在同一平台目录内挑出 updater 实际下载的那个包，
 * 规则与既有发布行为保持一致：
 *   - macOS  -> <product>.app.tar.gz（v2 updater 直接解包替换 .app）
 *   - Windows-> <name>-setup.exe（NSIS 安装器，v2 updater 支持直接运行 exe）
 *   - Linux  -> <name>.AppImage（v2 updater 原地替换 AppImage）
 * `.dmg` / `.deb` / `.msi` 等安装包不写进 manifest，但仍然作为 Release 资产上传。
 */
const UPDATER_ARTIFACT_SUFFIX = {
  'darwin-aarch64': '.app.tar.gz',
  'darwin-x86_64': '.app.tar.gz',
  'windows-x86_64': '-setup.exe',
  'linux-x86_64': '.AppImage',
};

/** 递归查找匹配的文件 */
function findFiles(dir, predicate) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(fullPath, predicate));
    } else if (predicate(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

/** 找到与产物对应的 .sig 签名文件（优先同名同级，其次同目录同 basename） */
function findSignature(platformDir, artifactPath) {
  const sibling = `${artifactPath}.sig`;
  if (existsSync(sibling)) return sibling;
  const name = basename(artifactPath);
  const matches = findFiles(
    platformDir,
    (fileName) => fileName.endsWith('.sig') && fileName.slice(0, -'.sig'.length) === name,
  );
  return matches[0] ?? null;
}

const platforms = {};
/** 资产名 -> 平台 key，用于检测两个平台抢同一个 Release 资产名 */
const assetOwners = new Map();

// 产物目录里出现了未知子目录，说明构建矩阵加了新平台但清单还没跟上，
// 或者子目录名拼错了。两种情况都必须在这里失败，而不是静默漏掉一个平台。
const knownKeys = new Set(REQUIRED_PLATFORM_KEYS);
const unknownDirs = readdirSync(artifactsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !knownKeys.has(entry.name))
  .map((entry) => entry.name);
if (unknownDirs.length > 0) {
  console.error(
    `产物目录里有未知的平台子目录: ${unknownDirs.join(', ')}\n` +
      `（平台 key 必须与 Tauri updater 的查表规则一致；新增平台时需同步更新 ` +
      `scripts/verify-latest-json.mjs 的 REQUIRED_PLATFORM_KEYS）`,
  );
  process.exit(1);
}

for (const platformKey of REQUIRED_PLATFORM_KEYS) {
  const platformDir = join(artifactsDir, platformKey);
  if (!existsSync(platformDir)) {
    console.error(
      `缺少平台产物目录: ${platformDir}\n` +
        `（release.yml 的构建矩阵应把每个平台的产物上传到以平台 key 命名的子目录）`,
    );
    process.exit(1);
  }

  const suffix = UPDATER_ARTIFACT_SUFFIX[platformKey];
  const candidates = findFiles(
    platformDir,
    (name) => name.endsWith(suffix) && !name.endsWith('.sig'),
  ).map((artifactPath) => ({
    artifactPath,
    signaturePath: findSignature(platformDir, artifactPath),
  }));

  const signed = candidates.filter((candidate) => candidate.signaturePath !== null);

  if (signed.length === 0) {
    console.error(
      `平台 ${platformKey} 下没有找到带 .sig 签名的 updater 产物（期望 ${platformDir} 下的 *${suffix}）`,
    );
    process.exit(1);
  }
  if (signed.length > 1) {
    console.error(
      `平台 ${platformKey} 下找到多个 updater 产物，无法确定用哪个: ${signed
        .map((candidate) => basename(candidate.artifactPath))
        .join(', ')}`,
    );
    process.exit(1);
  }

  const { artifactPath, signaturePath } = signed[0];
  const assetName = basename(artifactPath);

  const owner = assetOwners.get(assetName);
  if (owner) {
    console.error(
      `平台 ${owner} 与 ${platformKey} 指向同一个 Release 资产名 "${assetName}"，` +
        `上传时后一个会覆盖前一个；请确认 macOS 产物是否已被重命名为带平台 key 的唯一名字`,
    );
    process.exit(1);
  }
  assetOwners.set(assetName, platformKey);

  const signature = readFileSync(signaturePath, 'utf8').trim();
  if (!signature) {
    console.error(`平台 ${platformKey} 的签名文件为空: ${signaturePath}`);
    process.exit(1);
  }

  platforms[platformKey] = {
    signature,
    url: `${baseUrl}/${assetName}`,
  };
}

const latest = {
  version,
  notes: `OpenCode-W ${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
};

writeFileSync('latest.json', JSON.stringify(latest, null, 2) + '\n');
console.log('✓ 生成 latest.json:');
console.log(JSON.stringify(latest, null, 2));
