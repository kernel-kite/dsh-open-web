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

/**
 * 注入到 index.html 里的前置脚本：只有这次是“浏览器打开”（地址带 `#dsh-open-web`）
 * 时才跳过开场动画，桌面窗口不受影响。
 *
 * 关键点（与 dsh-startup-screen 的约定）：
 *  - 它的运行时看 `window.__DSH_STARTUP_SKIP__ === true` 就直接返回，不建 DOM、不播音；
 *  - 它的首屏兜底脚本只在“判定要播”时才会把该标志置 true，因此这里预设即可生效；
 *  - 首屏黑幕靠内联样式按 `html[data-dsh-open-web]` 隐藏，并把 9 秒兜底锁滚动一并解除。
 *
 * @param {string} marker 片段标记。
 * @returns {string} 可直接放进 `<script>` 的脚本文本（不含 `</script>`）。
 */
function buildSkipScript(marker) {
	const seenKey = JSON.stringify('dsh-startup-screen:shown');
	return [
		'(function(){try{',
		'var M=', JSON.stringify(String(marker)), ';',
		// 只认片段里“独立的一段”等于标记（允许 key=value 形式），避免把
		// `#dsh-open-web-other` 这类无关片段误判成“网页端”，从而误跳过动画。
		'var d=document,q=String(location.hash||"").replace(/^#/,"").split("&"),marked=false;',
		'for(var i=0;i<q.length;i++){if(q[i].split("=")[0]===M){marked=true}}',
		'function clean(){try{',
		'var r=d.getElementById("dsh-startup-root");',
		'if(r&&r.parentNode)r.parentNode.removeChild(r);',
		'd.documentElement.classList.remove("dsu-lock");',
		'if(d.body)d.body.style.overflow="";',
		'}catch(e){}}',
		'if(marked){',
		'try{window.__DSH_STARTUP_SKIP__=true}catch(e){}',
		'try{sessionStorage.setItem(', seenKey, ',"1")}catch(e){}',
		'try{',
		'd.documentElement.setAttribute("data-dsh-open-web","1");',
		'var s=d.createElement("style");s.id="dsh-open-web-style";',
		's.textContent="html[data-dsh-open-web] #dsh-startup-root,html[data-dsh-open-web] #dsh-startup-root.dsu-boot{display:none!important;visibility:hidden!important}"+',
		'"html[data-dsh-open-web].dsu-lock,html[data-dsh-open-web].dsu-lock body{overflow:auto!important}";',
		'(d.head||d.documentElement).appendChild(s);',
		'}catch(e){}',
		'clean();',
		'd.addEventListener("DOMContentLoaded",clean);',
		'setTimeout(clean,0);setTimeout(clean,400);setTimeout(clean,1600);',
		'}',
		'try{setTimeout(function(){try{',
		'fetch("/dsh-open-web/beacon?skip="+(marked?1:0)+"&started="+((window.__DSH_STARTUP_RUNNING__===true)?1:0),{cache:"no-store"});',
		'}catch(e){}},900)}catch(e){}',
		'}catch(e){}})()'
	].join('');
}

/**
 * 把“跳过开场动画”的前置脚本插到 `<head>` 开头（幂等）。
 *
 * 插在 head 开头可以保证它在 dsh-startup-screen 注入到 `<body>` 开头的兜底脚本
 * 之前执行 —— 那个兜底脚本不会重置 `__DSH_STARTUP_SKIP__`，所以预设值生效。
 *
 * @param {string} html index.html 原文。
 * @returns {string} 注入后的 html。
 */
export function injectStartupSkip(html) {
	if (typeof html !== 'string' || html.length === 0) return html;
	if (html.includes(`id="${SKIP_SCRIPT_ID}"`)) return html;
	const tag = `<script id="${SKIP_SCRIPT_ID}">${buildSkipScript(SKIP_MARKER)}</script>`;
	for (const pattern of [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i, /<body(\s[^>]*)?>/i]) {
		const match = pattern.exec(html);
		if (match === null) continue;
		const at = match.index + match[0].length;
		return html.slice(0, at) + tag + html.slice(at);
	}
	return tag + html;
}

/**
 * 给交给浏览器的地址加片段标记（不改动查询串里的令牌）。
 * @param {string} url
 * @returns {string}
 */
export function browserUrlWithMarker(url) {
	if (typeof url !== 'string' || url.length === 0) return url;
	return `${url.split('#')[0]}#${SKIP_MARKER}`;
}

/**
 * 记一条客户端上报（只含“是否跳过/是否已开始”这类布尔量）。
 * @param {URLSearchParams} query
 * @param {{headers: object}} req
 */
function recordBeacon(query, req) {
	const userAgent = String((req.headers ?? {})['user-agent'] ?? '');
	beaconLog.push({
		skip: String(query.get('skip') ?? '') === '1',
		started: String(query.get('started') ?? '') === '1',
		entry: /Electron/i.test(userAgent) ? 'desktop-window' : userAgent.length === 0 ? 'unknown' : 'browser',
		at: new Date().toISOString()
	});
	while (beaconLog.length > BEACON_KEEP) beaconLog.shift();
}

/**
 * 取宿主 Web 服务器（桌面端 Electron 若改用 file:// + IPC 下发前端时可能没有）。
 * @param {object} ctx
 * @returns {any}
 */
function webServerOf(ctx) {
	if (typeof ctx.get === 'function') {
		const viaGet = ctx.get('webServer');
		if (viaGet !== undefined && viaGet !== null) return viaGet;
	}
	return ctx.webServer;
}

/**
 * 注册自检上报路由；没有 webServer 时安静跳过。
 * @param {object} ctx
 * @returns {(() => void)|undefined}
 */
function registerBeaconRoute(ctx) {
	const server = webServerOf(ctx);
	if (server === undefined || server === null || typeof server.register !== 'function') return undefined;
	try {
		return server.register({
			kind: 'exact',
			path: BEACON_PATH,
			handler: (req, res) => {
				try {
					recordBeacon(new URL(String(req.url ?? '/'), 'http://127.0.0.1').searchParams, req);
				} catch { /* 畸形请求直接忽略 */ }
				try {
					res.writeHead(204, { 'Cache-Control': 'no-store' });
					res.end();
				} catch { /* 连接可能已断 */ }
			}
		});
	} catch (error) {
		ctx.logger?.warn?.('dsh-open-web: 自检路由注册失败（%s）', messageOf(error));
		return undefined;
	}
}

/**
 * 接管 index.html：注入“浏览器打开则跳过开场动画”的前置脚本。
 * @param {object} ctx
 * @returns {(() => void)|undefined}
 */
function installStartupSkip(ctx) {
	const server = webServerOf(ctx);
	if (server === undefined || server === null || typeof server.tapIndex !== 'function') {
		ctx.logger?.warn?.('dsh-open-web: 当前 profile 没有可用的 webServer.tapIndex()，网页端跳过开场动画未启用');
		return undefined;
	}
	return server.tapIndex((html) => injectStartupSkip(html));
}


/**
 * 校验工具参数。
 *
 * 宿主只对 `defineTool()` 编译出来的参数规格做运行期校验；本插件为规避
 * `@deepseek-ai/*` 的模块解析风险直接注册原始 JSON Schema，因此这里自行
 * 做一次严格校验：拒绝未知参数与类型不符的值，避免 `dryRun: "yes"` 这类
 * 输入被静默当成 `false` 而真的打开浏览器。
 *
 * @param {unknown} args
 * @returns {{revealUrl: boolean, dryRun: boolean}}
 */
export function normalizeArgs(args) {
	if (args === undefined || args === null) return { revealUrl: false, dryRun: false };
	if (typeof args !== 'object' || Array.isArray(args)) {
		throw new TypeError(`dsh-open-web: 参数必须是一个对象，收到 ${Array.isArray(args) ? 'array' : typeof args}`);
	}
	for (const key of Object.keys(args)) {
		if (!Object.hasOwn(ARGUMENT_TYPES, key)) throw new TypeError(`dsh-open-web: 不支持的参数 "${key}"（只接受 revealUrl、dryRun）`);
	}
	const normalized = { revealUrl: false, dryRun: false };
	for (const [key, expected] of Object.entries(ARGUMENT_TYPES)) {
		const value = args[key];
		if (value === undefined) continue;
		if (typeof value !== expected) throw new TypeError(`dsh-open-web: 参数 "${key}" 必须是 ${expected}，收到 ${typeof value}`);
		normalized[key] = value;
	}
	return normalized;
}

/**
 * 把工具结果渲染成模型与用户都能读的文本。
 * @param {object} value
 * @returns {string}
 */
export function formatValue(value) {
	const lines = [];
	if (value.opened === true) lines.push(`已在系统默认浏览器打开网页版 DeepSeek Harness（启动方式：${value.method}）。`);
	else if (value.dryRun === true) lines.push('自检完成：地址与登录状态已校验，按 dryRun 要求未打开浏览器。');
	else lines.push('没能自动打开浏览器。');
	lines.push(`地址：${value.displayUrl}`);
	if (value.loggedIn === true) {
		lines.push('登录校验：通过——地址已附带当前进程令牌，浏览器加载后即为已登录状态，无需再输入令牌或做任何设置。');
	} else if (value.tokenUrlStatus !== null) {
		lines.push(`登录校验：未完全通过（令牌地址 HTTP ${value.tokenUrlStatus}；带 cookie 访问裸地址 HTTP ${value.baseStatus ?? '未测'}）。仍然已尝试打开，如果页面要求登录，请让用户从桌面端重新打开或在 DSH 中重试。`);
	} else if (typeof value.probeError === 'string' && value.probeError.length > 0) {
		lines.push(`登录校验：无法完成（${value.probeError}）；地址本身仍已按上述方式打开。`);
	}
	if (value.rawUrl !== undefined) lines.push(`带令牌的原始地址（等同于登录凭据，请勿分享）：${value.rawUrl}`);
	if (value.startupSkipReady === true) lines.push('网页端开场动画：已跳过（桌面端照旧播放）。');
	else if (value.startupSkipReady === false) lines.push('网页端开场动画：未能确认已跳过（页面里没找到注入脚本），浏览器打开时可能仍会播放开场动画。');
	if (Array.isArray(value.clientReports)) {
		const reports = value.clientReports
			.map((item) => `${item.entry}：跳过=${item.skip ? '是' : '否'}，已开始播动画=${item.started ? '是' : '否'}（${item.at}）`);
		lines.push(`最近客户端上报：${reports.length === 0 ? '（暂无；浏览器页面加载后 1 秒内会上报）' : reports.join('；')}`);
	}
	for (const note of value.notes ?? []) lines.push(`- ${note}`);
	return lines.join('\n');
}

/**
 * 插件的工具定义（原始 JSON Schema 形状，等价于 defineTool 编译结果）。
 */
const toolParameters = {
	type: 'object',
	properties: {
		revealUrl: {
			type: 'boolean',
			description: '是否在结果里返回带令牌的原始链接（默认 false，只给脱敏地址）。仅当用户明确索要链接时设为 true。'
		},
		dryRun: {
			type: 'boolean',
			description: '只生成并校验已登录地址，不真的打开浏览器（自检、排查用）。'
		}
	},
	additionalProperties: false
};

/**
 * Host 插件入口。
 * @param {object} ctx Cordis 插件上下文。
 */
export function apply(ctx, config) {
	// Cordis 会把 profile patch 里的 `config` 作为第二个参数传进来（也可能不传）。
	// 注意：不能退回读 `ctx.config`——未在 inject 里声明 'config' 时 Cordis 会直接抛
	// 「cannot get property "config" without inject」，整个插件加载失败、工具全部消失。
	/** @type {unknown} */
	const pluginConfig = config !== null && typeof config === 'object' ? config : undefined;

	/** @type {object} */
	const tool = {
		name: TOOL_NAME,
		description: [
			'用系统默认浏览器打开“已登录”的网页版 DeepSeek Harness（当前桌面进程自带的 Web GUI）。',
			'地址由当前进程令牌授权，浏览器打开即为已登录状态，用户无需再做任何设置。',
			'当用户说“打开网页版 DSH / 在浏览器里打开 DeepSeek Harness / 网页版看看”时直接调用；不要自己拼裸地址（未带令牌会 401）。',
			'注意：用户说“打开 web / 独立 web / 另开一个 web”指的是另一个工具 open_standalone_web（另起的 dsh web 实例），不是本工具。',
			' / Open the DeepSeek Harness Web GUI in the default browser, already signed in through the running process token.'
		].join(''),
		parameters: toolParameters,
		output: {
			schema: {},
			render: (_args, value) => [{ type: 'text', text: formatValue(value) }]
		},
		presentCall: () => ({ card: 'generic', title: '打开网页版 DeepSeek Harness', kind: 'generic' }),
		isConcurrencySafe: () => true,
		async execute(rawArgs) {
			const args = normalizeArgs(rawArgs);
			const notes = [];
			const baseUrl = resolveBaseUrl(ctx);
			// 交给浏览器的地址与用于校验的地址分开生成：即使令牌是一次性的也不会被校验消耗。
			// 浏览器地址额外加 `#dsh-open-web` 片段标记，页面据此跳过开场动画；
			// 桌面窗口不带该标记，因此桌面端开场动画保持原样。
			const browserUrl = browserUrlWithMarker(authenticatedUrlFor(ctx, baseUrl));
			const probeUrl = authenticatedUrlFor(ctx, baseUrl);

			let probe = null;
			try {
				probe = await probeLogin(probeUrl, baseUrl);
			} catch (error) {
				notes.push(`登录校验异常：${messageOf(error)}`);
			}

			let opened = false;
			let method = null;
			if (args.dryRun !== true) {
				try {
					method = await launchBrowser(browserUrl);
					opened = true;
				} catch (error) {
					notes.push(messageOf(error));
				}
			}

			const value = {
				opened,
				dryRun: args.dryRun === true,
				method,
				displayUrl: redactUrl(browserUrl, baseUrl),
				tokenUrlStatus: probe === null ? null : probe.tokenUrlStatus,
				cookieIssued: probe === null ? false : probe.cookieIssued,
				baseStatus: probe === null ? null : probe.baseStatus,
				loggedIn: probe === null ? false : probe.loggedIn,
				startupSkipReady: probe !== null && typeof probe.html === 'string' && probe.html.includes(`id="${SKIP_SCRIPT_ID}"`),
				notes
			};
			// 工具返回值必须是“无损 JSON”：不能带值为 undefined 的自有属性。
			if (probe !== null && typeof probe.error === 'string' && probe.error.length > 0) value.probeError = probe.error;
			if (args.revealUrl === true) value.rawUrl = browserUrl;
			if (args.dryRun === true) value.clientReports = beaconLog.slice(-6);
			if (!opened && args.dryRun !== true && args.revealUrl !== true) {
				notes.push('浏览器未能自动打开；如用户需要链接，可再用 revealUrl: true 调用一次取回原始地址。');
			}
			return value;
		}
	};

	ctx.effect(() => ctx.tools.register(tool));

	ctx.effect(() => ctx.systemPrompt.section({
		name: 'tool:open-web',
		order: 110,
		text: () => [
			`打开网页版：用户要“打开网页版 DeepSeek Harness / 在浏览器打开 DSH / 网页版看这个对话”时，直接调用 ${TOOL_NAME} 工具，一次调用即可在系统默认浏览器打开**已登录**的网页版，用户不需要再输入令牌或做其它设置。`,
			'不要自己去拼 http://127.0.0.1:<端口>/ 的裸地址（没有令牌会返回 401），也不要用 shell 命令打开浏览器。',
			'工具返回的地址默认已脱敏；只有用户明确索要链接时，才用 revealUrl: true 再取一次带令牌的原始地址，并提醒用户该链接等同于本机登录凭据、不要分享。',
			'如果工具报告浏览器启动失败，请把失败原因告诉用户，并说明可以用 revealUrl: true 取链接手动打开。',
			'注意：用户说“打开 web / 独立 web / 另开一个 web”时不要用本工具，改用 open_standalone_web（另起的 dsh web 实例）。'
		].join('\n')
	}));

	ctx.effect(() => (registerBeaconRoute(ctx) ?? (() => {})));
	ctx.effect(() => (installStartupSkip(ctx) ?? (() => {})));

	// ── 独立 web 实例（dsh web）：常驻预热 + 秒开 ──────────────────────────
	const standalone = createStandaloneController({
		logger: ctx.logger,
		config: pluginConfig
	});

	/** 独立 web 实例的工具定义。 */
	const standaloneTool = {
		name: STANDALONE_TOOL_NAME,
		description: [
			'打开一个“独立启动”的网页版 DeepSeek Harness：在后台另起一个 `dsh web` 进程（有自己的 profile、插件和会话），',
			'插件已常驻预热，所以调用通常瞬间完成，直接用系统默认浏览器打开一个已登录的页面。',
			'若本机已经有在跑的 `dsh web`（例如被 watchdog 守护的固定端口实例），会直接复用那一份、不再另起进程（结果里 mode 为 attached）。',
			'用户说“打开 web / 打开独立 web / 起一个 web / 另开一个 web / 后台 web”时调用（action 默认 open）；',
			'说“关掉 web”时用 action: close；问“web 还开着吗”时用 action: status。',
			'注意：open_web_ui 打开的是当前桌面进程自带的网页版（同一份会话），两者不是一回事，不要混用。',
			' / Open a separately launched `dsh web` instance of DeepSeek Harness in the default browser.'
		].join(''),
		parameters: {
			type: 'object',
			properties: {
				action: {
					type: 'string',
					enum: ['open', 'close', 'status'],
					description: '默认 open：确保实例在跑并在浏览器打开；close：关掉实例；status：查询状态。'
				},
				revealUrl: {
					type: 'boolean',
					description: '是否在结果里返回带令牌的原始链接（默认 false，只给脱敏地址）。仅当用户明确索要链接时设为 true。'
				},
				dryRun: {
					type: 'boolean',
					description: '只把实例拉起来并校验，不真的打开浏览器（自检、预热用）。'
				}
			},
			additionalProperties: false
		},
		output: {
			schema: {},
			render: (_args, value) => [{ type: 'text', text: formatStandaloneValue(value) }]
		},
		presentCall: () => ({ card: 'generic', title: '打开独立 web 实例', kind: 'generic' }),
		isConcurrencySafe: () => true,
		async execute(rawArgs) {
			const args = normalizeStandaloneArgs(rawArgs);

			if (args.action === 'close') {
				const before = standalone.status();
				const stopped = await standalone.stop('tool');
				return { action: 'close', stopped, mode: before.mode };
			}

			if (args.action === 'status') {
				const current = standalone.status();
				const value = {
					action: 'status',
					running: current.running,
					mode: current.mode,
					displayUrl: current.url === null ? null : redactStandaloneUrl(current.url),
					pid: current.pid,
					boots: current.boots,
					uptimeMs: current.uptimeMs,
					lastError: current.lastError
				};
				if (args.revealUrl === true && current.url !== null) value.rawUrl = current.url;
				return value;
			}

			const notes = [];
			const startedAt = Date.now();
			let url;
			let reused = false;
			let mode = null;
			try {
				const ensured = await standalone.ensure();
				url = ensured.url;
				reused = ensured.reused === true;
				mode = ensured.mode;
			} catch (error) {
				return {
					action: 'open',
					opened: false,
					dryRun: args.dryRun === true,
					error: messageOf(error)
				};
			}

			let opened = false;
			let method = null;
			if (args.dryRun !== true) {
				try {
					method = await launchBrowser(url);
					opened = true;
				} catch (error) {
					notes.push(messageOf(error));
				}
			}

			const value = {
				action: 'open',
				opened,
				dryRun: args.dryRun === true,
				reused,
				mode,
				readyMs: Date.now() - startedAt,
				method,
				displayUrl: redactStandaloneUrl(url),
				pid: standalone.status().pid,
				notes
			};
			if (args.revealUrl === true) value.rawUrl = url;
			if (!opened && args.dryRun !== true && args.revealUrl !== true) {
				notes.push('浏览器未能自动打开；如用户需要链接，可再用 revealUrl: true 调用一次取回原始地址。');
			}
			return value;
		}
	};

	ctx.effect(() => ctx.tools.register(standaloneTool));

	ctx.effect(() => {
		standalone.warm();
		return () => {
			void standalone.dispose();
		};
	});

	ctx.effect(() => ctx.systemPrompt.section({
		name: 'tool:open-standalone-web',
		order: 111,
		text: () => [
			`独立 web 实例：用户说“打开 web / 打开独立 web / 起一个 web / 另开一个 web / 后台 web”时，直接调用 ${STANDALONE_TOOL_NAME}（默认 action=open）。`,
			'它打开的是**另起的 `dsh web` 进程**——有自己的 profile、插件集和会话，跟当前桌面窗口里看到的那一份不是同一份；插件已常驻预热，所以通常瞬间就能打开。',
			'如果本机已经有在跑的 `dsh web`（比如被 watchdog 守护的固定端口实例），工具会直接复用那一份：不另起进程，结果里 mode=attached；这种情况下 close 只是断开引用，不会去杀别人的进程，回复用户时要讲清楚。',
			`而 open_web_ui 打开的是**当前桌面进程自带的网页版**（同一份会话与插件）。用户说“打开网页版 / 网页版看看这个对话”时用 open_web_ui；说“打开 web”时用 ${STANDALONE_TOOL_NAME}。`,
			`用户说“关掉 web / 关掉独立 web”时调用 ${STANDALONE_TOOL_NAME} 且 action: close；问“web 开着吗 / web 状态”时用 action: status。`,
			'不要自己拼 http://127.0.0.1:<端口>/ 裸地址，也不要用 shell 起服务或打开浏览器。',
			'带令牌的地址默认脱敏；只有用户明确索要链接时才用 revealUrl: true，并提醒该链接等同于本机登录凭据、不要分享。'
		].join('\n')
	}));

	ctx.logger?.info?.('dsh-open-web: 已注册工具 %s', TOOL_NAME);
}
