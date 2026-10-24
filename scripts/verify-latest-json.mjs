#!/usr/bin/env node
/**
 * 校验 Tauri v2 updater 的静态清单 latest.json。
 *
 * 用法: node scripts/verify-latest-json.mjs [latest.json 路径] [期望的 version]
 *
 * 为什么要单独校验：
 * Tauri updater 按 `{os}-{arch}` 查表（tauri-plugin-updater 的 `get_urls()`：
 * 先试 `{os}-{arch}-{installer}`，再回落 `{os}-{arch}`），且 macOS 的 os 是
 * `darwin` 而不是 `macos`。key 写错时 `check()` 会在 `should_update` 之前直接抛
 * `TargetsNotFound`，而前端的错误分类会把它显示成「当前已是最新版本」——该平台
 * 用户永远拿不到更新且看不到任何提示。所以清单必须在发布前被断言拦住。
 *
 * 断言清单：
 *  1. manifest 是 JSON 对象
 *  2. version 存在、是字符串、是无 `v` 前缀的合法 semver
 *  3. notes 存在且是非空字符串
 *  4. pub_date 存在且是可解析的 ISO-8601 时间
 *  5. platforms 恰好包含 REQUIRED_PLATFORM_KEYS 里的 4 个 key（不多不少）
 *  6. 每个 key 的 signature / url 都是非空字符串
 *  7. key 拼写符合 updater 查表规则：os 只能是 darwin / windows / linux
 *     （出现 `macos-*` 会被单独点名报错）
 *  8. url 是指向 Release 资产的 https 绝对地址
 *  9. 各平台的 url 互不相同（避免两个平台抢同一个 Release 资产名）
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** updater 必须覆盖的平台 key（`{os}-{arch}`）。 */
export const REQUIRED_PLATFORM_KEYS = Object.freeze([
  'darwin-aarch64',
  'darwin-x86_64',
  'windows-x86_64',
  'linux-x86_64',
]);

/** `updater_os()` 的合法取值：macOS 是 darwin，`macos` 不是合法前缀。 */
export const VALID_OS_PREFIXES = Object.freeze(['darwin', 'windows', 'linux']);

/** 合法 semver（不含 `v` 前缀）。 */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * 校验 latest.json 内容。
 *
 * @param {unknown} manifest 解析后的 JSON
 * @param {{ expectedVersion?: string }} [options]
 * @returns {string[]} 错误列表，空数组表示通过
 */
export function verifyLatestJson(manifest, options = {}) {
  const errors = [];
  const fail = (message) => errors.push(message);

  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('latest.json 顶层必须是 JSON 对象');
    return errors;
  }

  // 1. version
  const { version } = /** @type {Record<string, unknown>} */ (manifest);
  if (typeof version !== 'string' || version.length === 0) {
    fail('version 字段缺失或不是非空字符串');
  } else {
    if (version.startsWith('v')) {
      fail(`version "${version}" 不允许带 "v" 前缀（updater 的版本比较按纯 semver 进行）`);
    }
    if (!SEMVER_PATTERN.test(version)) {
      fail(`version "${version}" 不是合法 semver`);
    }
    // 期望值允许写成 tag（v1.4.0）或纯版本号（1.4.0）
    const expectedVersion = options.expectedVersion?.replace(/^v/, '');
    if (expectedVersion && version !== expectedVersion) {
      fail(`version "${version}" 与期望的 "${expectedVersion}" 不一致`);
    }
  }

  // 2. notes
  const { notes } = /** @type {Record<string, unknown>} */ (manifest);
  if (typeof notes !== 'string' || notes.trim().length === 0) {
    fail('notes 字段缺失或不是非空字符串');
  }

  // 3. pub_date
  const { pub_date: pubDate } = /** @type {Record<string, unknown>} */ (manifest);
  if (typeof pubDate !== 'string' || Number.isNaN(Date.parse(pubDate))) {
    fail('pub_date 字段缺失或不是可解析的 ISO-8601 时间');
  }

  // 4. platforms
  const { platforms } = /** @type {Record<string, unknown>} */ (manifest);
  if (platforms === null || typeof platforms !== 'object' || Array.isArray(platforms)) {
    fail('platforms 字段缺失或不是对象');
    return errors;
  }

  const platformMap = /** @type {Record<string, unknown>} */ (platforms);
  const actualKeys = Object.keys(platformMap);
  const expectedKeys = [...REQUIRED_PLATFORM_KEYS].sort();
  const actualSorted = [...actualKeys].sort();

  const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
  const extra = actualSorted.filter((key) => !expectedKeys.includes(key));
  if (missing.length > 0) {
    fail(`platforms 缺少平台 key: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    fail(`platforms 出现未知平台 key: ${extra.join(', ')}`);
  }

  // 5. key 拼写 + 每个平台的字段
  const seenUrls = new Map();
  for (const key of actualKeys) {
    if (!VALID_OS_PREFIXES.some((os) => key.startsWith(`${os}-`))) {
      if (key.startsWith('macos-')) {
        fail(`平台 key "${key}" 拼写错误：macOS 在 updater 查表里是 "darwin"，不是 "macos"`);
      } else {
        fail(`平台 key "${key}" 不符合 updater 的 "{os}-{arch}" 规则（os 只能是 ${VALID_OS_PREFIXES.join(' / ')}）`);
      }
    }

    const entry = platformMap[key];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`platforms["${key}"] 必须是对象`);
      continue;
    }

    const { signature, url } = /** @type {Record<string, unknown>} */ (entry);
    if (typeof signature !== 'string' || signature.trim().length === 0) {
      fail(`platforms["${key}"].signature 缺失或为空`);
    }
    if (typeof url !== 'string' || url.trim().length === 0) {
      fail(`platforms["${key}"].url 缺失或为空`);
      continue;
    }

    if (!/^https:\/\//.test(url)) {
      fail(`platforms["${key}"].url 必须是 https 绝对地址，实际为 "${url}"`);
    }
    if (!/\/releases\/download\/[^/]+\/.+$/.test(url)) {
      fail(`platforms["${key}"].url 必须指向 Release 资产（形如 .../releases/download/<tag>/<asset>），实际为 "${url}"`);
    }

    const previous = seenUrls.get(url);
    if (previous) {
      fail(`平台 "${previous}" 与 "${key}" 指向同一个资产 "${url}"，Release 里只会有一个同名资产，两者会互相覆盖`);
    }
    seenUrls.set(url, key);
  }

  return errors;
}

/** CLI 入口。 */
function main(argv) {
  const [manifestPath = 'latest.json', expectedVersion] = argv;
  const absolutePath = resolve(process.cwd(), manifestPath);

  if (!existsSync(absolutePath)) {
    console.error(`✗ 找不到清单文件: ${absolutePath}`);
    console.error(
      '  提示：先运行 npm run release:manifest -- <tag> <artifacts-dir> 生成清单，' +
        '或直接给本脚本传入清单路径。',
    );
    return 1;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    console.error(`✗ ${manifestPath} 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const options = expectedVersion ? { expectedVersion } : {};
  const errors = verifyLatestJson(manifest, options);

  if (errors.length > 0) {
    console.error(`✗ latest.json 校验未通过（${errors.length} 项）:`);
    for (const error of errors) console.error(`  - ${error}`);
    return 1;
  }

  const platformMap = /** @type {Record<string, { url: string }>} */ (
    /** @type {Record<string, unknown>} */ (manifest).platforms
  );
  console.log(`✓ latest.json 校验通过（${manifestPath}）`);
  for (const key of Object.keys(platformMap).sort()) {
    console.log(`  - ${key} -> ${platformMap[key].url}`);
  }
  return 0;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  process.exit(main(process.argv.slice(2)));
}
