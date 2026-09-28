// 当 github.com:443 被网络拦掉、但 api.github.com 还能通时，用 Git Data API 完成推送。
// 效果与 git push 等价：上传 blob → 建 tree → 建 commit → 移动分支引用。
//
// 用法：node tools/push-via-api.mjs <owner>/<repo> <branch> [--dry-run]
// 前提：本地 HEAD 的父提交已经存在于远端（也就是只推一个待推送的提交）。

import { execFileSync } from 'node:child_process';

const [repoArg, branchArg, ...rest] = process.argv.slice(2);
const dryRun = rest.includes('--dry-run');
const force = rest.includes('--force');

if (!repoArg || !repoArg.includes('/')) {
  console.error('用法：node tools/push-via-api.mjs <owner>/<repo> <branch> [--dry-run]');
  process.exit(2);
}
const [owner, repo] = repoArg.split('/');
const branch = branchArg || 'main';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
if (!token) {
  console.error('拿不到 GitHub token，先执行 gh auth login');
  process.exit(2);
}

async function api(path, init = {}) {
  const res = await fetch('https://api.github.com' + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'media-grabber-push',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${init.method || 'GET'} ${path} → HTTP ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

// ---------------------------------------------------------------- 本地状态

const head = git('rev-parse', 'HEAD');
// 注意：git 提交对象里 message 以换行结尾，这里不能 trim，
// 否则重建出来的 commit sha 会和本地对不上（踩过一次）。
const headMessage = execFileSync('git', ['log', '-1', '--format=%B'], { encoding: 'utf8' }).replace(/\n*$/, '\n');
const meta = Object.fromEntries(
  git('log', '-1', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI')
    .split('\u0000')
    .map((v, i) => [['authorName', 'authorEmail', 'authorDate', 'committerName', 'committerEmail', 'committerDate'][i], v])
);
const parentSha = git('rev-parse', 'HEAD^');
const parentTree = git('rev-parse', 'HEAD^^{tree}');

const changed = git('diff', '--name-status', 'HEAD^', 'HEAD')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [status, ...paths] = line.split('\t');
    return { status, path: paths[paths.length - 1] };
  });

console.log(`本地提交 ${head.slice(0, 7)} → ${headMessage.split('\n')[0]}`);
console.log(`父提交   ${parentSha.slice(0, 7)}`);
console.log(`改动文件 ${changed.length} 个：`);
for (const c of changed) console.log(`  ${c.status}  ${c.path}`);

if (!changed.length) {
  console.log('没有改动，无需推送。');
  process.exit(0);
}

// ---------------------------------------------------------------- 远端状态

const ref = await api(`/repos/${owner}/${repo}/git/ref/heads/${branch}`);
const remoteSha = ref.object.sha;
console.log(`\n远端 ${branch} 当前指向 ${remoteSha.slice(0, 7)}`);

if (remoteSha === head) {
  console.log('远端已经是这个提交，无需推送。');
  process.exit(0);
}
if (remoteSha !== parentSha) {
  // 远端已经有一个内容等价、只是 sha 不同的提交时，允许用 --force 换成与本地一致的那个
  const confirm = await api(`/repos/${owner}/${repo}/git/commits/${remoteSha}`).catch(() => null);
  const localTree = git('rev-parse', 'HEAD^{tree}');
  const sameContent = force && confirm && confirm.tree && confirm.tree.sha === localTree;
  if (!sameContent) {
    console.error(
      `远端指向的不是本地 HEAD 的父提交（远端 ${remoteSha.slice(0, 7)}，父提交 ${parentSha.slice(0, 7)}），` +
        '这个脚本只处理「推一个提交」的情况。若远端是内容等价的另一个提交，加 --force 覆盖。'
    );
    process.exit(1);
  }
  console.log(`远端 ${remoteSha.slice(0, 7)} 与本地内容一致（tree 相同），用 --force 换成与本地 sha 相同的提交`);
}

// ---------------------------------------------------------------- 上传

if (dryRun) {
  console.log('\n--dry-run：到此为止，不做任何写入。');
  process.exit(0);
}

const treeEntries = [];
for (const c of changed) {
  if (c.status === 'D') {
    // 删除：在 tree 里把 sha 置为 null
    treeEntries.push({ path: c.path, mode: '100644', type: 'blob', sha: null });
    console.log(`  删除 ${c.path}`);
    continue;
  }
  const buf = execFileSync('git', ['show', `HEAD:${c.path}`], { maxBuffer: 64 * 1024 * 1024 });
  const blob = await api(`/repos/${owner}/${repo}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' }),
  });
  const mode = execFileSync('git', ['ls-tree', 'HEAD', c.path], { encoding: 'utf8' }).trim().split(/\s+/)[0] || '100644';
  treeEntries.push({ path: c.path, mode, type: 'blob', sha: blob.sha });
  console.log(`  上传 ${c.path}（${buf.length} 字节）`);
}

const tree = await api(`/repos/${owner}/${repo}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ base_tree: parentTree, tree: treeEntries }),
});
console.log(`\n新 tree ${tree.sha.slice(0, 7)}`);

const commit = await api(`/repos/${owner}/${repo}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({
    message: headMessage,
    tree: tree.sha,
    parents: [parentSha],
    author: { name: meta.authorName, email: meta.authorEmail, date: meta.authorDate },
    committer: { name: meta.committerName, email: meta.committerEmail, date: meta.committerDate },
  }),
});
console.log(`新 commit ${commit.sha.slice(0, 7)}`);

await api(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
  method: 'PATCH',
  body: JSON.stringify({ sha: commit.sha, force: !!force && remoteSha !== parentSha }),
});
console.log(`已把 ${branch} 指向 ${commit.sha.slice(0, 7)}`);

// ---------------------------------------------------------------- 核对

if (commit.sha === head) {
  console.log('\n✓ 远端提交与本地 HEAD 完全一致（同一个 sha），本地无需再做同步。');
} else {
  console.log(`\n注意：远端生成的 sha 与本地不同（本地 ${head.slice(0, 7)}，远端 ${commit.sha.slice(0, 7)}）。`);
  console.log('内容是一样的，但历史分叉了。执行下面命令让本地对齐远端：');
  console.log(`  git fetch origin ${branch} && git reset --hard origin/${branch}`);
  process.exit(3);
}
