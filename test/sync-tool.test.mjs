import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

// Isolate the coordinator's durable roster: this file also opens tutor
// Sessions, and a test run must never touch the developer's real roster.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'mimir-sync-test-'))
import { getCoordinator } from '../coordinator.js'
import { apply as applySync } from '../sync-tool.js'

process.env.GIT_AUTHOR_NAME = 'Mimir Test'
process.env.GIT_AUTHOR_EMAIL = 'mimir@example.invalid'
process.env.GIT_COMMITTER_NAME = 'Mimir Test'
process.env.GIT_COMMITTER_EMAIL = 'mimir@example.invalid'
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_CONFIG_GLOBAL = '/dev/null'

/** Create a vault-shaped directory with personal files the default scope must ignore. */
async function makeVault(root, name) {
  const vault = join(root, name)
  await mkdir(join(vault, 'Learn'), { recursive: true })
  await mkdir(join(vault, 'Tools'), { recursive: true })
  await mkdir(join(vault, '.obsidian'), { recursive: true })
  await writeFile(join(vault, 'Learn/note.md'), '# note\n')
  await writeFile(join(vault, 'Tools/x.mjs'), 'export {}\n')
  await writeFile(join(vault, 'private.md'), 'secret\n')
  await writeFile(join(vault, '.obsidian/workspace.json'), '{}\n')
  return vault
}

/** Create a bare remote. */
function makeBare(path) {
  execFileSync('git', ['init', '--bare', '--initial-branch=main', path], { stdio: 'pipe' })
}

/** Apply the sync tool to a fake Leader and return the callable. */
function applyTool(cwd, leaderId) {
  const tools = new Map()
  const agents = new Map()
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
      },
    },
    agents: {
      get(id) {
        return agents.get(id)
      },
    },
  }
  applySync(ctx)
  const leader = {
    id: leaderId,
    session: { id: leaderId, header: { cwd } },
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
  }
  return {
    tool: tools.get('mimir_leader_sync'),
    exec: { agent: leader, signal: new AbortController().signal, callId: 'call-1' },
    agents,
  }
}

/** Git output for assertions. */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

test('bind initialises a repo, tracks only Learn/Tools, and syncs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-sync-bind-'))
  const vault = await makeVault(root, 'vault')
  const bare = join(root, 'remote.git')
  makeBare(bare)

  const { tool, exec } = applyTool(vault, 'leader-bind')
  const bound = await tool.execute({ action: 'bind', remote: bare, branch: 'main' }, exec)
  assert.match(bound.note, /已初始化/)

  const tree = git(bare, ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main'])
  assert.match(tree, /Learn\/note\.md/)
  assert.match(tree, /Tools\/x\.mjs/)
  assert.match(tree, /\.gitignore/)
  assert.doesNotMatch(tree, /private\.md/)
  assert.doesNotMatch(tree, /\.obsidian/)

  const ignore = await readFile(join(vault, '.gitignore'), 'utf8')
  assert.match(ignore, /!Learn\//)
  assert.match(ignore, /!Tools\//)

  const status = await tool.execute({ action: 'status' }, exec)
  assert.match(status.note, /分支：main/)
  assert.match(status.note, /工作区：干净/)

  await writeFile(join(vault, 'Learn/note.md'), '# note v2\n')
  const synced = await tool.execute({ action: 'sync' }, exec)
  assert.match(synced.note, /同步完成/)
  assert.match(git(bare, ['--git-dir', bare, 'show', 'main:Learn/note.md']), /note v2/)
  assert.equal(getCoordinator().snapshot().holder, null)
})

test('clone on a second machine and pull changes back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-sync-cross-'))
  const vaultA = await makeVault(root, 'vault-a')
  const vaultB = join(root, 'vault-b')
  await mkdir(vaultB, { recursive: true })
  const bare = join(root, 'remote.git')
  makeBare(bare)

  const a = applyTool(vaultA, 'leader-cross-a')
  await a.tool.execute({ action: 'bind', remote: bare, branch: 'main' }, a.exec)

  const b = applyTool(vaultB, 'leader-cross-b')
  const cloned = await b.tool.execute({ action: 'clone', remote: bare, branch: 'main' }, b.exec)
  assert.match(cloned.note, /已从/)
  assert.match(await readFile(join(vaultB, 'Learn/note.md'), 'utf8'), /# note/)

  await writeFile(join(vaultB, 'Learn/note.md'), '# from B\n')
  await b.tool.execute({ action: 'sync' }, b.exec)

  await writeFile(join(vaultA, 'Learn/other.md'), '# from A\n')
  const pulled = await a.tool.execute({ action: 'sync' }, a.exec)
  assert.match(pulled.note, /拉取了 1 个远端提交/)
  assert.match(await readFile(join(vaultA, 'Learn/note.md'), 'utf8'), /from B/)
  assert.equal(git(bare, ['--git-dir', bare, 'show', 'main:Learn/other.md']), '# from A')
})

test('bind on an empty directory clones a remote that already has content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-sync-bindclone-'))
  const vaultA = await makeVault(root, 'vault-a')
  const vaultB = join(root, 'vault-b')
  await mkdir(vaultB, { recursive: true })
  const bare = join(root, 'remote.git')
  makeBare(bare)

  const a = applyTool(vaultA, 'leader-bindclone-a')
  await a.tool.execute({ action: 'bind', remote: bare, branch: 'main' }, a.exec)

  const b = applyTool(vaultB, 'leader-bindclone-b')
  const result = await b.tool.execute({ action: 'bind', remote: bare, branch: 'main' }, b.exec)
  assert.match(result.note, /已从/)
  assert.match(await readFile(join(vaultB, 'Learn/note.md'), 'utf8'), /# note/)
})

test('a conflicting sync aborts the rebase and preserves the local commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-sync-conflict-'))
  const vaultA = await makeVault(root, 'vault-a')
  const vaultB = join(root, 'vault-b')
  await mkdir(vaultB, { recursive: true })
  const bare = join(root, 'remote.git')
  makeBare(bare)

  const a = applyTool(vaultA, 'leader-conflict-a')
  await a.tool.execute({ action: 'bind', remote: bare, branch: 'main' }, a.exec)
  const b = applyTool(vaultB, 'leader-conflict-b')
  await b.tool.execute({ action: 'clone', remote: bare, branch: 'main' }, b.exec)

  await writeFile(join(vaultA, 'Learn/conflict.md'), 'A\n')
  await a.tool.execute({ action: 'sync' }, a.exec)
  await writeFile(join(vaultB, 'Learn/conflict.md'), 'B\n')

  await assert.rejects(
    b.tool.execute({ action: 'sync' }, b.exec),
    (error) => {
      assert.match(error.message, /同步冲突/)
      assert.match(error.message, /Learn\/conflict\.md/)
      assert.match(error.message, /已撤销 rebase/)
      return true
    },
  )
  assert.equal(await readFile(join(vaultB, 'Learn/conflict.md'), 'utf8'), 'B\n')
  assert.doesNotMatch(git(vaultB, ['status', '--porcelain=v1', '--branch']), /rebase/)
  const aheadBehind = git(vaultB, ['rev-list', '--left-right', '--count', 'HEAD...origin/main'])
  assert.match(aheadBehind, /^\d+\t\d+$/)
})

test('status explains an unbound directory, and paths outside it are refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-sync-unbound-'))
  const vault = join(root, 'vault')
  await mkdir(join(vault, 'Learn'), { recursive: true })
  await writeFile(join(vault, 'Learn/note.md'), '# note\n')

  const { tool, exec } = applyTool(vault, 'leader-unbound')
  const status = await tool.execute({ action: 'status' }, exec)
  assert.match(status.note, /还没有 Git 仓库/)
  assert.match(status.note, /action=bind/)

  await assert.rejects(
    tool.execute({ action: 'bind', remote: join(root, 'remote.git'), path: '..' }, exec),
    /path 必须位于当前 Leader 工作目录内/,
  )
  await assert.rejects(
    tool.execute({ action: 'sync' }, exec),
    /还不是 Git 仓库/,
  )
})

test('sync refuses while a tutor opened by the Leader is running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-sync-running-'))
  const vault = await makeVault(root, 'vault')
  const bare = join(root, 'remote.git')
  makeBare(bare)
  const leaderId = 'leader-running'

  const { tool, exec, agents } = applyTool(vault, leaderId)
  await tool.execute({ action: 'bind', remote: bare, branch: 'main' }, exec)
  getCoordinator().registerMentor(leaderId, {
    sessionId: 'mentor-running',
    title: '运行中的模块',
    createdAt: Date.now(),
  })
  agents.set('mentor-running', {
    id: 'mentor-running',
    status: 'running',
    inbox: { nextTurn: [], nextStep: [] },
  })

  await assert.rejects(tool.execute({ action: 'sync' }, exec), /还有导师在运行/)
  assert.equal(getCoordinator().snapshot().holder, null)
})

test('bind refuses to replace an existing origin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-sync-origin-'))
  const vault = await makeVault(root, 'vault')
  const bareA = join(root, 'remote-a.git')
  const bareB = join(root, 'remote-b.git')
  makeBare(bareA)
  makeBare(bareB)

  const { tool, exec } = applyTool(vault, 'leader-origin')
  await tool.execute({ action: 'bind', remote: bareA, branch: 'main' }, exec)
  await assert.rejects(
    tool.execute({ action: 'bind', remote: bareB, branch: 'main' }, exec),
    /origin 已经指向/,
  )
  assert.match(git(vault, ['remote', 'get-url', 'origin']), /remote-a\.git$/)
})
