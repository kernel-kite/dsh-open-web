/**
 * dsh-open-web — 让模型在用户说“打开网页版 DeepSeek Harness”时，
 * 直接用当前桌面进程的登录令牌在系统默认浏览器打开网页版，打开即登录。
 *
 * ## 为什么“打开就是我的账号”
 * 桌面版 DSH 进程内提供一个本地 Web GUI（`ctx.webServer`），
 * `ctx.connection.authenticatedUrl(baseUrl)` 会给这个地址附上**当前进程令牌**，
 * 浏览器加载该地址时服务端 `authorizeIndex` 会铸一个 cookie，之后就是已登录状态。
 * 桌面版自身启动时也是用同一个 API 把地址交给 Electron 窗口
 * （见 @deepseek-ai/dsh-desktop-host 的 `ctx.connection.authenticatedUrl(...)`），
 * 所以这里沿用同一条登录链路，不需要用户做任何设置。
 *
 * ## 安全
 * 带令牌的地址等同于本机登录凭据，因此工具结果默认只返回脱敏地址；
 * 只有显式 `revealUrl: true`（用户明确索要链接）才回传原始地址。
 *
 * ## 网页端不播开场动画（桌面端照旧）
 * 桌面窗口和浏览器页面由同一个 Web 服务器提供，页面代码完全相同，
 * 所以“只在网页端关掉开场动画”必须在页面里按“这次是不是浏览器打开”来判断：
 *  - 本插件的工具在交给浏览器的地址后面加一个片段标记 `#dsh-open-web`；
 *  - 本插件通过 `ctx.webServer.tapIndex()` 往 index.html 注入一小段前置脚本，
 *    脚本看到该片段标记就设置 `window.__DSH_STARTUP_SKIP__ = true`
 *    （dsh-startup-screen 的运行时据此直接返回、不建 DOM），
 *    再隐藏首屏黑幕并解锁滚动，确保浏览器页面第一帧就是应用本体；
 *  - 桌面窗口的地址不带该标记，脚本什么都不做 —— 桌面端开场动画原样保留。
 * 页面会发一个只含“是否跳过/是否已开始”的微小上报，便于自检时确认效果。
 *
 * ## 兼容性
 * 本插件不 import 任何 `@deepseek-ai/*` 包，工具定义直接使用工具注册表期望的
 * 原始 JSON Schema 形状（与 `defineTool()` 编译后的结果一致），
 * 因此本地目录安装（链接到 checkout）时可零依赖加载。
 *
 * @module @local/dsh-open-web
 */

import { spawn } from 'node:child_process';

import {
	createStandaloneController,
	redactStandaloneUrl
} from './standalone-web.js';

/** Cordis 插件名（patch 里的行 id 用 open-web）。 */
export const name = 'open-web';

/**
 * 依赖的宿主服务：
 *  - tools / systemPrompt：注册工具与给模型的行为提示；
 *  - connection：`authenticatedUrl()` 生成带登录令牌的地址；
 *  - webServer：本地 Web GUI 的 origin（协议 + 端口）。
 */
export const inject = ['tools', 'systemPrompt', 'connection', 'webServer'];

/** 打开浏览器时允许的最长握手等待。 */
const LAUNCH_HANDSHAKE_MS = 4000;

/** 登录校验请求超时。 */
const PROBE_TIMEOUT_MS = 5000;

/** 工具名（模型可调用）。 */
const TOOL_NAME = 'open_web_ui';

/** 浏览器地址上的片段标记：页面看到它就跳过开场动画。 */
export const SKIP_MARKER = 'dsh-open-web';

/** 注入脚本的 id（同时用来做幂等判断）。 */
const SKIP_SCRIPT_ID = 'dsh-open-web-skip';

/** 客户端自检上报的路由。 */
const BEACON_PATH = '/dsh-open-web/beacon';

/** 内存里保留的最近客户端上报条数。 */
const BEACON_KEEP = 12;

/** @type {Array<{skip: boolean, started: boolean, entry: string, at: string}>} */
const beaconLog = [];

/**
 * 统一的错误文本。
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 解析本地 Web GUI 的 origin。
 *
 * 优先用 `webServer.protocol/port` 拼 `127.0.0.1`（桌面版自身就是这么做的），
 * 其次才退到 `getOrigin()` / `webApp.getAdvertisedUrl()`，避免拿到对外地址后
 * `authenticatedUrl` 因“远程授权”被拒。
 *
 * @param {object} ctx Cordis 插件上下文。
 * @returns {string} 形如 `http://127.0.0.1:65292`。
 */
export function resolveBaseUrl(ctx) {
	const server = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
	if (server !== undefined && server !== null) {
		const protocol = typeof server.protocol === 'string' ? server.protocol : undefined;
		const port = server.port;
		if (protocol !== undefined && Number.isInteger(port) && port > 0) return `${protocol}//127.0.0.1:${port}`;
		if (typeof server.getOrigin === 'function') {
			try {
				const origin = server.getOrigin();
				if (typeof origin === 'string' && origin.length > 0) return origin;
			} catch { /* 继续回退 */ }
		}
	}
	const app = typeof ctx.get === 'function' ? ctx.get('webApp') : undefined;
	if (app !== undefined && app !== null && typeof app.getAdvertisedUrl === 'function') {
		try {
			const advertised = app.getAdvertisedUrl();
			if (typeof advertised === 'string' && advertised.length > 0) return advertised;
		} catch { /* 继续回退 */ }
	}
	throw new Error('dsh-open-web: 找不到本地 Web GUI 地址（webServer / webApp 均不可用）');
}

/**
 * 生成带登录令牌的地址。
 * @param {object} ctx
 * @param {string} baseUrl
 * @returns {string}
 */
export function authenticatedUrlFor(ctx, baseUrl) {
	const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
	if (connection === undefined || connection === null || typeof connection.authenticatedUrl !== 'function') {
		throw new Error('dsh-open-web: 当前进程没有 connection.authenticatedUrl()，无法生成已登录地址');
	}
	const url = connection.authenticatedUrl(baseUrl);
	if (typeof url !== 'string' || url.length === 0) throw new Error('dsh-open-web: connection.authenticatedUrl() 返回了空地址');
	return url;
}

/**
 * 对带令牌的地址做脱敏展示：只保留 origin 与“已附带令牌”的说明。
 * @param {string} url
 * @param {string} baseUrl
 * @returns {string}
 */
export function redactUrl(url, baseUrl) {
	if (typeof url !== 'string' || url.length === 0) return '';
	if (typeof baseUrl === 'string' && baseUrl.length > 0 && url.startsWith(baseUrl)) {
		const rest = url.slice(baseUrl.length);
		if (rest.length === 0) return baseUrl;
		return `${baseUrl}/…（已附带登录令牌）`;
	}
	return url.replace(/([?&#/](?:token|access_token|accessToken|key|t)=?)[^&#/]+/gi, '$1***');
}

/**
 * 读出第一个 Set-Cookie 的 `name=value`。
 * @param {Headers} headers
 * @returns {string}
 */
function firstCookie(headers) {
	if (headers === undefined || headers === null) return '';
	let list = [];
	if (typeof headers.getSetCookie === 'function') list = headers.getSetCookie();
	if (list.length === 0) {
		const joined = typeof headers.get === 'function' ? headers.get('set-cookie') : null;
		if (typeof joined === 'string' && joined.length > 0) list = [joined];
	}
	if (list.length === 0) return '';
	const pair = String(list[0]).split(';')[0].trim();
	return pair.includes('=') ? pair : '';
}

/**
 * 丢弃响应体，避免本地连接一直挂着。
 * @param {Response} response
 */
async function discard(response) {
	try {
		await response.arrayBuffer();
	} catch { /* 忽略 */ }
}

/**
 * 验证“浏览器打开即登录”确实成立：
 * 1. 打开带令牌的地址，看服务端是否下发 cookie；
 * 2. 带上这个 cookie 访问裸地址，看是否 200（而不是 401）。
 *
 * @param {string} tokenUrl 带令牌的地址（每次校验单独生成，避免消耗真正要打开的地址）。
 * @param {string} baseUrl
 * @returns {Promise<{tokenUrlStatus: number|null, cookieIssued: boolean, baseStatus: number|null, loggedIn: boolean, html: string|null, error: string|null}>}
 */
export async function probeLogin(tokenUrl, baseUrl) {
	const result = { tokenUrlStatus: null, cookieIssued: false, baseStatus: null, loggedIn: false, html: null, error: null };
	const timeout = () => AbortSignal.timeout(PROBE_TIMEOUT_MS);
	try {
		const first = await fetch(tokenUrl, { redirect: 'manual', headers: { accept: 'text/html,*/*' }, signal: timeout() });
		result.tokenUrlStatus = first.status;
		const cookie = firstCookie(first.headers);
		result.cookieIssued = cookie.length > 0;
		await discard(first);
		if (cookie.length > 0) {
			const second = await fetch(baseUrl, { redirect: 'manual', headers: { accept: 'text/html,*/*', cookie }, signal: timeout() });
			result.baseStatus = second.status;
			result.loggedIn = second.status === 200;
			try {
				result.html = await second.text();
			} catch {
				result.html = null;
			}
		} else {
			result.loggedIn = first.status === 200;
		}
	} catch (error) {
		result.error = messageOf(error);
	}
	return result;
}

/**
 * 各平台启动默认浏览器的候选命令，按可靠性排序。
 * @param {string} url
 * @returns {Array<{id: string, command: string, args: string[], options?: object}>}
 */
export function browserLaunchers(url) {
	if (process.platform === 'win32') {
		const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
		return [
			{ id: 'rundll32-url-handler', command: `${systemRoot}\\System32\\rundll32.exe`, args: ['url.dll,FileProtocolHandler', url] },
			{ id: 'cmd-start', command: process.env.ComSpec ?? `${systemRoot}\\System32\\cmd.exe`, args: ['/d', '/c', `start "" "${url}"`], options: { windowsVerbatimArguments: true } },
			{ id: 'powershell-start-process', command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url.replace(/'/g, "''")}'`] }
		];
	}
	if (process.platform === 'darwin') return [{ id: 'open', command: 'open', args: [url] }];
	return [{ id: 'xdg-open', command: 'xdg-open', args: [url] }];
}

/**
 * 分离启动一个子进程并确认它真的 spawn 成功。
 * @param {{id: string, command: string, args: string[], options?: object}} launcher
 * @returns {Promise<void>}
 */
function spawnDetached(launcher) {
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawn(launcher.command, launcher.args, {
				detached: true,
				stdio: 'ignore',
				windowsHide: true,
				...(launcher.options ?? {})
			});
		} catch (error) {
			reject(error);
			return;
		}
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error !== undefined) {
				reject(error);
				return;
			}
			child.unref();
			resolve();
		};
		const timer = setTimeout(() => finish(), LAUNCH_HANDSHAKE_MS);
		child.once('error', (error) => finish(error));
		child.once('spawn', () => finish());
	});
}

/**
 * 用系统默认浏览器打开地址，逐个尝试候选启动方式。
 * @param {string} url
 * @returns {Promise<string>} 成功的启动方式 id。
 */
export async function launchBrowser(url) {
	const failures = [];
	for (const launcher of browserLaunchers(url)) {
		try {
			await spawnDetached(launcher);
			return launcher.id;
		} catch (error) {
			failures.push(`${launcher.id}: ${messageOf(error)}`);
		}
	}
	throw new Error(`dsh-open-web: 所有浏览器启动方式都失败（${failures.join('; ')}）`);
}

/** 工具允许的参数键与其类型。 */
const ARGUMENT_TYPES = { revealUrl: 'boolean', dryRun: 'boolean' };

/** 独立 web 实例的工具名（和 open_web_ui 并存）。 */
const STANDALONE_TOOL_NAME = 'open_standalone_web';

/** 独立 web 工具允许的 action 取值。 */
const STANDALONE_ACTIONS = new Set(['open', 'close', 'status']);

/** 独立 web 工具允许的参数键与其类型。 */
const STANDALONE_ARGUMENTS = { action: 'string', revealUrl: 'boolean', dryRun: 'boolean' };

/**
 * 校验并补齐独立 web 工具的参数（规则同 {@link normalizeArgs}：拒绝未知键与错误类型）。
 * @param {unknown} args
 * @returns {{action: string, revealUrl: boolean, dryRun: boolean}}
 */
export function normalizeStandaloneArgs(args) {
	const normalized = { action: 'open', revealUrl: false, dryRun: false };
	if (args === undefined || args === null) return normalized;
	if (typeof args !== 'object' || Array.isArray(args)) {
		throw new TypeError(`dsh-open-web: 参数必须是一个对象，收到 ${Array.isArray(args) ? 'array' : typeof args}`);
	}
	for (const key of Object.keys(args)) {
		if (!Object.hasOwn(STANDALONE_ARGUMENTS, key)) {
			throw new TypeError(`dsh-open-web: 不支持的参数 "${key}"（只接受 action、revealUrl、dryRun）`);
		}
	}
	for (const [key, expected] of Object.entries(STANDALONE_ARGUMENTS)) {
		const value = args[key];
		if (value === undefined) continue;
		if (typeof value !== expected) {
			throw new TypeError(`dsh-open-web: 参数 "${key}" 必须是 ${expected}，收到 ${typeof value}`);
		}
		if (key === 'action') {
			if (!STANDALONE_ACTIONS.has(value)) {
				throw new TypeError(`dsh-open-web: 参数 "action" 只能是 open / close / status，收到 "${value}"`);
			}
		}
		normalized[key] = value;
	}
	return normalized;
}

/**
 * 把独立 web 工具的结果渲染成文本。
 * @param {object} value
 * @returns {string}
 */
export function formatStandaloneValue(value) {
	const lines = [];
	if (value.action === 'close') {
		if (value.stopped !== true) {
			lines.push('独立 web 实例本来就没在跑。');
		} else if (value.mode === 'attached') {
			lines.push('已断开复用的 web 实例（那份进程仍在运行，没有杀掉它）。');
		} else {
			lines.push('已关掉独立的 web 实例。');
		}
		return lines.join('\n');
	}
	if (value.action === 'status') {
		lines.push(value.running === true ? '独立 web 实例正在运行。' : '独立 web 实例当前没有运行（下次调用会重新启动）。');
		if (value.running === true) {
			lines.push(value.mode === 'attached' ? '当前复用的是已经在跑的那份实例（没有额外进程）。' : '当前用的是插件自己起的实例。');
		}
		if (value.displayUrl) lines.push(`地址：${value.displayUrl}`);
		if (value.boots !== undefined) lines.push(`累计启动次数：${value.boots}；已运行：${Math.round((value.uptimeMs ?? 0) / 1000)} 秒`);
		if (value.lastError) lines.push(`上次错误：${value.lastError}`);
		if (value.rawUrl !== undefined) lines.push(`带令牌的原始地址（等同于登录凭据，请勿分享）：${value.rawUrl}`);
		return lines.join('\n');
	}
	if (value.error !== undefined) {
		lines.push('独立的 web 实例没能启动。');
		lines.push(String(value.error));
		return lines.join('\n');
	}
	if (value.opened === true) {
		lines.push('已在系统默认浏览器打开**独立的**网页版 DeepSeek Harness（另起的 `dsh web` 实例，有自己的 profile、插件和会话）。');
		if (value.mode === 'attached') {
			lines.push(`本次耗时：${value.readyMs} ms（复用了已经在运行的实例，没有另起进程）。`);
		} else {
			lines.push(`本次耗时：${value.readyMs} ms（${value.reused === true ? '实例已在预热中，直接复用' : '刚刚冷启动'}）；启动方式：${value.method}。`);
		}
	} else if (value.dryRun === true) {
		lines.push('自检完成：独立 web 实例已就绪，按 dryRun 要求没有打开浏览器。');
		lines.push(`地址：${value.displayUrl}（${value.mode === 'attached' ? '复用已有实例，无新进程' : `进程 PID ${value.pid}`}）`);
	} else {
		lines.push('实例已就绪，但没能自动打开浏览器。');
		lines.push(`地址：${value.displayUrl}`);
	}
	if (value.displayUrl && value.opened === true) lines.push(`地址：${value.displayUrl}`);
	if (value.rawUrl !== undefined) lines.push(`带令牌的原始地址（等同于登录凭据，请勿分享）：${value.rawUrl}`);
	for (const note of value.notes ?? []) lines.push(`- ${note}`);
	return lines.join('\n');
}
