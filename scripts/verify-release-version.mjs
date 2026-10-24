#!/usr/bin/env node
/**
 * 断言「tag 版本 == 产物版本」。
 *
 * 用法: node scripts/verify-release-version.mjs <tag> [repo-root]
 *
 * 为什么需要这道守卫：
 * - `scripts/generate-latest-json.mjs` 写进 latest.json 的 `version` 取自 **git tag**；
 * - 真正打进二进制的版本来自 `src-tauri/tauri.conf.json` 的 `version`，
 *   Release 资产的文件名里带的也是这个版本（例如 macOS 资产重命名步骤就是从
 *   tauri.conf.json 读 version）。
 *
 * 如果打 tag 时忘了同步 `tauri.conf.json` / `Cargo.toml` / `package.json`，
 * 清单就会写「1.4.1」而用户装的包其实还是「1.4.0」：
 * updater 的 `should_update` 永远为真 -> 用户每次检查都被告知「发现新版本 v1.4.1」，
 * 装完什么也没变，形成无限更新循环。发布流水线上原本没有任何守卫能拦住它。
 *
 * 因此这里在生成清单之前断言三处版本彼此一致，且都等于 tag 去掉 `v` 前缀后的值。
 * 任一不一致就打印 `::error::` 注解并以非 0 退出码结束，让 Release 不被创建。
 *
 * （`src-tauri/Cargo.lock` 里 opencode-w 包的 version 由 cargo 自动同步，不在此断言。）
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 合法 semver（不含 `v` 前缀），与 verify-latest-json.mjs 保持一致。 */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * 从 Cargo.toml 的 `[package]` 段里取出 version。
 *
 * 只认 `[package]` 段本身：`[package.metadata]` 之类的子表不属于包元数据段，
 * 解析到下一个段头就停止，避免误取其它段里的 version 字段。
 *
 * @param {string} cargoToml Cargo.toml 原文
 * @returns {string | null} version 值；取不到时返回 null
 */
export function parseCargoPackageVersion(cargoToml) {
  const lines = cargoToml.split(/\r?\n/);
  let inPackageSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inPackageSection = trimmed === '[package]';
      continue;
    }
    if (!inPackageSection) continue;
    const match = /^version\s*=\s*"([^"]*)"/.exec(trimmed);
    if (match) return match[1];
  }

  return null;
}

/**
 * 读取三处版本号。
 *
 * @param {string} root 仓库根目录
 * @returns {{ tauri: string | null, cargo: string | null, pkg: string | null }}
 */
export function readReleaseVersions(root) {
  const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');

  let tauri = null;
  try {
    const parsed = JSON.parse(read('src-tauri/tauri.conf.json'));
    tauri = typeof parsed?.version === 'string' ? parsed.version : null;
  } catch {
    tauri = null;
  }

  let cargo = null;
  try {
    cargo = parseCargoPackageVersion(read('src-tauri/Cargo.toml'));
  } catch {
    cargo = null;
  }

  let pkg = null;
  try {
    const parsed = JSON.parse(read('package.json'));
    pkg = typeof parsed?.version === 'string' ? parsed.version : null;
  } catch {
    pkg = null;
  }

  return { tauri, cargo, pkg };
}

/**
 * 校验三处版本与 tag 的一致性。
 *
 * @param {{ tag: string, versions: { tauri: string | null, cargo: string | null, pkg: string | null } }} input
 * @returns {string[]} 错误列表，空数组表示通过
 */
export function verifyReleaseVersion({ tag, versions }) {
  const errors = [];

  if (typeof tag !== 'string' || tag.trim().length === 0) {
    errors.push('拿不到 tag，无法判断产物版本是否与 tag 一致');
    return errors;
  }

  const expected = tag.replace(/^v/, '');
  if (!SEMVER_PATTERN.test(expected)) {
    errors.push(`tag "${tag}" 推出的版本 "${expected}" 不是合法 semver`);
  }

  const sources = [
    ['src-tauri/tauri.conf.json', versions.tauri],
    ['src-tauri/Cargo.toml', versions.cargo],
    ['package.json', versions.pkg],
  ];

  for (const [name, value] of sources) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      errors.push(`${name} 里没有读到 version`);
      continue;
    }
    if (value !== expected) {
      errors.push(`${name} 的 version 是 "${value}"，与 tag "${tag}" 推出的 "${expected}" 不一致`);
    }
  }

  return errors;
}

/** CLI 入口。 */
function main(argv) {
  const [tag, rootArgument] = argv;
  if (!tag) {
    console.error('用法: node scripts/verify-release-version.mjs <tag> [repo-root]');
    return 1;
  }

  const root = resolve(process.cwd(), rootArgument ?? '.');
  const versions = readReleaseVersions(root);
  const errors = verifyReleaseVersion({ tag, versions });

  if (errors.length > 0) {
    console.error(`✗ 版本一致性校验未通过（${errors.length} 项）:`);
    for (const error of errors) console.error(`::error::${error}`);
    console.error(
      '  提示：打 tag 前必须把 src-tauri/tauri.conf.json、src-tauri/Cargo.toml 与 ' +
        'package.json 的 version 同步成与 tag 一致的值，否则 updater 会陷入无限更新循环。',
    );
    return 1;
  }

  console.log(
    `✓ 版本一致：tag ${tag} == ${versions.tauri} ` +
      '(src-tauri/tauri.conf.json / src-tauri/Cargo.toml / package.json)',
  );
  return 0;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  process.exit(main(process.argv.slice(2)));
}
