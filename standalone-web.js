/**
 * dsh-open-web · 独立 web 实例（`dsh web`）的常驻预热与打开。
 *
 * 和同目录 index.js 里的 `open_web_ui` 不是一回事：
 *   - `open_web_ui` 打开的是「当前桌面进程自带的 Web GUI」——同一份会话、同一份插件；
 *   - 这里打开的是**另起一个 `dsh web` 进程**——自己的 profile、自己的插件集、自己的会话。
 *
 * 为什么能做到「说一句就开」：插件一加载就在后台把这个实例起好（预热），
 * 之后每次只是把已经缓存的、带令牌的地址交给系统浏览器，不再等启动。
 *
 * 关键技术事实（`@deepseek-ai/dsh-web-app/lib/index.js` 里 `config.printUrl` 那行）：
 *   子进程会把已登录地址打印成一行 `dsh web: <url>`，
 * 所以我们从 stdout 读这一行就拿到了「打开即登录」的地址，不需要自己铸令牌。
 * 该地址的令牌在进程存活期内可重复使用（实测同一地址连续请求 3 次都返回
 * 303 + Set-Cookie，cookie Max-Age 30 天），因此可以安全地缓存起来反复打开。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

/** 子进程打印地址时的前缀。 */
const URL_PREFIX = 'dsh web:';

/** 保留多少行子进程日志用于排错。 */
const TAIL_LINES = 60;
const TAIL_TEXT_LIMIT = 4000;

/** 优雅结束失败后再等多久强杀。 */
const KILL_GRACE_MS = 4000;

/** 找令牌地址时最多读日志尾部的多少字节。 */
const LOG_TAIL_BYTES = 512 * 1024;

/** 插件默认配置。用户可在 profile 的 cordis.patch.yml 里按 id 覆盖。 */
export const DEFAULTS = {
	/** 预热：插件加载后自动起一个实例，让第一次「打开 web」也是秒开。 */
	prewarm: true,
	/** 预热延迟，避免和 DSH 自身启动抢 IO。 */
	prewarmDelayMs: 1000,
	/** 等待 `dsh web: <url>` 的最长时间。 */
	bootTimeoutMs: 120000,
	/** 空闲回收：这么久没有打开/查询就关掉。0 表示永不回收（与 DSH 同生命周期）。 */
	idleTimeoutMs: 0,
	/** 复用已在跑的实例：先探测下面这些地址，活着就直接用它，不再另起一套进程。 */
	attach: true,
	/** 候选探测地址（`http://host:port/`）。 */
	attachUrls: ['http://127.0.0.1:3080/'],
	/** 从这些日志里找「带令牌的地址」，让复用也能直接登录。支持 %ENV% 与 $ENV。 */
	attachLogs: ['%USERPROFILE%\\dsh-web\\web.log'],
	/** 单次探测超时。 */
	attachProbeTimeoutMs: 800
};

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isFile(path) {
	try {
		return existsSync(path);
	} catch {
		return false;
	}
}

/**
 * 在 PATH 里找一个可执行文件（Windows 上按 `;` 切分）。
 * @param {string} name
 * @param {Record<string, string | undefined>} env
 * @returns {string | undefined}
 */
export function findOnPath(name, env = process.env) {
	const raw = env.PATH ?? env.Path ?? '';
	const parts = raw.split(process.platform === 'win32' ? ';' : ':');
	for (const part of parts) {
		if (part.length === 0) continue;
		const candidate = join(part, name);
		if (isFile(candidate)) return candidate;
	}
	return undefined;
}

/**
 * 把一个脚本路径包装成「怎么 spawn 它」。
 * Windows 上的 `.cmd` 必须过 `cmd.exe`，因此单独记一种 kind。
 * @param {string} script
 * @param {Record<string, string | undefined>} env
 */
function toScriptLauncher(script, env) {
	if (process.platform === 'win32' && /\\.(?:cmd|bat)$/i.test(script)) {
		return { id: `cmd:${script}`, kind: 'cmd', script, comspec: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe' };
	}
	return { id: `direct:${script}`, kind: 'direct', command: script, args: [], env: {} };
}

/**
 * 候选启动方式，按优先级排列；调用方逐个尝试直到有一个成功。
 *
 * 生产环境（插件跑在桌面端里）会命中第 1 条：自己和宿主是同一个 Electron
 * 可执行文件，用 `ELECTRON_RUN_AS_NODE` 直接再跑一份 desktop host CLI，
 * 不经过 `cmd.exe`，安装路径带空格也不会坏。
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Array<object>}
 */
export function candidateLaunchers(env = process.env) {
	/** @type {Array<object>} */
	const launchers = [];
	const resources = typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0
		? process.resourcesPath
		: undefined;

	const hostCli = resources === undefined
		? undefined
		: join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
	if (process.versions?.electron !== undefined && hostCli !== undefined && isFile(hostCli)) {
		launchers.push({
			id: 'electron-node',
			kind: 'direct',
			command: process.execPath,
			args: ['--expose-internals', hostCli],
			env: { ELECTRON_RUN_AS_NODE: '1' }
		});
	}

	if (resources !== undefined) {
		const script = join(resources, 'runtime', 'cli', 'bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
		if (isFile(script)) launchers.push(toScriptLauncher(script, env));
	}

	for (const name of process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe'] : ['dsh']) {
		const found = findOnPath(name, env);
		if (found !== undefined) launchers.push(toScriptLauncher(found, env));
	}

	return launchers;
}

/**
 * cmd 里的参数引号规则：含空白或 shell 元字符就整体加引号。
 * @param {string} value
 * @returns {string}
 */
function quoteWin(value) {
	const text = String(value);
	if (/[\s"&|<>^()]/.test(text)) return `"${text}"`;
	return text;
}

/**
 * 把「启动器 + 业务参数」拼成 spawn 的三件套。
 * @param {object} launcher
 * @param {string[]} appArgs
 * @returns {{command: string, args: string[], options: object}}
 */
export function spawnShape(launcher, appArgs) {
	if (launcher.kind === 'cmd') {
		const inner = [launcher.script, ...appArgs].map(quoteWin).join(' ');
		return {
			command: launcher.comspec,
			// `/s` 会剥掉最外层那一对引号，于是 `""C:\a b\dsh.cmd" web …"` 是标准写法。
			args: ['/d', '/s', '/c', `"${inner}"`],
			options: { windowsVerbatimArguments: true }
		};
	}
	return {
		command: launcher.command,
		args: [...launcher.args, ...appArgs],
		options: {}
	};
}

/**
 * 从一行输出里认出地址。
 * @param {string} line
 * @returns {string | undefined}
 */
export function parseUrlLine(line) {
	const text = String(line);
	const at = text.indexOf(URL_PREFIX);
	if (at === -1) return undefined;
	const rest = text.slice(at + URL_PREFIX.length).trim();
	if (!/^https?:\\/\\/\\S+$/.test(rest)) return undefined;
	return rest;
}

/**
 * 展开 `%USERPROFILE%` / `$HOME` 这类环境变量，顺便把 `~` 换掉。
 * @param {string} text
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function expandEnvPath(text, env = process.env) {
	let out = String(text);
	out = out.replace(/%([^%]+)%/g, (whole, name) => {
		const key = Object.keys(env).find((item) => item.toLowerCase() === String(name).toLowerCase());
		const value = key === undefined ? undefined : env[key];
		return typeof value === 'string' ? value : whole;
	});
	out = out.replace(/\\$\\{?([A-Za-z_][A-Za-z0-9_]*)\\}?/g, (whole, name) => {
		const value = env[name];
		return typeof value === 'string' ? value : whole;
	});
	if (out === '~') return env.USERPROFILE ?? env.HOME ?? out;
	if (out.startsWith('~/') || out.startsWith('~\\')) {
		const home = env.USERPROFILE ?? env.HOME;
		if (typeof home === 'string') out = join(home, out.slice(2));
	}
	return out;
}

/**
 * 探测一个地址上是否已经有东西在应答。
 *
 * 只要拿到**任何** HTTP 响应就算活着（未登录时是 401，带令牌时是 200/303），
 * 因此这里不判断状态码，只判断「连得上且回了话」。
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export async function probeAlive(url, timeoutMs = 800) {
	if (typeof globalThis.fetch !== 'function') return false;
	try {
		await globalThis.fetch(url, {
			method: 'GET',
			redirect: 'manual',
			signal: AbortSignal.timeout(Math.max(100, timeoutMs))
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * 从日志尾部找一条「带令牌的地址」，要求 origin 与目标一致。
 * @param {string} logPath
 * @param {string} origin
 * @param {Record<string, string | undefined>} env
 * @returns {string | undefined}
 */
export function findTokenUrl(logPath, origin, env = process.env) {
	const file = expandEnvPath(logPath, env);
	if (!isFile(file)) return undefined;
	/** @type {string} */
	let text;
	try {
		const raw = readFileSync(file);
		const slice = raw.length > LOG_TAIL_BYTES ? raw.subarray(raw.length - LOG_TAIL_BYTES) : raw;
		text = slice.toString('utf8');
	} catch {
		return undefined;
	}
	let found;
	for (const line of text.split(/\\r?\\n/)) {
		const url = parseUrlLine(line);
		if (url === undefined) continue;
		try {
			if (new URL(url).origin === origin) found = url;
		} catch {
			/* 忽略坏行 */
		}
	}
	return found;
}

/**
 * 判断有一个「已经在跑」的实例可以复用。
 *
 * 两条路都指向同一件事：先探测端口，再从日志里捞出这个端口对应的带令牌地址。
 * 只有探测通过但日志里找不到地址时，才退化成「打开裸地址」——那样用户还要自己登录，
 * 所以宁可当作没有可复用实例，另起一个。
 *
 * @param {object} config 已补全的配置
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{url: string, origin: string} | undefined>}
 */
export async function resolveAttachTarget(config, env = process.env) {
	if (config.attach !== true) return undefined;
	const urls = Array.isArray(config.attachUrls) ? config.attachUrls : [];
	const logs = Array.isArray(config.attachLogs) ? config.attachLogs : [];
	for (const candidate of urls) {
		/** @type {string} */
		let origin;
		try {
			origin = new URL(String(candidate)).origin;
		} catch {
			continue;
		}
		const alive = await probeAlive(String(candidate), config.attachProbeTimeoutMs);
		if (!alive) continue;
		for (const log of logs) {
			const url = findTokenUrl(String(log), origin, env);
			if (url !== undefined) return { url, origin };
		}
	}
	return undefined;
}

/**
 * 把流上的数据切成整行。
 * @param {(line: string) => void} handler
 * @returns {(chunk: string) => void}
 */
function lineSplitter(handler) {
	let buffer = '';
	return (chunk) => {
		buffer += chunk;
		let index = buffer.indexOf('\\n');
		while (index !== -1) {
			const line = buffer.slice(0, index).replace(/\\r$/, '');
			buffer = buffer.slice(index + 1);
			handler(line);
			index = buffer.indexOf('\\n');
		}
		if (buffer.length > 65536) buffer = buffer.slice(-8192);
	};
}

/**
 * 结束子进程：先 SIGTERM，宽限期后再强杀（Windows 上连同子进程树一起杀）。
 * @param {import('node:child_process').ChildProcess | null | undefined} child
 * @returns {Promise<void>}
 */
export function terminate(child) {
	return new Promise((resolve) => {
		if (child === null || child === undefined) {
			resolve();
			return;
		}
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(grace);
			resolve();
		};
		child.once('exit', finish);
		try {
			child.kill('SIGTERM');
		} catch {
			/* 可能已经退出了 */
		}
		const grace = setTimeout(() => {
			try {
				child.kill('SIGKILL');
			} catch {
				/* 忽略 */
			}
			if (process.platform === 'win32' && Number.isInteger(child.pid)) {
				try {
					spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
						.on('error', () => {});
				} catch {
					/* 忽略 */
				}
			}
			setTimeout(finish, 800).unref?.();
		}, KILL_GRACE_MS);
		grace.unref?.();
	});
}

/**
 * 把用户配置补齐成完整配置。
 * @param {unknown} raw
 */
function normalizeConfig(raw) {
	const config = { ...DEFAULTS };
	if (raw === undefined || raw === null || typeof raw !== 'object') return config;
	if (typeof raw.prewarm === 'boolean') config.prewarm = raw.prewarm;
	if (typeof raw.attach === 'boolean') config.attach = raw.attach;
	for (const key of ['prewarmDelayMs', 'bootTimeoutMs', 'idleTimeoutMs', 'attachProbeTimeoutMs']) {
		const value = raw[key];
		if (typeof value === 'number' && Number.isFinite(value) && value >= 0) config[key] = value;
	}
	for (const key of ['attachUrls', 'attachLogs']) {
		const value = raw[key];
		if (Array.isArray(value) && value.every((item) => typeof item === 'string')) config[key] = [...value];
	}
	if (typeof raw.command === 'string' && raw.command.trim().length > 0) config.command = raw.command.trim();
	if (Array.isArray(raw.args) && raw.args.every((item) => typeof item === 'string')) config.args = [...raw.args];
	return config;
}

/**
 * 创建一个「独立 web 实例」控制器。
 *
 * @param {object} [options]
 * @param {{info?: Function, warn?: Function}} [options.logger] 宿主 logger
 * @param {unknown} [options.config] profile patch 里的插件配置
 * @param {Record<string, string | undefined>} [options.env] 用于查找启动器的环境变量
 */
export function createStandaloneController({ logger, config: rawConfig, env = process.env } = {}) {
	const config = normalizeConfig(rawConfig);
	const appArgs = ['web', '--no-open', '--port', '0', ...(config.args ?? [])];

	const state = {
		child: /** @type {import('node:child_process').ChildProcess | null} */ (null),
		url: /** @type {string | null} */ (null),
		mode: /** @type {'spawned' | 'attached' | null} */ (null),
		readyAt: 0,
		boots: 0,
		lastError: /** @type {string | null} */ (null),
		disposed: false
	};

	/** @type {Promise<string> | null} */
	let starting = null;
	/** @type {NodeJS.Timeout | null} */
	let idleTimer = null;
	/** @type {NodeJS.Timeout | null} */
	let prewarmTimer = null;
	/** @type {string[]} */
	let tail = [];

	const logInfo = (...args) => logger?.info?.(...args);
	const logWarn = (...args) => logger?.warn?.(...args);

	const onProcessExit = () => {
		try {
			state.child?.kill('SIGKILL');
		} catch {
			/* 忽略 */
		}
	};
	process.once('exit', onProcessExit);

	function recordTail(line) {
		if (line.trim().length === 0) return;
		tail.push(line);
		while (tail.length > TAIL_LINES) tail.shift();
	}

	function tailText() {
		const text = tail.join('\\n');
		return text.length <= TAIL_TEXT_LIMIT ? text : `…${text.slice(-TAIL_TEXT_LIMIT)}`;
	}

	function clearIdle() {
		if (idleTimer !== null) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
	}

	function clearPrewarm() {
		if (prewarmTimer !== null) {
			clearTimeout(prewarmTimer);
			prewarmTimer = null;
		}
	}

	function touchIdle() {
		clearIdle();
		if (config.idleTimeoutMs <= 0 || state.url === null) return;
		idleTimer = setTimeout(() => {
			idleTimer = null;
			logInfo('dsh-open-web: 独立 web 空闲超过 %d ms，回收', config.idleTimeoutMs);
			void stop('idle');
		}, config.idleTimeoutMs);
		idleTimer.unref?.();
	}

	/**
	 * 起一个实例，等到它打印出地址为止。
	 * @param {object} launcher
	 * @returns {Promise<string>}
	 */
	function bootWith(launcher) {
		return new Promise((resolve, reject) => {
			const shape = spawnShape(launcher, appArgs);
			tail = [];
			/** @type {import('node:child_process').ChildProcess} */
			let child;
			try {
				child = spawn(shape.command, shape.args, {
					stdio: ['ignore', 'pipe', 'pipe'],
					windowsHide: true,
					env: { ...process.env, ...(launcher.env ?? {}) },
					...shape.options
				});
			} catch (error) {
				reject(new Error(`spawn 失败（${launcher.id}）：${messageOf(error)}`));
				return;
			}

			state.child = child;
			state.boots += 1;
			const startedAt = Date.now();
			let settled = false;

			const settle = (error, url) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error !== undefined) {
					state.lastError = messageOf(error);
					void terminate(child);
					reject(error);
					return;
				}
				state.url = url;
				state.mode = 'spawned';
				state.readyAt = Date.now();
				state.lastError = null;
				logInfo('dsh-open-web: 独立 web 已就绪（启动 %d ms）：%s', Date.now() - startedAt, url);
				touchIdle();
				resolve(url);
			};

			const timer = setTimeout(() => {
				settle(new Error(
					`等待 dsh web 启动超时（${config.bootTimeoutMs} ms，启动方式 ${launcher.id}）。日志尾部：\\n${tailText()}`
				));
			}, config.bootTimeoutMs);

			child.stdout?.setEncoding?.('utf8');
			child.stderr?.setEncoding?.('utf8');
			child.stdout?.on('data', lineSplitter((line) => {
				recordTail(line);
				if (settled) return;
				const url = parseUrlLine(line);
				if (url !== undefined) settle(undefined, url);
			}));
			child.stderr?.on('data', lineSplitter((line) => {
				recordTail(line);
			}));
			child.once('error', (error) => {
				settle(new Error(`dsh web 子进程启动失败（${launcher.id}）：${messageOf(error)}`));
			});
			child.once('exit', (code, signal) => {
				const gone = `dsh web 子进程已退出（code=${code}, signal=${signal}）`;
				if (!settled) {
					settle(new Error(`${gone}，且未打印地址。日志尾部：\\n${tailText()}`));
					return;
				}
				// 就绪后退出：清掉缓存，下次调用会重新拉起。
				state.url = null;
				state.child = null;
				clearIdle();
				logWarn('dsh-open-web: %s；下次打开时会重新启动', gone);
			});
		});
	}

	/**
	 * 逐个尝试候选启动器。
	 * @returns {Promise<string>}
	 */
	async function boot() {
		/** @type {Array<object>} */
		let launchers;
		if (config.command !== undefined) {
			const isScript = process.platform === 'win32' && /\\.(?:cmd|bat)$/i.test(config.command);
			launchers = isScript
				? [{ id: `config:${config.command}`, kind: 'cmd', script: config.command, comspec: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe' }]
				: [{ id: `config:${config.command}`, kind: 'direct', command: config.command, args: [], env: {} }];
		} else {
			launchers = candidateLaunchers(env);
		}
		if (launchers.length === 0) {
			throw new Error('找不到 dsh 启动器：既没有宿主 Electron CLI，也没有 dsh.cmd / PATH 上的 dsh。可用 config.command 指定');
		}
		/** @type {string[]} */
		const failures = [];
		for (const launcher of launchers) {
			try {
				return await bootWith(launcher);
			} catch (error) {
				failures.push(`${launcher.id}: ${messageOf(error)}`);
			}
		}
		throw new Error(`所有启动方式都失败：\\n- ${failures.join('\\n- ')}`);
	}

	/**
	 * 保证有一个可用实例，返回（带令牌的）地址。
	 *
	 * 优先复用「已经在跑」的实例（见 `resolveAttachTarget`）：这样既省一整份进程，
	 * 也省掉冷启动。没有可复用的才自己起一个。
	 *
	 * @returns {Promise<{url: string, reused: boolean, mode: 'spawned' | 'attached'}>}
	 */
	async function ensure() {
		if (state.disposed) throw new Error('插件已卸载，无法再启动独立 web');
		if (state.url !== null) {
			if (state.mode === 'attached') {
				// 复用的实例随时可能被别人关掉，每次打开前轻量确认一次。
				const alive = await probeAlive(state.url, config.attachProbeTimeoutMs);
				if (alive) {
					touchIdle();
					return { url: state.url, reused: true, mode: 'attached' };
				}
				logInfo('dsh-open-web: 复用的实例已不可达（%s），改为自己启动', redactStandaloneUrl(state.url));
				state.url = null;
				state.mode = null;
			} else if (state.child !== null) {
				touchIdle();
				return { url: state.url, reused: true, mode: 'spawned' };
			}
		}
		if (starting !== null) {
			const url = await starting;
			return { url, reused: true, mode: state.mode ?? 'spawned' };
		}
		starting = (async () => {
			const attached = await resolveAttachTarget(config, env);
			if (attached !== undefined) {
				state.url = attached.url;
				state.mode = 'attached';
				state.readyAt = Date.now();
				state.lastError = null;
				logInfo('dsh-open-web: 复用已在运行的 web 实例：%s', redactStandaloneUrl(attached.url));
				touchIdle();
				return attached.url;
			}
			return boot();
		})();
		try {
			const url = await starting;
			return { url, reused: false, mode: state.mode ?? 'spawned' };
		} finally {
			starting = null;
		}
	}

	/** 后台预热；失败只记日志，等用户真要用时再试一次。 */
	function warm() {
		if (!config.prewarm || state.disposed) return;
		clearPrewarm();
		prewarmTimer = setTimeout(() => {
			prewarmTimer = null;
			ensure()
				.then(() => {})
				.catch((error) => {
					logWarn('dsh-open-web: 预热失败（%s）；首次「打开 web」时会再试一次', messageOf(error));
				});
		}, Math.max(0, config.prewarmDelayMs));
		prewarmTimer.unref?.();
	}

	/**
	 * 关掉实例。
	 * @param {string} [reason]
	 * @returns {Promise<boolean>} 之前是否真的在跑
	 */
	async function stop(reason = 'manual') {
		clearIdle();
		clearPrewarm();
		const child = state.child;
		const wasAttached = state.mode === 'attached';
		const wasRunning = child !== null || wasAttached;
		state.child = null;
		state.url = null;
		state.mode = null;
		if (child === null) {
			// 复用的实例不归我们管：只断开引用，绝不去杀别人起的进程。
			if (wasAttached) logInfo('dsh-open-web: 已断开复用的 web 实例（%s，进程仍在运行）', reason);
			return wasRunning;
		}
		await terminate(child);
		logInfo('dsh-open-web: 独立 web 已关闭（%s）', reason);
		return wasRunning;
	}

	function status() {
		return {
			running: state.url !== null,
			mode: state.mode,
			url: state.url,
			pid: state.child?.pid ?? null,
			boots: state.boots,
			readyAt: state.readyAt === 0 ? null : new Date(state.readyAt).toISOString(),
			uptimeMs: state.readyAt === 0 ? null : Date.now() - state.readyAt,
			lastError: state.lastError,
			config
		};
	}

	async function dispose() {
		state.disposed = true;
		process.removeListener('exit', onProcessExit);
		await stop('dispose');
	}

	return { ensure, warm, stop, status, dispose, config };
}

/**
 * 把带令牌的地址脱敏成「主机 + 端口 + 省略」。
 * @param {string} url
 * @returns {string}
 */
export function redactStandaloneUrl(url) {
	if (typeof url !== 'string' || url.length === 0) return '';
	try {
		const parsed = new URL(url);
		return `${parsed.origin}/…（已附带登录令牌）`;
	} catch {
		return url.replace(/([?&#](?:token|access_token|key|t)=)[^&#/]+/gi, '$1***');
	}
}
