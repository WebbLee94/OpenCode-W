#!/usr/bin/env node
/**
 * 生成 Tauri v2 updater 所需的 latest.json 静态清单文件。
 *
 * 用法: node scripts/generate-latest-json.mjs <tag> <artifacts-dir>
 *
 * 遍历构建产物目录，收集各平台的 updater artifact 及其 .sig 签名，
 * 生成符合 Tauri v2 updater 规范的 JSON 文件供 GitHub Releases 托管。
 *
 * @see https://tauri.app/plugin/updater/#static-json-file
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const [tag, artifactsDir] = process.argv.slice(2);

if (!tag || !artifactsDir) {
  console.error('用法: node scripts/generate-latest-json.mjs <tag> <artifacts-dir>');
  process.exit(1);
}

const version = tag.replace(/^v/, '');
const repo = process.env.GITHUB_REPOSITORY;
const baseUrl = `https://github.com/${repo}/releases/download/${tag}`;

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

/**
 * 根据 updater artifact 文件名推断 Tauri target (OS-ARCH)。
 * 仅纳入 updater 实际使用的产物，跳过 .dmg/.deb/.rpm/.msi 等安装包。
 *
 * 注意：当前 macOS 构建目标为 aarch64 (Apple Silicon)。
 */
function detectTarget(artifactName) {
  if (artifactName.endsWith('.app.tar.gz')) return 'darwin-aarch64';
  if (artifactName.endsWith('-setup.exe')) return 'windows-x86_64';
  if (artifactName.endsWith('.AppImage')) return 'linux-x86_64';
  return null;
}

const sigFiles = findFiles(artifactsDir, (name) => name.endsWith('.sig'));
const platforms = {};

for (const sigFile of sigFiles) {
  const artifactPath = sigFile.replace(/\.sig$/, '');
  const artifactName = basename(artifactPath);
  const target = detectTarget(artifactName);
  if (!target) continue;

  const signature = readFileSync(sigFile, 'utf8').trim();
  platforms[target] = {
    signature,
    url: `${baseUrl}/${artifactName}`,
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
