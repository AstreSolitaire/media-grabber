// 一次跑完所有检查：静态校验 → 单元/集成测试 → 真实浏览器端到端。
// 用法：node test/run-all.mjs        （默认跑浏览器冒烟测试）
//       MG_SKIP_SMOKE=1 node test/run-all.mjs   （跳过浏览器部分，速度更快）

import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const steps = [
  { name: '静态校验（manifest / 语法 / 消息链路）', cmd: ['tools/verify.mjs'] },
  { name: '单元与集成测试（解析 / 解密 / 转封装）', cmd: ['--test', 'test/aes.test.mjs', 'test/hls.test.mjs', 'test/remux.test.mjs', 'test/features.test.mjs'] },
  { name: '用户脚本构建与结构自检', cmd: ['tools/build-userscript.mjs'] },
];
if (process.env.MG_SKIP_SMOKE !== '1') {
  steps.push({ name: '扩展版：真实浏览器端到端冒烟测试', cmd: ['test/smoke.mjs'] });
  steps.push({ name: '用户脚本版：真实浏览器端到端测试', cmd: ['test/userscript-smoke.mjs'] });
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

let failed = 0;
for (const step of steps) {
  console.log('\n' + '='.repeat(72));
  console.log('▶ ' + step.name);
  console.log('='.repeat(72));
  const code = await run(step.cmd);
  if (code !== 0) {
    failed++;
    console.log(`✗ ${step.name} 未通过（退出码 ${code}）`);
  } else {
    console.log(`✓ ${step.name} 通过`);
  }
}

console.log('\n' + '='.repeat(72));
console.log(failed ? `${failed}/${steps.length} 个步骤未通过` : `全部 ${steps.length} 个步骤通过`);
process.exit(failed ? 1 : 0);
