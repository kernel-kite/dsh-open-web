/**
 * dsh-open-web 离线自检：不打开浏览器，只验证纯函数与登录校验的“负向路径”。
 *
 * 用法：node scripts/selftest.mjs
 *   - 参数校验（类型/未知键）
 *   - 地址脱敏（绝不能把令牌留在展示文本里）
 *   - 浏览器启动候选命令的形状
 *   - probeLogin 对“未登录地址”必须返回 loggedIn=false（防止校验恒真）
 */

import assert from 'node:assert/strict';
import { normalizeArgs, redactUrl, browserLaunchers, probeLogin, injectStartupSkip, browserUrlWithMarker } from '../index.js';

const checks = [];
function check(name, fn) {
	checks.push([name, fn]);
}

check('normalizeArgs 空参数 → 全 false', () => {
	assert.deepEqual(normalizeArgs(undefined), { revealUrl: false, dryRun: false });
	assert.deepEqual(normalizeArgs({}), { revealUrl: false, dryRun: false });
});

check('normalizeArgs 正确透传布尔值', () => {
	assert.deepEqual(normalizeArgs({ dryRun: true }), { revealUrl: false, dryRun: true });
	assert.deepEqual(normalizeArgs({ revealUrl: true, dryRun: false }), { revealUrl: true, dryRun: false });
});

check('normalizeArgs 拒绝字符串/数字冒充布尔', () => {
	assert.throws(() => normalizeArgs({ dryRun: 'yes' }), /必须是 boolean/);
	assert.throws(() => normalizeArgs({ dryRun: 123 }), /必须是 boolean/);
	assert.throws(() => normalizeArgs({ revealUrl: 'true' }), /必须是 boolean/);
});

check('normalizeArgs 拒绝未知参数与非对象', () => {
	assert.throws(() => normalizeArgs({ foo: 1 }), /不支持的参数/);
	assert.throws(() => normalizeArgs([]), /必须是一个对象/);
	assert.throws(() => normalizeArgs('x'), /必须是一个对象/);
});

check('redactUrl 展示文本里不残留令牌', () => {
	const base = 'http://127.0.0.1:65292';
	const authed = `${base}/?token=yO6w-GMAoCd7x7yWC5LYkMm7G42V-hQyBa1Bt30gtRI`;
	const shown = redactUrl(authed, base);
	assert.equal(shown, `${base}/…（已附带登录令牌）`);
	assert.ok(!shown.includes('yO6w'), '脱敏后不应出现令牌片段');
});

check('redactUrl 对非本 base 的地址也兜底脱敏', () => {
	const shown = redactUrl('https://example.com/cb?access_token=SECRET&x=1', 'http://127.0.0.1:65292');
	assert.ok(!shown.includes('SECRET'), '兜底规则必须抹掉令牌');
});

check('browserLaunchers 在当前平台给出非空候选且保留完整 URL', () => {
	const url = 'http://127.0.0.1:65292/?token=abc&x=1';
	const list = browserLaunchers(url);
	assert.ok(list.length > 0);
	for (const launcher of list) {
		assert.equal(typeof launcher.id, 'string');
		assert.equal(typeof launcher.command, 'string');
		assert.ok(Array.isArray(launcher.args));
		assert.ok(launcher.args.some((arg) => arg.includes(url)), `${launcher.id} 应带上完整 URL`);
	}
	if (process.platform === 'win32') {
		assert.deepEqual(list.map((l) => l.id), ['rundll32-url-handler', 'cmd-start', 'powershell-start-process']);
	}
});

check('browserUrlWithMarker 只加片段标记、不动令牌查询串', () => {
	const url = 'http://127.0.0.1:65292/?token=abc&x=1';
	const marked = browserUrlWithMarker(url);
	assert.equal(marked, `${url}#dsh-open-web`);
	assert.equal(browserUrlWithMarker(`${url}#old`), `${url}#dsh-open-web`);
	assert.equal(browserUrlWithMarker(''), '');
});

check('injectStartupSkip 把跳过脚本插在 head 最前面且幂等', () => {
	const html = [
		'<!doctype html><html><head><meta charset="utf-8"></head><body>',
		'<div id="dsh-startup-root" class="dsu-root dsu-boot"></div>',
		'<script>window.__DSH_STARTUP_BOOT__="index";</script>',
		'<script defer src="/dsh-startup/splash.js"></script>',
		'</body></html>'
	].join('');
	const out = injectStartupSkip(html);
	assert.ok(out.includes('id="dsh-open-web-skip"'), '必须注入脚本');
	assert.ok(out.indexOf('dsh-open-web-skip') < out.indexOf('<meta charset'), '要插在 head 最前面');
	assert.ok(out.indexOf('dsh-open-web-skip') < out.indexOf('dsh-startup-root'), '必须早于黑幕节点');
	assert.equal(injectStartupSkip(out), out, '重复注入应保持幂等');
});

check('injectStartupSkip 的脚本内容关键点齐全、且不会提前闭合 script', () => {
	const out = injectStartupSkip('<html><head></head><body></body></html>');
	const start = out.indexOf('id="dsh-open-web-skip"');
	const end = out.indexOf('</script>', start);
	assert.ok(start > 0 && end > start);
	const script = out.slice(start, end);
	assert.ok(script.includes('__DSH_STARTUP_SKIP__'), '要让 dsh-startup-screen 运行时跳过');
	assert.ok(script.includes('location.hash'), '必须按片段标记判断，桌面窗口不带标记');
	assert.ok(script.includes('display:none!important'), '必须隐藏首屏黑幕');
	assert.ok(script.includes('DOMContentLoaded'), '必须在 DOM 就绪后清场');
	assert.ok(script.includes('/dsh-open-web/beacon'), '自检上报缺失');
	assert.ok(!script.includes('</script>'), '内联脚本里不能出现闭合标签');
});

check('injectStartupSkip 对没有 head 的 html 也能注入', () => {
	const out = injectStartupSkip('<body>hello</body>');
	assert.ok(out.includes('dsh-open-web-skip'));
});

check('probeLogin 对未带令牌的地址返回未登录', async () => {
	const base = 'http://127.0.0.1:65292';
	const probe = await probeLogin(`${base}/`, base);
	if (probe.error !== null) {
		// 端口上没有服务时跳过（例如桌面端未运行），不算失败。
		assert.match(probe.error, /fetch failed|ECONNREFUSED|connect/i);
		return;
	}
	assert.notEqual(probe.tokenUrlStatus, 200, `裸地址不应是 200，实际 ${probe.tokenUrlStatus}`);
	assert.equal(probe.loggedIn, false, '裸地址必须判定为未登录');
});

let failed = 0;
for (const [name, fn] of checks) {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (error) {
		failed += 1;
		console.error(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`);
	}
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exitCode = failed === 0 ? 0 : 1;
