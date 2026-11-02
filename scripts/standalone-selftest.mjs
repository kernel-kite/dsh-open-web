/**
 * 独立 web 实例（`dsh web`）控制器的端到端自检。
 *
 * 它真的会起一个 `dsh web` 进程，然后验证：
 *   1. 能从子进程输出里读到带令牌的地址（`dsh web: <url>`）；
 *   2. 该地址可用：首次请求 303 + Set-Cookie，带 cookie 再请求 200；
 *   3. 缓存复用：第二次 ensure() 不再启动新进程，耗时接近 0；
 *   4. status() 报告 PID 与运行状态；
 *   5. stop() 后进程真的没了。
 *
 * 用法：
 *   node scripts/standalone-selftest.mjs               # 用临时 DSH_HOME（不碰本机配置）
 *   node scripts/standalone-selftest.mjs --idle 4000   # 额外验证空闲回收
 *   node scripts/standalone-selftest.mjs --command "C:\path\dsh.cmd"
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { createStandaloneController, redactStandaloneUrl } from '../standalone-web.js';

const argv = process.argv.slice(2);

function flag(name) {
	const at = argv.indexOf(`--${name}`);
	return at === -1 ? undefined : argv[at + 1];
}

let failures = 0;
function check(label, ok, detail) {
	const mark = ok ? '✅' : '❌';
	if (!ok) failures += 1;
	console.log(`${mark} ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

/** 依次取 cookie 名值对。 */
function cookieOf(response) {
	const raw = typeof response.headers.getSetCookie === 'function'
		? response.headers.getSetCookie()
		: [response.headers.get('set-cookie') ?? ''];
	return raw.filter((item) => item.length > 0).map((item) => item.split(';')[0]).join('; ');
}

const root = await mkdtemp(join(tmpdir(), 'dsh-standalone-'));
const home = join(root, 'home');
process.env.DSH_HOME = home;

const logger = {
	info: (message, ...rest) => console.log(`[info] ${String(message).replace(/%[sd]/g, () => String(rest.shift()))}`),
	warn: (message, ...rest) => console.log(`[warn] ${String(message).replace(/%[sd]/g, () => String(rest.shift()))}`)
};

const controller = createStandaloneController({
	logger,
	config: {
		prewarm: false,
		// 自检要验证「真的能起一个进程」，所以关掉复用已有实例的分支。
		attach: false,
		bootTimeoutMs: Number(flag('timeout') ?? 180000),
		idleTimeoutMs: Number(flag('idle') ?? 0),
		command: flag('command')
	}
});

let ok = false;
try {
	console.log(`临时 DSH_HOME：${home}`);

	const coldStart = Date.now();
	const first = await controller.ensure();
	const coldMs = Date.now() - coldStart;
	check('冷启动并拿到地址', typeof first.url === 'string' && first.url.length > 0, `${coldMs} ms`);
	check('冷启动时不是复用', first.reused === false);
	check('地址带 token 参数', /[?&]token=[\w-]+/.test(first.url), redactStandaloneUrl(first.url));

	const stateAfterBoot = controller.status();
	check('status() 报告在跑', stateAfterBoot.running === true, `PID ${stateAfterBoot.pid}`);

	const bare = await fetch(first.url, { redirect: 'manual' });
	check('带令牌地址返回 303（铸 cookie 后跳转）', bare.status === 303, `HTTP ${bare.status}`);
	const cookie = cookieOf(bare);
	check('服务端下发了 cookie', cookie.length > 0, cookie.replace(/=[^;]+/, '=***'));

	if (cookie.length > 0) {
		const origin = new URL(first.url).origin;
		const authed = await fetch(`${origin}/`, { headers: { cookie }, redirect: 'manual' });
		check('带 cookie 访问裸地址返回 200（即已登录）', authed.status === 200, `HTTP ${authed.status}`);
	}

	const warmStart = Date.now();
	const second = await controller.ensure();
	const warmMs = Date.now() - warmStart;
	check('第二次 ensure() 复用同一实例', second.reused === true && second.url === first.url);
	check('复用耗时 < 100 ms', warmMs < 100, `${warmMs} ms`);

	const idleMs = Number(flag('idle') ?? 0);
	if (idleMs > 0) {
		console.log(`等待 ${idleMs + 3000} ms 观察空闲回收…`);
		await new Promise((resolve) => setTimeout(resolve, idleMs + 3000));
		check('空闲到期后自动回收', controller.status().running === false);
	}

	const stopped = await controller.stop('selftest');
	check('stop() 后实例不再在跑', controller.status().running === false, stopped ? '本次请求把它关了' : '此前已被空闲回收');
	await new Promise((resolve) => setTimeout(resolve, 500));
	check('关掉后 PID 不再存活', controller.status().pid === null);

	ok = failures === 0;
} catch (error) {
	failures += 1;
	console.error('❌ 自检异常：', error);
} finally {
	await controller.dispose().catch(() => {});
	await rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(ok ? '\n全部通过。' : `\n失败 ${failures} 项。`);
process.exit(ok ? 0 : 1);
