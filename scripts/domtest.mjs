/**
 * 前置脚本的 DOM 行为测试：在假 DOM 里执行注入到 <head> 的那段脚本，验证
 *   1) 桌面窗口（地址无 #dsh-open-web）—— 一律不碰页面，动画照旧；
 *   2) 浏览器（地址带 #dsh-open-web）—— 置 SKIP、隐藏并移除启动遮罩、解锁滚动。
 *
 * 用 `node scripts/domtest.mjs` 运行，全部通过时退出码为 0。
 */
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

// 直接加载 index.js（纯 node 环境没有 @deepseek-ai/*，本插件故意不依赖它们）
const mod = await import('../index.js');
const { injectStartupSkip, browserUrlWithMarker, SKIP_MARKER } = mod;
assert.equal(typeof injectStartupSkip, 'function');
assert.equal(typeof browserUrlWithMarker, 'function');

/** 从 index.html 里取出我们注入的那段脚本正文。 */
function extractScript(html) {
	const id = 'id="dsh-open-web-skip"';
	const start = html.indexOf(id);
	assert.notEqual(start, -1, '注入后应当能找到脚本标签');
	const open = html.indexOf('>', start) + 1;
	const end = html.indexOf('</script>', open);
	assert.notEqual(end, -1, '脚本标签应当闭合');
	return { source: html.slice(open, end), index: start };
}

/** 搭一个记录所有副作用的最小 DOM。 */
function makeEnv({ hash, started }) {
	const calls = { fetched: [], inserted: [], matched: [], removed: [], attrs: [], classes: [] };
	const styleNodes = [];
	const root = {
		id: 'dsh-startup-root',
		parentNode: {
			removeChild(node) {
				calls.removed.push(node.id);
				root.parentNode = null;
			}
		}
	};
	const htmlEl = {
		attrs: {},
		classList: {
			remove(name) {
				calls.classes.push(`remove:${name}`);
			}
		},
		setAttribute(name, value) {
			htmlEl.attrs[name] = value;
			calls.attrs.push(`${name}=${value}`);
		}
	};
	const head = {
		appendChild(node) {
			styleNodes.push(node);
			calls.inserted.push(node.id ?? node.tagName ?? 'node');
		}
	};
	const listeners = {};
	const document = {
		documentElement: htmlEl,
		head,
		body: { style: { overflow: 'hidden' } },
		getElementById(id) {
			calls.matched.push(id);
			return id === 'dsh-startup-root' && root.parentNode !== null ? root : null;
		},
		createElement(tag) {
			return { tagName: tag.toUpperCase(), id: '', textContent: '' };
		},
		addEventListener(type, fn) {
			(listeners[type] ??= []).push(fn);
		}
	};
	const timers = [];
	const window = {
		__DSH_STARTUP_SKIP__: undefined,
		...(started ? { __DSH_STARTUP_RUNNING__: true } : {})
	};
	const session = new Map();
	const sandbox = {
		document,
		window,
		location: { hash },
		sessionStorage: {
			setItem(k, v) {
				session.set(k, v);
			},
			getItem(k) {
				return session.get(k) ?? null;
			}
		},
		fetch(url) {
			calls.fetched.push(String(url));
			return Promise.resolve({ ok: true });
		},
		setTimeout(fn, ms) {
			timers.push({ fn, ms });
			return timers.length;
		},
		clearTimeout() {}
	};
	sandbox.globalThis = sandbox;
	return { sandbox, calls, timers, styleNodes, window, listeners, htmlEl, root, session };
}

/** 跑完所有的 setTimeout（含脚本内部再次排的定时器）。 */
function drainTimers(env, limit = 40) {
	for (let i = 0; i < limit && env.timers.length > 0; i += 1) {
		const task = env.timers.shift();
		task.fn();
	}
}

/** 用我们真正注入的脚本源码执行一次。 */
function run(html, options) {
	const { source } = extractScript(html);
	const env = makeEnv(options);
	vm.runInNewContext(source, env.sandbox);
	return { env, source };
}

test('注入后脚本出现在 <head> 最前面（在 splash.js 之前）', () => {
	const html = '<!doctype html><html><head><meta charset="utf-8"><script defer src="/dsh-startup/splash.js"></script></head><body><div id="dsh-startup-root" class="dsu-root dsu-boot"></div></body></html>';
	const out = injectStartupSkip(html);
	const { index } = extractScript(out);
	assert.ok(index > out.indexOf('<head>'), '脚本应在 <head> 之内');
	assert.ok(index < out.indexOf('splash.js'), '脚本应排在 splash.js 之前');
	assert.ok(index < out.indexOf('dsh-startup-root'), '脚本应排在启动遮罩之前');
	// 幂等
	assert.equal(injectStartupSkip(out), out);
});

test('没有 <head> 的页面也要注进去（桌面端 HTML 的兜底路径）', () => {
	for (const html of ['<html><body><div id="dsh-startup-root"></div></body></html>', '<body>x</body>', 'no-tags']) {
		const out = injectStartupSkip(html);
		assert.ok(out.includes('id="dsh-open-web-skip"'), `应注入：${html}`);
		assert.equal(injectStartupSkip(out), out, '幂等');
	}
});

test('桌面窗口（无标记）：完全不碰页面，动画照旧', () => {
	const html = injectStartupSkip('<!doctype html><html><head></head><body><div id="dsh-startup-root" class="dsu-root dsu-boot"></div></body></html>');
	for (const hash of ['', '#', '#/session/abc', '#dsh-open-web-other']) {
		const { env } = run(html, { hash, started: false });
		assert.equal(env.window.__DSH_STARTUP_SKIP__, undefined, `hash=${hash} 不应设置 SKIP`);
		assert.deepEqual(env.calls.attrs, [], '不应改动 <html> 属性');
		assert.deepEqual(env.calls.inserted, [], '不应插入任何样式');
		assert.deepEqual(env.calls.removed, [], '不应移除启动遮罩');
		assert.deepEqual(env.calls.classes, [], '不应改 dsu-lock');
		assert.equal(env.root.parentNode !== null, true, '遮罩应原样保留');
		assert.equal(env.session.size, 0, '不应写 sessionStorage');
		drainTimers(env);
		// 唯一副作用：一条匿名上报
		assert.equal(env.calls.fetched.length, 1);
		assert.ok(env.calls.fetched[0].includes('skip=0'), '上报 skip=0');
		assert.ok(env.calls.fetched[0].includes('started=0'), '上报 started=0');
	}
});

test('桌面窗口（无标记）即使动画已开始也不碰页面', () => {
	const html = injectStartupSkip('<html><head></head><body><div id="dsh-startup-root" class="dsu-root dsu-boot"></div></body></html>');
	const { env } = run(html, { hash: '', started: true });
	assert.equal(env.window.__DSH_STARTUP_SKIP__, undefined);
	assert.deepEqual(env.calls.removed, []);
	drainTimers(env);
	assert.ok(env.calls.fetched[0].includes('started=1'), '上报 started=1');
});

test('浏览器（带标记）：置 SKIP、隐藏并移除遮罩、解锁滚动、上报 skip=1', () => {
	const html = injectStartupSkip('<!doctype html><html class="dsu-lock"><head></head><body><div id="dsh-startup-root" class="dsu-root dsu-boot"></div></body></html>');
	const { env, source } = run(html, { hash: `#${SKIP_MARKER}`, started: false });
	assert.equal(env.window.__DSH_STARTUP_SKIP__, true, '必须置 SKIP=true');
	assert.equal(env.htmlEl.attrs['data-dsh-open-web'], '1');
	const style = env.styleNodes[0];
	assert.equal(style.id, 'dsh-open-web-style');
	assert.ok(style.textContent.includes('display:none!important'), '遮罩必须被隐藏');
	assert.ok(style.textContent.includes('overflow:auto!important'), '滚动必须解锁');
	assert.equal(env.session.get('dsh-startup-screen:shown'), '1');
	assert.deepEqual(env.calls.removed, ['dsh-startup-root'], '遮罩节点应被移除');
	assert.deepEqual(env.calls.classes, ['remove:dsu-lock']);
	drainTimers(env);
	assert.equal(env.root.parentNode, null, '定时清理后仍然没有遮罩');
	assert.ok(env.calls.fetched.length === 1);
	assert.ok(env.calls.fetched[0].includes('skip=1'), '上报 skip=1');
	assert.ok(env.calls.fetched[0].includes('started=0'), '上报 started=0');
	assert.ok(!source.includes('</script'), '脚本正文里不能出现结束标签');
});

test('browserUrlWithMarker：只加片段，不动令牌查询串', () => {
	const url = 'http://127.0.0.1:65292/?token=deadbeef';
	const marked = browserUrlWithMarker(url);
	assert.equal(marked, `http://127.0.0.1:65292/?token=deadbeef#${SKIP_MARKER}`);
	assert.ok(marked.startsWith(url), '原地址（含令牌）必须完整保留');
	// 重复调用不叠加
	assert.equal(browserUrlWithMarker(marked), marked);
	// 已有别的片段时替换掉，保证标记唯一
	assert.equal(browserUrlWithMarker('http://h/?token=a#old'), `http://h/?token=a#${SKIP_MARKER}`);
	// 桌面端拿到的地址没有标记
	assert.ok(!url.includes(SKIP_MARKER));
});

test('注入的脚本在语法上是合法 JS（ES5 语法，可被浏览器直接执行）', () => {
	const { source } = extractScript(injectStartupSkip('<html><head></head><body></body></html>'));
	assert.doesNotThrow(() => new vm.Script(source));
	assert.ok(!/=>|\bconst\b|\blet\b/.test(source), '避免现代语法，兼容桌面端内置浏览器');
});
