#!/usr/bin/env node
/**
 * 升级后自检：DSH 升版本以后，检查「这次环境还是好的」。
 *
 * 它回答三个问题：
 *   1. `dsh-github` 的版本门还放宽着吗？（pnpm patch 有没有被升级/重装冲掉）
 *   2. 当前 dsh 运行时版本还落在放宽后的范围里吗？
 *   3. 本插件自己还能被宿主编译、`apply()` 还能注册出两个工具吗？
 *
 * 用法：
 *   node scripts/check-env.mjs                 # 检查 desktop profile
 *   node scripts/check-env.mjs --profile web   # 检查别的 profile
 *   node scripts/check-env.mjs --exe "D:\DeepSeek Harness\DeepSeek Harness.exe"
 *
 * 读 app.asar 需要 Electron 的 fs（普通 Node 读不了 asar 内的文件），
 * 所以如果发现自己在普通 Node 里，会用 `ELECTRON_RUN_AS_NODE=1` 重新执行自己。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
const UNDER_ELECTRON = process.versions.electron !== undefined;

/** @param {string[]} argv */
function parseArgs(argv) {
	const out = { profile: 'desktop', exe: undefined, verbose: false };
	for (let i = 0; i < argv.length; i += 1) {
		const item = argv[i];
		if (item === '--profile') out.profile = argv[++i] ?? out.profile;
		else if (item === '--exe') out.exe = argv[++i];
		else if (item === '--verbose') out.verbose = true;
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));

/** @type {Array<{ok: boolean | null, name: string, detail: string}>} */
const results = [];
function note(ok, name, detail = '') {
	results.push({ ok, name, detail });
}
function pass(name, detail) {
	note(true, name, detail);
}
function fail(name, detail) {
	note(false, name, detail);
}
function skip(name, detail) {
	note(null, name, detail);
}

/** 从 PATH 上的 dsh.cmd 里解析出桌面端可执行文件。 */
function findDesktopExe() {
	if (args.exe !== undefined) return args.exe;
	if (typeof process.execPath === 'string' && /DeepSeek Harness\.exe$/i.test(process.execPath)) {
		return process.execPath;
	}
	const raw = process.env.PATH ?? process.env.Path ?? '';
	for (const dir of raw.split(';')) {
		if (dir.length === 0) continue;
		const cmd = join(dir, 'dsh.cmd');
		if (!existsSync(cmd)) continue;
		// 布局：<安装目录>\resources\runtime\cli\bin\dsh.cmd → 往上四层就是安装目录
		const exe = resolve(dir, '..', '..', '..', '..', 'DeepSeek Harness.exe');
		if (existsSync(exe)) return exe;
	}
	return undefined;
}

// ── 普通 Node：换成 Electron 再跑一遍 ─────────────────────────────────────
if (!UNDER_ELECTRON) {
	const exe = findDesktopExe();
	if (exe === undefined) {
		console.error('找不到桌面端可执行文件；用 --exe 指定，或直接用 dsh 自带的 node 跑本脚本。');
		process.exit(2);
	}
	const child = spawnSync(exe, ['--expose-internals', fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
		stdio: 'inherit',
		env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
	});
	if (child.error !== undefined) console.error(`启动 ${exe} 失败：${child.error.message}`);
	process.exit(child.status ?? 1);
}

// ── 以下都跑在 Electron 的 Node 里，可以读 app.asar ──────────────────────
const APP_ASAR = join(process.resourcesPath, 'app.asar');
const RUNTIME_DIST = join(APP_ASAR, 'dsh');
const profileDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', args.profile);

/** 读 package.json，失败返回 undefined。 */
function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return undefined;
	}
}

/** 从 asar 里的分发目录读版本号。 */
function runtimeVersion(name) {
	const manifest = readJson(join(RUNTIME_DIST, 'node_modules', ...name.split('/'), 'package.json'));
	return typeof manifest?.version === 'string' ? manifest.version : undefined;
}

const dshVersion = runtimeVersion('@deepseek-ai/dsh') ?? runtimeVersion('@deepseek-ai/dsh-app-boot');
const toolsVersion = runtimeVersion('@deepseek-ai/dsh-tools');

if (dshVersion === undefined) fail('读取 dsh 运行时版本', `找不到 ${join(RUNTIME_DIST, 'node_modules')}`);
else pass('读取 dsh 运行时版本', `dsh ${dshVersion}；@deepseek-ai/dsh-tools ${toolsVersion ?? '未找到'}`);

// ── 1. profile 是否存在 ──────────────────────────────────────────────────
if (!existsSync(join(profileDir, 'package.json'))) {
	fail(`profile ${args.profile} 存在`, profileDir);
} else {
	pass(`profile ${args.profile} 存在`, profileDir);
}

// ── 2. dsh-github 的版本门 ───────────────────────────────────────────────
const ghManifestPath = join(profileDir, 'node_modules', 'dsh-github', 'package.json');
const ghManifest = readJson(ghManifestPath);
if (ghManifest === undefined) {
	skip('dsh-github 已安装', '这个 profile 里没有 dsh-github，跳过');
} else {
	const peer = ghManifest.peerDependencies?.['@deepseek-ai/dsh-tools'];
	pass('dsh-github 已安装', `v${ghManifest.version}；peer(dsh-tools) = ${peer ?? '未声明'}`);

	if (typeof peer === 'string' && dshVersion !== undefined && toolsVersion !== undefined) {
		const requireFromProfile = createRequire(join(profileDir, 'package.json'));
		/** @type {any} */
		let semver;
		try {
			semver = requireFromProfile('semver');
		} catch {
			semver = undefined;
		}
		if (semver === undefined) {
			skip('peer 范围覆盖当前运行时', '找不到 semver，无法计算');
		} else if (semver.satisfies(toolsVersion, peer, { includePrerelease: true })) {
			pass('peer 范围覆盖当前运行时', `${toolsVersion} ∈ ${peer}`);
		} else {
			fail('peer 范围覆盖当前运行时',
				`${toolsVersion} ∉ ${peer}；需要重新打补丁：dsh plugin --profile ${args.profile} patch dsh-github@${ghManifest.version}`);
		}
	}

	// 补丁链：patch 文件 + pnpm-workspace.yaml 登记
	const patchFile = join(profileDir, 'patches', `dsh-github@${ghManifest.version}.patch`);
	const workspaceYaml = join(profileDir, 'pnpm-workspace.yaml');
	const yaml = existsSync(workspaceYaml) ? readFileSync(workspaceYaml, 'utf8') : '';
	if (!existsSync(patchFile)) {
		fail('pnpm 补丁文件存在', `缺少 ${patchFile}`);
	} else if (!yaml.includes('patchedDependencies')) {
		fail('补丁已登记', `${workspaceYaml} 里没有 patchedDependencies（重新 patch-commit 一次）`);
	} else {
		pass('pnpm 补丁链完整', patchFile);
	}

	// 豁免表只应该是空的：补丁生效时不该再靠版本豁免
	const compatPath = join(profileDir, 'compatibility.json');
	const compat = readJson(compatPath);
	if (compat === undefined) {
		skip('compatibility.json 可读', `${compatPath} 不存在，视为没有豁免`);
	} else {
		const keys = Object.keys(compat);
		if (keys.length === 0) pass('没有残留豁免', `${compatPath} 是 {}`);
		else skip('没有残留豁免', `仍有豁免项：${keys.join(', ')}（补丁生效时用不到，可以清掉）`);
	}
}

// ── 3. 插件自身：能编译、能 apply、注册出两个工具 ────────────────────────
const entry = join(PLUGIN_ROOT, 'index.js');
try {
	const mod = await import(pathToFileURL(entry).href);
	if (typeof mod.apply !== 'function') {
		fail('插件可加载', `${entry} 没有导出 apply()`);
	} else {
		pass('插件可加载', `${entry}`);
		const tools = [];
		const sections = [];
		const logger = { info: () => {}, warn: (...a) => console.warn('  warn:', ...a), error: (...a) => console.warn('  error:', ...a) };
		const noop = () => {};
		const ctx = new Proxy({}, {
			get(_target, prop) {
				if (prop === 'tools') return { register: (tool) => { tools.push(tool.name); return noop; } };
				if (prop === 'systemPrompt') return { section: (section) => { sections.push(section.name); return noop; } };
				if (prop === 'effect') {
					return (fn) => {
						try {
							fn();
						} catch (error) {
							console.warn(`  effect 忽略错误：${error instanceof Error ? error.message : String(error)}`);
						}
						return noop;
					};
				}
				if (prop === 'logger') return logger;
				if (prop === 'config') throw new Error('cannot get property "config" without inject');
				return undefined;
			}
		});
		try {
			mod.apply(ctx);
			const wanted = ['open_web_ui', 'open_standalone_web'];
			const missing = wanted.filter((name) => !tools.includes(name));
			if (missing.length === 0) pass('apply() 注册工具', tools.join(' / '));
			else fail('apply() 注册工具', `缺少 ${missing.join('、')}（已注册：${tools.join(', ')}）`);
			if (sections.length >= 2) pass('注入系统提示', sections.join(' / '));
			else fail('注入系统提示', `只有 ${sections.length} 段：${sections.join(', ')}`);
		} catch (error) {
			fail('apply() 可执行', error instanceof Error ? error.message : String(error));
		}
	}
} catch (error) {
	fail('插件可加载', error instanceof Error ? error.message : String(error));
}

// ── 输出 ────────────────────────────────────────────────────────────────
console.log(`\nprofile: ${profileDir}`);
console.log(`dsh: ${dshVersion ?? '?'} · dsh-tools: ${toolsVersion ?? '?'}\n`);
for (const item of results) {
	const mark = item.ok === true ? 'OK  ' : item.ok === false ? 'FAIL' : 'SKIP';
	console.log(`${mark} ${item.name}${item.detail.length > 0 ? ` — ${item.detail}` : ''}`);
}
const failed = results.filter((item) => item.ok === false).length;
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项需要处理`}\n`);
process.exit(failed === 0 ? 0 : 1);
