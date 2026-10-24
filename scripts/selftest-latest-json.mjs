#!/usr/bin/env node
/**
 * 发布链路脚本的自测（不依赖 vitest，也不需要安装任何依赖）。
 *
 * 用法: node scripts/selftest-latest-json.mjs
 *
 * 为什么单独做一个自测脚本，而不是加进 vitest：
 * - 本仓库的 vitest include 范围只覆盖 `src/` 目录下的 `*.test.*` / `*.spec.*` 文件，
 *   覆盖不到 `scripts/`；要纳入就得改 `vite.config.ts` 的 include，
 *   而那会让「前端单测」这个 CI 门禁同时承担发布脚本的回归，属于门禁耦合。
 * - 这些脚本是发布流水线的关键路径（清单生成 / 清单校验 / 版本守卫），
 *   值得有自动化回归，但用零依赖的 node 自测脚本更轻：在任何有 node 的环境里
 *   `node scripts/selftest-latest-json.mjs` 就能跑完。
 *
 * 覆盖的失败场景（与 scripts/verify-latest-json.mjs 的断言清单一一对应）：
 *   缺平台 key / 多平台 key / `macos-*` 拼写 / 两平台指向同一资产 /
 *   url 非 https / url 形态不对 / signature 或 url 为空 /
 *   version 带 `v` 前缀 / version 非 semver / version 与期望值不一致
 * 以及版本一致性守卫（tag vs tauri.conf.json vs Cargo.toml vs package.json）的
 * 正负例，和「合成产物目录」下清单生成 + 校验的端到端正负例。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REQUIRED_PLATFORM_KEYS, verifyLatestJson } from './verify-latest-json.mjs';
import { parseCargoPackageVersion, verifyReleaseVersion } from './verify-release-version.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

let passed = 0;
/** @type {{ name: string, error: unknown }[]} */
const failures = [];
/** 合成目录的临时根，退出时统一清理，避免断言失败时残留。 */
const tempRoots = [];

/**
 * 跑一个用例，失败时收集而不是立刻中断，保证一次跑完能看到全部问题。
 *
 * @param {string} name 用例名
 * @param {() => void} fn 用例体
 */
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  ✗ ${name}`);
    console.error(`    ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 断言错误列表里存在匹配给定模式的错误。 */
function assertHasError(errors, pattern, message) {
  assert.ok(
    errors.some((error) => pattern.test(error)),
    `${message}\n实际错误列表:\n${errors.map((line) => `  - ${line}`).join('\n')}`,
  );
}

/** 构造一份合法的 latest.json，供各负例在其基础上做局部破坏。 */
function validManifest() {
  /** @type {Record<string, { signature: string, url: string }>} */
  const platforms = {};
  for (const key of REQUIRED_PLATFORM_KEYS) {
    platforms[key] = {
      signature: `signature-${key}`,
      url: `https://github.com/WebbLee94/OpenCode-W/releases/download/v1.4.0/asset-${key}.bin`,
    };
  }
  return {
    version: '1.4.0',
    notes: 'OpenCode-W v1.4.0',
    pub_date: '2026-10-24T00:00:00.000Z',
    platforms,
  };
}

console.log('verify-latest-json：清单校验断言');

test('正例：完整合法的清单通过', () => {
  assert.deepEqual(verifyLatestJson(validManifest()), []);
});

test('负例：缺少平台 key', () => {
  const manifest = validManifest();
  delete manifest.platforms['linux-x86_64'];
  assertHasError(verifyLatestJson(manifest), /缺少平台 key/, '应报缺少平台 key');
});

test('负例：多出未知平台 key', () => {
  const manifest = validManifest();
  manifest.platforms['darwin-aarch64-extra'] = {
    signature: 'sig',
    url: 'https://github.com/WebbLee94/OpenCode-W/releases/download/v1.4.0/extra.bin',
  };
  assertHasError(verifyLatestJson(manifest), /未知平台 key/, '应报未知平台 key');
});

test('负例：macos-* 拼写错误被点名', () => {
  const manifest = validManifest();
  delete manifest.platforms['darwin-aarch64'];
  manifest.platforms['macos-aarch64'] = {
    signature: 'sig',
    url: 'https://github.com/WebbLee94/OpenCode-W/releases/download/v1.4.0/macos.bin',
  };
  assertHasError(verifyLatestJson(manifest), /macos/, '应点名 macos 拼写错误');
});

test('负例：非法 os 前缀', () => {
  const manifest = validManifest();
  delete manifest.platforms['linux-x86_64'];
  manifest.platforms['freebsd-x86_64'] = {
    signature: 'sig',
    url: 'https://github.com/WebbLee94/OpenCode-W/releases/download/v1.4.0/freebsd.bin',
  };
  assertHasError(verifyLatestJson(manifest), /os 只能是/, '应报非法 os 前缀');
});

test('负例：两个平台指向同一个资产', () => {
  const manifest = validManifest();
  manifest.platforms['darwin-x86_64'] = {
    ...manifest.platforms['darwin-aarch64'],
  };
  assertHasError(verifyLatestJson(manifest), /同一个资产/, '应报资产名冲突');
});

test('负例：url 不是 https', () => {
  const manifest = validManifest();
  manifest.platforms['linux-x86_64'].url = 'http://github.com/owner/repo/releases/download/v1.4.0/a.bin';
  assertHasError(verifyLatestJson(manifest), /https 绝对地址/, '应要求 https');
});

test('负例：url 形态不对（不是 Release 资产地址）', () => {
  const manifest = validManifest();
  manifest.platforms['linux-x86_64'].url = 'https://example.com/download/app.bin';
  assertHasError(verifyLatestJson(manifest), /Release 资产/, '应要求指向 Release 资产');
});

test('负例：signature 为空', () => {
  const manifest = validManifest();
  manifest.platforms['windows-x86_64'].signature = '   ';
  assertHasError(verifyLatestJson(manifest), /signature 缺失或为空/, '应报 signature 为空');
});

test('负例：url 为空', () => {
  const manifest = validManifest();
  manifest.platforms['windows-x86_64'].url = '';
  assertHasError(verifyLatestJson(manifest), /url 缺失或为空/, '应报 url 为空');
});

test('负例：version 带 v 前缀', () => {
  const manifest = validManifest();
  manifest.version = 'v1.4.0';
  assertHasError(verifyLatestJson(manifest), /不允许带 "v" 前缀/, '应拒绝 v 前缀');
});

test('负例：version 不是合法 semver', () => {
  const manifest = validManifest();
  manifest.version = '1.4';
  assertHasError(verifyLatestJson(manifest), /不是合法 semver/, '应拒绝非法 semver');
});

test('负例：version 缺失', () => {
  const manifest = validManifest();
  delete manifest.version;
  assertHasError(verifyLatestJson(manifest), /version 字段缺失/, '应报 version 缺失');
});

test('负例：version 与期望值（tag）不一致', () => {
  assertHasError(
    verifyLatestJson(validManifest(), { expectedVersion: 'v1.4.1' }),
    /与期望的/,
    '应报版本与 tag 不一致',
  );
});

test('正例：expectedVersion 写成纯版本号也接受', () => {
  assert.deepEqual(verifyLatestJson(validManifest(), { expectedVersion: '1.4.0' }), []);
});

console.log('verify-release-version：tag 与产物版本一致性守卫');

const consistentVersions = { tauri: '1.4.0', cargo: '1.4.0', pkg: '1.4.0' };

test('正例：三处版本一致且等于 tag', () => {
  assert.deepEqual(verifyReleaseVersion({ tag: 'v1.4.0', versions: consistentVersions }), []);
});

test('正例：tag 不带 v 前缀时同样接受', () => {
  assert.deepEqual(verifyReleaseVersion({ tag: '1.4.0', versions: consistentVersions }), []);
});

test('负例：tauri.conf.json 版本与 tag 不一致', () => {
  const errors = verifyReleaseVersion({
    tag: 'v1.4.1',
    versions: { ...consistentVersions },
  });
  assertHasError(errors, /tauri\.conf\.json/, '应点名 tauri.conf.json');
});

test('负例：Cargo.toml 版本与 tag 不一致', () => {
  const errors = verifyReleaseVersion({
    tag: 'v1.4.1',
    versions: { ...consistentVersions, cargo: '1.4.0' },
  });
  assertHasError(errors, /Cargo\.toml/, '应点名 Cargo.toml');
});

test('负例：package.json 版本与 tag 不一致', () => {
  const errors = verifyReleaseVersion({
    tag: 'v1.4.1',
    versions: { ...consistentVersions, pkg: '1.4.0' },
  });
  assertHasError(errors, /package\.json/, '应点名 package.json');
});

test('负例：版本缺失时报错而不是静默通过', () => {
  const errors = verifyReleaseVersion({
    tag: 'v1.4.0',
    versions: { tauri: null, cargo: '1.4.0', pkg: '1.4.0' },
  });
  assertHasError(errors, /没有读到 version/, '应报版本缺失');
});

test('负例：tag 不是合法 semver', () => {
  const errors = verifyReleaseVersion({ tag: 'v1.4', versions: consistentVersions });
  assertHasError(errors, /不是合法 semver/, '应报 tag 非法 semver');
});

test('parseCargoPackageVersion：只认 [package] 段', () => {
  const cargoToml = [
    '[package]',
    'name = "opencode-w"',
    'version = "1.4.0"',
    '',
    '[package.metadata]',
    'version = "9.9.9"',
    '',
    '[dependencies]',
    'version = "0.0.0"',
  ].join('\n');
  assert.equal(parseCargoPackageVersion(cargoToml), '1.4.0');
});

test('parseCargoPackageVersion：没有 version 时返回 null', () => {
  assert.equal(parseCargoPackageVersion('[package]\nname = "opencode-w"\n'), null);
});

console.log('CLI 端到端：版本守卫 / 清单生成 / 清单校验');

/** 造一个只含版本相关文件的合成仓库目录。 */
function createSyntheticRepo(versions) {
  const root = mkdtempSync(join(tmpdir(), 'opencode-w-release-selftest-'));
  tempRoots.push(root);
  mkdirSync(join(root, 'src-tauri'), { recursive: true });
  writeFileSync(
    join(root, 'src-tauri', 'tauri.conf.json'),
    `${JSON.stringify({ productName: 'OpenCode-W', version: versions.tauri }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, 'src-tauri', 'Cargo.toml'),
    ['[package]', 'name = "opencode-w"', `version = "${versions.cargo}"`, ''].join('\n'),
  );
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'OpenCode-W', version: versions.pkg }, null, 2)}\n`,
  );
  return root;
}

/** 造一份合成产物目录：四个平台各一个带签名的 updater 产物。 */
function createSyntheticArtifacts(root) {
  const artifacts = join(root, 'artifacts');
  const files = {
    'darwin-aarch64': 'OpenCode-W_1.4.0_aarch64.app.tar.gz',
    'darwin-x86_64': 'OpenCode-W_1.4.0_x86_64.app.tar.gz',
    'windows-x86_64': 'OpenCode-W_1.4.0_x64-setup.exe',
    'linux-x86_64': 'opencode-w_1.4.0_amd64.AppImage',
  };
  for (const [platform, fileName] of Object.entries(files)) {
    const platformDir = join(artifacts, platform);
    mkdirSync(platformDir, { recursive: true });
    writeFileSync(join(platformDir, fileName), 'artifact');
    writeFileSync(join(platformDir, `${fileName}.sig`), `signature-${platform}\n`);
  }
  return artifacts;
}

const scratch = mkdtempSync(join(tmpdir(), 'opencode-w-release-selftest-'));

try {
  test('CLI 正例：版本一致时退出码为 0', () => {
    const root = createSyntheticRepo({ tauri: '1.4.0', cargo: '1.4.0', pkg: '1.4.0' });
    const result = spawnSync(
      process.execPath,
      [join(scriptsDir, 'verify-release-version.mjs'), 'v1.4.0', root],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    rmSync(root, { recursive: true, force: true });
  });

  test('CLI 负例：tag 与三处版本不一致时退出码为 1 且带 ::error:: 注解', () => {
    const root = createSyntheticRepo({ tauri: '1.4.0', cargo: '1.4.0', pkg: '1.4.0' });
    const result = spawnSync(
      process.execPath,
      [join(scriptsDir, 'verify-release-version.mjs'), 'v1.4.1', root],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /::error::/, '应输出 ::error:: 注解');
    rmSync(root, { recursive: true, force: true });
  });

  test('CLI 正例：合成产物目录生成清单并通过校验', () => {
    const artifacts = createSyntheticArtifacts(scratch);
    const generated = spawnSync(
      process.execPath,
      [join(scriptsDir, 'generate-latest-json.mjs'), 'v1.4.0', artifacts],
      { cwd: scratch, encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: 'WebbLee94/OpenCode-W' } },
    );
    assert.equal(generated.status, 0, `stdout=${generated.stdout}\nstderr=${generated.stderr}`);

    const verified = spawnSync(
      process.execPath,
      [join(scriptsDir, 'verify-latest-json.mjs'), 'latest.json', 'v1.4.0'],
      { cwd: scratch, encoding: 'utf8' },
    );
    assert.equal(verified.status, 0, `stdout=${verified.stdout}\nstderr=${verified.stderr}`);
  });

  test('CLI 负例：清单被破坏后校验退出码为 1', () => {
    const manifest = JSON.parse(readFileSync(join(scratch, 'latest.json'), 'utf8'));
    manifest.platforms['macos-aarch64'] = manifest.platforms['darwin-aarch64'];
    delete manifest.platforms['darwin-aarch64'];
    writeFileSync(join(scratch, 'broken-latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const verified = spawnSync(
      process.execPath,
      [join(scriptsDir, 'verify-latest-json.mjs'), 'broken-latest.json', 'v1.4.0'],
      { cwd: scratch, encoding: 'utf8' },
    );
    assert.equal(verified.status, 1, `stdout=${verified.stdout}\nstderr=${verified.stderr}`);
    assert.match(verified.stderr, /macos/, '应点名 macos 拼写错误');
  });

  test('CLI 负例：缺少平台产物目录时清单生成退出码为 1', () => {
    const artifacts = createSyntheticArtifacts(join(scratch, 'incomplete'));
    rmSync(join(artifacts, 'linux-x86_64'), { recursive: true, force: true });
    const generated = spawnSync(
      process.execPath,
      [join(scriptsDir, 'generate-latest-json.mjs'), 'v1.4.0', artifacts],
      { cwd: scratch, encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: 'WebbLee94/OpenCode-W' } },
    );
    assert.equal(generated.status, 1, `stdout=${generated.stdout}\nstderr=${generated.stderr}`);
    assert.match(generated.stderr, /缺少平台产物目录/, '应报缺少平台产物目录');
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
}

console.log('');
if (failures.length > 0) {
  console.error(`✗ 发布脚本自测未通过：${failures.length} 个用例失败 / 共 ${passed + failures.length} 个用例`);
  for (const failure of failures) {
    console.error(`  - ${failure.name}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`);
  }
  process.exit(1);
}

console.log(`✓ 发布脚本自测通过（${passed} 个用例）`);
