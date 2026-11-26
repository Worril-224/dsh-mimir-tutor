/**
 * `mimir_leader_sync` — bind the learning vault to a Git repository and sync it
 * across machines.
 *
 * The Leader owns this because it already coordinates every write to the
 * vault: syncing while a tutor is mid-write would commit or rebase a tree that
 * is still changing. The tool therefore:
 *
 *  - only operates on the Leader Session's own directory (or a path inside it);
 *  - refuses while any tutor it opened is running;
 *  - holds the same FIFO shared-write lease as the tutors while it works, so a
 *    tutor cannot start a shared write in the middle of a rebase;
 *  - keeps a fresh repository's default scope to `Learn/` and `Tools/`, so a
 *    vault full of personal notes is not uploaded by accident;
 *  - aborts a conflicting rebase instead of leaving half-resolved conflict
 *    markers in the vault.
 *
 * Authentication is deliberately left to the machine's Git configuration
 * (SSH key, macOS keychain, credential helper). The tool never prompts for a
 * password or stores a token.
 *
 * @module dsh-mimir-tutor/sync-tool
 */

import { execFile } from 'node:child_process'
import { access, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { getCoordinator } from './coordinator.js'

/** Plugin name shown by the loader. */
export const name = 'mimir-leader-sync'

/** Host services this tool reads. */
export const inject = ['tools', 'agents']

const execFileAsync = promisify(execFile)

/** Longest a single Git command may run. */
const GIT_TIMEOUT_MS = 120_000

/** A fetch/ls-remote is expected to be quick; a hung network must not hold the lease forever. */
const NETWORK_TIMEOUT_MS = 45_000

/** The sync lease is longer than an ordinary shared-write lease: clone/push may take a while. */
const SYNC_LEASE_TTL_MS = 600_000

/** Default scope of a repository this tool creates. */
const DEFAULT_GITIGNORE = `# Mimir 同步：默认只跟踪学习资料和它们的维护工具。
# 个人笔记、Obsidian 工作区设置和附件不在这里的范围内；要扩展时在下面追加规则。
*
!.gitignore
!Learn/
!Learn/**
!Tools/
!Tools/**
`

/**
 * The calling Leader Session.
 * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec - tool execution.
 * @returns {import('@deepseek-ai/dsh-agent').Agent} the calling agent.
 */
function callerOf(exec) {
  const caller = exec === undefined ? undefined : exec.agent
  if (caller === undefined) throw new Error('mimir_leader_sync 只能在 Mimir · Leader 会话里调用')
  return caller
}

/**
 * Validate a remote Git URL or local repository path.
 * @param {unknown} raw - model-supplied remote.
 * @returns {string} the trimmed remote.
 */
function remoteOf(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') throw new Error('remote 不能为空；填入 GitHub 仓库地址，例如 https://github.com/<你>/<库>.git')
  if (text.length > 500) throw new Error('remote 太长；填仓库地址即可，不要拼 access token。')
  if (text.startsWith('-') || /[\s\u0000-\u001f]/.test(text)) {
    throw new Error('remote 不是有效的 Git 地址：不能以 - 开头，也不能包含空白或控制字符。')
  }
  // Do not let a prompt select an arbitrary Git transport such as `ext::`,
  // which can execute a command. GitHub, SSH, local paths and file:// cover
  // every supported sync setup.
  if (!/^(https?:\/\/|ssh:\/\/|git:\/\/|git@[^:/]+:|file:\/\/|\/|\.{1,2}\/|[A-Za-z]:[\\/])/i.test(text)) {
    throw new Error('remote 只支持 GitHub/Git 的 HTTPS、SSH、git://、file:// 或本地路径；不支持 ext:: 之类的传输。')
  }
  return text
}

/**
 * Validate a branch name.
 * @param {unknown} raw - model-supplied branch.
 * @returns {string} the trimmed branch.
 */
function branchOf(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') throw new Error('branch 不能为空')
  if (text.length > 200 || text.startsWith('-') || text.includes('..') || text.includes('//')
    || text.endsWith('/') || text.endsWith('.') || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(text)) {
    throw new Error(`branch 不是有效的分支名：${text}`)
  }
  return text
}

/**
 * Resolve a model-supplied path inside the Leader's directory.
 * Absolute paths outside that directory and `..` escapes are refused, so a
 * prompt cannot point the sync at the user's home or another checkout.
 * @param {string} cwd - Leader Session working directory.
 * @param {unknown} raw - optional relative path.
 * @returns {Promise<string>} the real target path.
 */
async function targetOf(cwd, raw) {
  const requested = raw === undefined || raw === '' ? cwd : resolve(cwd, String(raw))
  const realCwd = await realpath(cwd)
  let realTarget
  try {
    realTarget = await realpath(requested)
  } catch {
    const parent = await realpath(dirname(requested))
    realTarget = join(parent, basename(requested))
  }
  const rel = relative(realCwd, realTarget)
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error('path 必须位于当前 Leader 工作目录内；不能同步这个目录之外的仓库。')
  }
  return realTarget
}

/**
 * Whether a path is a directory.
 * @param {string} path - candidate.
 * @returns {Promise<boolean>} true when it is a directory.
 */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Mask credentials embedded in an HTTPS remote before it reaches the model.
 * @param {unknown} value - remote or Git output.
 * @returns {string} the masked text.
 */
function maskRemote(value) {
  return String(value ?? '').replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@')
}

/**
 * Last lines of a Git message, bounded for the model.
 * @param {unknown} value - stdout/stderr.
 * @param {number} [maxLines] - lines to keep.
 * @returns {string} the bounded text.
 */
function tail(value, maxLines = 6) {
  const text = String(value ?? '').trim()
  if (text === '') return ''
  return text.split('\n').slice(-maxLines).join('\n')
}

/**
 * Run one Git command with a controlled environment. Returns instead of
 * throwing so callers can decide which failures are expected.
 * @param {string} cwd - working directory.
 * @param {string[]} args - Git arguments.
 * @param {{ timeoutMs?: number }} [options] - timeout override.
 * @returns {Promise<{ ok: boolean, code: number, stdout: string, stderr: string, timedOut: boolean }>} outcome.
 */
async function runGit(cwd, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args],
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      },
    )
    return { ok: true, code: 0, stdout: String(stdout), stderr: String(stderr), timedOut: false }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        ok: false,
        code: -1,
        stdout: '',
        stderr: '找不到 git 可执行文件。请先安装 Git，并确保 DSH Host 的 PATH 能看到它。',
        timedOut: false,
      }
    }
    const timedOut = error?.code === 'ETIMEDOUT' || error?.killed === true
    return {
      ok: false,
      code: typeof error?.code === 'number' ? error.code : (timedOut ? 124 : 1),
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' && error.stderr !== ''
        ? error.stderr
        : (error instanceof Error ? error.message : String(error)),
      timedOut,
    }
  }
}

/**
 * Ensure Git is runnable before planning any repository operation.
 * @param {string} cwd - a directory Git can run in.
 */
async function ensureGit(cwd) {
  const result = await runGit(cwd, ['--version'], { timeoutMs: 10_000 })
  if (!result.ok) throw new Error(`Git 不可用：${tail(result.stderr, 2)}`)
}

/**
 * The repository root containing a path.
 * @param {string} path - directory.
 * @returns {Promise<string | undefined>} the root, or undefined outside a repository.
 */
async function repoRoot(path) {
  const result = await runGit(path, ['rev-parse', '--show-toplevel'], { timeoutMs: 10_000 })
  if (!result.ok) return undefined
  return result.stdout.trim()
}

/**
 * Require `path` to be the root of its repository, not a directory inside a
 * larger repository.
 * @param {string} path - directory.
 * @returns {Promise<string>} the real repository root.
 */
async function ensureRepoRoot(path) {
  const root = await repoRoot(path)
  if (root === undefined) {
    throw new Error('这个目录还不是 Git 仓库。先用 action=bind（现有库）或 action=clone（新机器空目录）。')
  }
  const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)])
  if (realRoot !== realPath) {
    throw new Error(`当前目录在一个更大的仓库（${realRoot}）里，不是仓库根；请对仓库根目录执行同步。`)
  }
  return realRoot
}

/**
 * The configured origin URL.
 * @param {string} path - repository root.
 * @returns {Promise<string | undefined>} the URL, or undefined.
 */
async function originOf(path) {
  const result = await runGit(path, ['remote', 'get-url', 'origin'], { timeoutMs: 10_000 })
  return result.ok ? result.stdout.trim() : undefined
}

/**
 * The current branch, or undefined when HEAD is detached or unborn.
 * @param {string} path - repository root.
 * @returns {Promise<string | undefined>} branch name.
 */
async function branchOfRepo(path) {
  const result = await runGit(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 10_000 })
  return result.ok ? result.stdout.trim() : undefined
}

/**
 * Whether HEAD has at least one commit.
 * @param {string} path - repository root.
 * @returns {Promise<boolean>} true when a commit exists.
 */
async function hasCommit(path) {
  return (await runGit(path, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeoutMs: 10_000 })).ok
}

/**
 * List the branch names advertised by a remote.
 * @param {string} cwd - any directory; ls-remote does not need a repository.
 * @param {string} remote - remote URL or path.
 * @returns {Promise<string[]>} branch names.
 */
async function remoteBranches(cwd, remote) {
  const result = await runGit(cwd, ['ls-remote', '--heads', remote], { timeoutMs: NETWORK_TIMEOUT_MS })
  if (!result.ok) {
    throw new Error(`无法访问远程仓库：${tail(result.stderr, 4)}\n如果使用 HTTPS，请先配置 credential helper；如果使用 SSH，请确认本机 key 已加载。`)
  }
  return result.stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .map((line) => line.match(/^[0-9a-f]+\s+refs\/heads\/(.+)$/)?.[1])
    .filter((branch) => typeof branch === 'string' && branch !== '')
}

/**
 * Pick the branch to use, allowing a single-branch remote to supply the default
 * when the caller did not name one explicitly.
 * @param {string[]} branches - remote branches.
 * @param {string} requested - caller's branch.
 * @param {boolean} explicit - whether the caller passed a branch.
 * @returns {string} the branch to use.
 */
function chooseBranch(branches, requested, explicit) {
  if (branches.length === 0) return requested
  if (branches.includes(requested)) return requested
  if (!explicit && branches.length === 1) return branches[0]
  throw new Error(`远程没有分支 ${requested}；现有分支：${branches.join('、')}。用 branch 参数指定要同步的分支。`)
}

/**
 * Write the default whitelist `.gitignore` only when none exists.
 * @param {string} path - repository root.
 * @returns {Promise<boolean>} true when the file was created.
 */
async function writeDefaultGitignore(path) {
  const file = join(path, '.gitignore')
  try {
    await access(file)
    return false
  } catch {
    await writeFile(file, DEFAULT_GITIGNORE, 'utf8')
    return true
  }
}

/**
 * Remove only the OS metadata file Git refuses to clone over; never touches a
 * user file.
 * @param {string} path - candidate directory.
 */
async function removeDsStore(path) {
  await rm(join(path, '.DS_Store'), { force: true })
}

/**
 * Directory entries excluding `.git` and `.DS_Store`.
 * @param {string} path - directory.
 * @returns {Promise<string[]>} meaningful entries.
 */
async function meaningfulEntries(path) {
  try {
    return (await readdir(path)).filter((entry) => entry !== '.git' && entry !== '.DS_Store')
  } catch {
    return []
  }
}

/**
 * Initialize a repository on the requested branch, falling back for old Git.
 * @param {string} path - directory.
 * @param {string} branch - branch to create.
 */
async function initRepo(path, branch) {
  const direct = await runGit(path, ['init', '-b', branch])
  if (direct.ok) return
  const fallback = await runGit(path, ['init'])
  if (!fallback.ok) throw new Error(`git init 失败：${tail(direct.stderr || fallback.stderr, 4)}`)
  const symbolic = await runGit(path, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
  if (!symbolic.ok) throw new Error(`无法把新仓库切到分支 ${branch}：${tail(symbolic.stderr, 3)}`)
}

/**
 * Validate a commit message.
 * @param {unknown} raw - model-supplied message.
 * @param {string} fallback - message to use when none is supplied.
 * @returns {string} the message.
 */
function messageOf(raw, fallback) {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  if (text === '') return fallback
  return Array.from(text).slice(0, 200).join('')
}

/**
 * Whether the repository has an ignore file.
 * @param {string} path - repository root.
 * @returns {Promise<boolean>} true when `.gitignore` exists.
 */
async function hasGitignore(path) {
  try {
    await access(join(path, '.gitignore'))
    return true
  } catch {
    return false
  }
}

/**
 * Stage and commit everything not ignored by `.gitignore`.
 * @param {string} path - repository root.
 * @param {string} message - commit message.
 * @returns {Promise<{ committed: boolean, changed: number, sha?: string }>} outcome.
 */
async function commitAll(path, message) {
  const add = await runGit(path, ['add', '-A'], { timeoutMs: 60_000 })
  if (!add.ok) throw new Error(`git add 失败：${tail(add.stderr, 4)}`)

  const status = await runGit(path, ['status', '--porcelain=v1'], { timeoutMs: 30_000 })
  if (!status.ok) throw new Error(`git status 失败：${tail(status.stderr, 4)}`)
  const changed = status.stdout.trim() === '' ? 0 : status.stdout.trim().split('\n').length
  if (changed === 0) return { committed: false, changed: 0 }

  const commit = await runGit(path, ['commit', '-m', message], { timeoutMs: 60_000 })
  if (!commit.ok) {
    if (/user\.(name|email)|who you are|unable to auto-detect email/i.test(commit.stderr)) {
      throw new Error('git 提交失败：这台机器还没有配置 Git 身份。先运行 `git config --global user.name "..."` 和 `git config --global user.email "..."`，再同步。')
    }
    throw new Error(`git commit 失败：${tail(commit.stderr, 6)}`)
  }
  const sha = await runGit(path, ['rev-parse', '--short', 'HEAD'], { timeoutMs: 10_000 })
  return { committed: true, changed, sha: sha.ok ? sha.stdout.trim() : undefined }
}

/**
 * Refuse to sync while a tutor opened by this Leader is running or has queued
 * input. The shared lease blocks new writes, but a running tutor would see its
 * next write rejected in the middle of a turn.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} leaderSessionId - the calling Leader.
 */
function ensureTutorsIdle(ctx, leaderSessionId) {
  const running = []
  for (const record of getCoordinator().mentorsOf(leaderSessionId)) {
    const agent = ctx.agents.get(record.sessionId)
    if (agent === undefined) continue
    if (agent.status === 'running' || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
      running.push(record.title)
    }
  }
  if (running.length > 0) {
    throw new Error(`还有导师在运行（${running.join('、')}）。先等它们空闲，或用 mimir_leader_stop 停下，再同步。`)
  }
}

/**
 * Run one mutating sync operation under the shared-write lease.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec - tool execution.
 * @param {string} leaderSessionId - the calling Leader.
 * @param {() => Promise<{ note: string }>} operation - work to run while holding the lease.
 * @returns {Promise<{ note: string }>} operation result.
 */
async function withSyncLease(ctx, exec, leaderSessionId, operation) {
  ensureTutorsIdle(ctx, leaderSessionId)
  const coordinator = getCoordinator()
  const lease = await coordinator.acquire(
    leaderSessionId,
    { files: ['git sync'], ttlMs: SYNC_LEASE_TTL_MS },
    exec.signal,
  )
  try {
    // A tutor may have started between the first check and the grant.
    ensureTutorsIdle(ctx, leaderSessionId)
    return await operation()
  } finally {
    try {
      coordinator.release(lease.leaseId, leaderSessionId)
    } catch {
      // The lease may have expired while a slow network call ran; nothing to release.
    }
  }
}

/**
 * Clone a remote into an empty directory.
 * @param {string} target - destination (already resolved inside the Leader directory).
 * @param {string} remote - remote URL.
 * @param {string | undefined} branch - branch to check out, or undefined for the remote default.
 * @returns {Promise<{ note: string }>} result.
 */
async function cloneInto(target, remote, branch) {
  await mkdir(target, { recursive: true })
  await removeDsStore(target)
  let entries
  try {
    entries = (await readdir(target)).filter((entry) => entry !== '.DS_Store')
  } catch {
    entries = []
  }
  if (entries.length > 0) {
    throw new Error('clone 的目标目录不是空的。请在一个空目录里开 Leader 会话再 clone，以免覆盖已有笔记。')
  }

  const args = ['clone']
  if (branch !== undefined) args.push('--branch', branch)
  args.push(remote, '.')
  const clone = await runGit(target, args, { timeoutMs: GIT_TIMEOUT_MS * 2 })
  if (!clone.ok) {
    throw new Error(`git clone 失败：${tail(clone.stderr, 6)}`)
  }

  await ensureRepoRoot(target)
  const current = await branchOfRepo(target)
  return {
    note: `已从 ${maskRemote(remote)} 克隆到 ${target}${current === undefined ? '' : `，当前分支 ${current}`}。之后用 action=sync 拉取/推送。`,
  }
}

/**
 * Bind an existing vault to a remote, or clone when the directory is empty.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec - tool execution.
 * @param {{ remote?: unknown, branch?: unknown, path?: unknown, message?: unknown }} args - tool arguments.
 * @returns {Promise<{ note: string }>} result.
 */
async function bindAction(ctx, exec, args) {
  const leader = callerOf(exec)
  const cwd = leader.session.header.cwd
  if (cwd === undefined) throw new Error('当前 Leader 会话没有工作目录，无法绑定同步仓库。')
  const remote = remoteOf(args.remote)
  const explicitBranch = args.branch !== undefined
  let branch = branchOf(explicitBranch ? args.branch : 'main')
  const target = await targetOf(cwd, args.path)
  if (!(await isDirectory(target))) throw new Error(`目标目录不存在或不是目录：${target}`)
  await ensureGit(target)

  const existingRoot = await repoRoot(target)
  if (existingRoot === undefined) {
    const branches = await remoteBranches(target, remote)
    const entries = await meaningfulEntries(target)
    if (branches.length > 0) {
      if (entries.length > 0) {
        throw new Error('远程仓库已经有内容，而当前目录不是空的。为避免覆盖本地笔记，请在一个空目录里用 action=clone；或先手动把本地内容与仓库合并。')
      }
      branch = chooseBranch(branches, branch, explicitBranch)
      return cloneInto(target, remote, branch)
    }

    await initRepo(target, branch)
    const wroteIgnore = await writeDefaultGitignore(target)
    const addRemote = await runGit(target, ['remote', 'add', 'origin', remote], { timeoutMs: 10_000 })
    if (!addRemote.ok) throw new Error(`git remote add 失败：${tail(addRemote.stderr, 4)}`)
    await commitAll(target, messageOf(args.message, 'Mimir: initial vault sync'))
    if (!(await hasCommit(target))) {
      throw new Error('没有可提交的内容：现有 .gitignore 可能把 Learn/ 和 Tools/ 都忽略了。先检查 .gitignore，再重试。')
    }
    const push = await runGit(target, ['push', '-u', 'origin', branch], { timeoutMs: GIT_TIMEOUT_MS })
    if (!push.ok) {
      throw new Error(`首次推送失败：${tail(push.stderr, 6)}\n请检查远程是否已创建、是否为空，以及本机 Git 认证（SSH key 或 credential helper）。`)
    }
    return {
      note: `已初始化 Git 仓库并推送到 ${maskRemote(remote)} 的 ${branch} 分支${wroteIgnore ? '；默认只跟踪 Learn/ 和 Tools/' : '；沿用了已有的 .gitignore'}。之后用 action=sync 同步。`,
    }
  }

  await ensureRepoRoot(target)
  const ignoreWarning = (await hasGitignore(target))
    ? ''
    : ' 注意：这个仓库没有 .gitignore；sync 会提交所有未忽略文件，请先用 action=status 检查。'
  const origin = await originOf(target)
  if (origin !== undefined && origin.replace(/\/+$/, '').replace(/\.git$/i, '') !== remote.replace(/\/+$/, '').replace(/\.git$/i, '')) {
    throw new Error(`origin 已经指向 ${maskRemote(origin)}，与请求的 ${maskRemote(remote)} 不同。先确认要用哪个仓库；不会自动覆盖。`)
  }
  if (origin === undefined) {
    const addRemote = await runGit(target, ['remote', 'add', 'origin', remote], { timeoutMs: 10_000 })
    if (!addRemote.ok) throw new Error(`git remote add 失败：${tail(addRemote.stderr, 4)}`)
  }

  const localHasCommit = await hasCommit(target)
  const branches = await remoteBranches(target, remote)
  if (branches.length === 0) {
    return { note: `已绑定 ${maskRemote(remote)}（${branch}）。远程还是空的；运行 action=sync 提交并推送本地内容。${ignoreWarning}` }
  }

  branch = chooseBranch(branches, branch, explicitBranch)
  const fetch = await runGit(target, ['fetch', '--prune', 'origin'], { timeoutMs: NETWORK_TIMEOUT_MS })
  if (!fetch.ok) throw new Error(`git fetch 失败：${tail(fetch.stderr, 5)}`)

  if (!localHasCommit) {
    const entries = await meaningfulEntries(target)
    if (entries.length > 0) {
      throw new Error('本地仓库还没有提交，但工作区里有文件，远程也有历史。为避免覆盖，请用 action=clone 到空目录，或先手动合并。')
    }
    const checkout = await runGit(target, ['checkout', '-B', branch, `origin/${branch}`], { timeoutMs: 60_000 })
    if (!checkout.ok) throw new Error(`从远程检出失败：${tail(checkout.stderr, 5)}`)
    return { note: `已绑定 ${maskRemote(remote)}，并从远程检出了 ${branch} 分支。之后用 action=sync。` }
  }

  const remoteRef = await runGit(target, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { timeoutMs: 10_000 })
  if (!remoteRef.ok) {
    return { note: `已绑定 ${maskRemote(remote)}，但远程没有分支 ${branch}；运行 action=sync 会创建并推送它。${ignoreWarning}` }
  }
  const base = await runGit(target, ['merge-base', 'HEAD', `origin/${branch}`], { timeoutMs: 10_000 })
  if (!base.ok) {
    return { note: `已绑定 ${maskRemote(remote)}，但远程 ${branch} 与本仓库没有共同祖先。action=sync 的 pull --rebase 会失败；需要先手动合并两段历史。${ignoreWarning}` }
  }
  return { note: `已绑定 ${maskRemote(remote)}（${branch}）。当前分支 ${(await branchOfRepo(target)) ?? '（detached）'}；运行 action=sync 拉取并推送。${ignoreWarning}` }
}

/**
 * Show repository, remote, branch, local changes, and ahead/behind.
 * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec - tool execution.
 * @param {{ path?: unknown }} args - tool arguments.
 * @returns {Promise<{ note: string }>} result.
 */
async function statusAction(exec, args) {
  const leader = callerOf(exec)
  const cwd = leader.session.header.cwd
  if (cwd === undefined) throw new Error('当前 Leader 会话没有工作目录。')
  const target = await targetOf(cwd, args.path)
  await ensureGit(target)
  const root = await repoRoot(target)
  if (root === undefined) {
    return { note: `这个目录还没有 Git 仓库：${target}\n现有库用 action=bind；新机器空目录用 action=clone。` }
  }
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)])
  if (realRoot !== realTarget) {
    return { note: `当前目录在仓库 ${realRoot} 里，但不是仓库根；请对仓库根目录执行同步。` }
  }

  const origin = await originOf(target)
  const branch = await branchOfRepo(target)
  let remoteState = '未绑定远程'
  if (origin !== undefined) {
    const fetch = await runGit(target, ['fetch', '--prune', 'origin'], { timeoutMs: NETWORK_TIMEOUT_MS })
    remoteState = fetch.ok
      ? '远程可达'
      : `远程不可达或认证失败：${tail(fetch.stderr, 3)}`
  }

  const status = await runGit(target, ['status', '--porcelain=v1', '--branch'], { timeoutMs: 30_000 })
  const lines = status.ok ? status.stdout.trim().split('\n').filter(Boolean) : []
  const headLine = lines.find((line) => line.startsWith('## ')) ?? ''
  const changed = lines.filter((line) => !line.startsWith('## ')).length

  let ahead = 0
  let behind = 0
  if (origin !== undefined && branch !== undefined) {
    const counts = await runGit(target, ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`], { timeoutMs: 10_000 })
    if (counts.ok) {
      const [left, right] = counts.stdout.trim().split('\t').map((value) => Number.parseInt(value, 10))
      ahead = Number.isFinite(left) ? left : 0
      behind = Number.isFinite(right) ? right : 0
    }
  }

  const last = await runGit(target, ['log', '-1', '--format=%h %s'], { timeoutMs: 10_000 })
  const lastLine = last.ok && last.stdout.trim() !== '' ? last.stdout.trim() : '还没有提交'

  const parts = [
    `仓库：${target}`,
    `远程：${origin === undefined ? '未绑定' : `origin -> ${maskRemote(origin)}`}`,
    `分支：${branch ?? '（detached HEAD）'}${branch === undefined ? '' : `（ahead ${ahead}，behind ${behind}）`}`,
    `工作区：${changed === 0 ? '干净' : `${changed} 个未提交改动`}`,
    `最后提交：${lastLine}`,
    `远程状态：${remoteState}`,
  ]
  if (headLine !== '') parts.push(`Git：${headLine}`)
  if (!status.ok) parts.push(`git status 失败：${tail(status.stderr, 2)}`)
  if (!(await hasGitignore(target))) parts.push('忽略规则：没有 .gitignore（sync 会提交所有未忽略文件，先检查这个仓库的范围）')
  return { note: parts.join('\n') }
}

/**
 * Commit local changes, pull with rebase, and push.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec - tool execution.
 * @param {{ path?: unknown, branch?: unknown, message?: unknown }} args - tool arguments.
 * @returns {Promise<{ note: string }>} result.
 */
async function syncAction(ctx, exec, args) {
  const leader = callerOf(exec)
  const cwd = leader.session.header.cwd
  if (cwd === undefined) throw new Error('当前 Leader 会话没有工作目录。')
  const target = await targetOf(cwd, args.path)
  await ensureGit(target)
  await ensureRepoRoot(target)

  const origin = await originOf(target)
  if (origin === undefined) throw new Error('还没有绑定远程仓库；先 action=bind remote=<仓库地址>。')

  const current = await branchOfRepo(target)
  if (current === undefined) throw new Error('当前仓库处于 detached HEAD；先切回一个分支再同步。')
  if (args.branch !== undefined && branchOf(args.branch) !== current) {
    throw new Error(`当前在 ${current} 分支，不能直接同步 ${String(args.branch)}；先切换分支，或用 branch 只做 bind/clone。`)
  }

  return withSyncLease(ctx, exec, leader.session.id, async () => {
    const fetch = await runGit(target, ['fetch', '--prune', 'origin'], { timeoutMs: NETWORK_TIMEOUT_MS })
    if (!fetch.ok) {
      throw new Error(`git fetch 失败：${tail(fetch.stderr, 6)}\n检查本机 Git 的网络/代理和认证配置。`)
    }

    const remoteRef = await runGit(target, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${current}`], { timeoutMs: 10_000 })
    let behind = 0
    if (remoteRef.ok) {
      const counts = await runGit(target, ['rev-list', '--count', `HEAD..origin/${current}`], { timeoutMs: 10_000 })
      if (counts.ok) behind = Number.parseInt(counts.stdout.trim(), 10) || 0
    }

    const message = messageOf(args.message, `Mimir sync: ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
    const commit = await commitAll(target, message)

    if (remoteRef.ok) {
      const pull = await runGit(target, ['pull', '--rebase', 'origin', current], { timeoutMs: GIT_TIMEOUT_MS })
      if (!pull.ok) {
        const conflicts = await runGit(target, ['diff', '--name-only', '--diff-filter=U'], { timeoutMs: 10_000 })
        await runGit(target, ['rebase', '--abort'], { timeoutMs: 30_000 })
        const files = conflicts.ok
          ? conflicts.stdout.trim().split('\n').filter(Boolean)
          : []
        const detail = files.length > 0 ? `冲突文件：${files.join('、')}。` : ''
        const summary = String(pull.stderr)
          .split('\n')
          .map((line) => line.trim())
          .find((line) => /CONFLICT|error:/i.test(line)) ?? ''
        throw new Error(`同步冲突：pull --rebase 失败，已撤销 rebase，本地提交保留。${detail}${summary === '' ? '' : `\n${summary}`}`)
      }
    }

    const push = await runGit(target, ['push', '-u', 'origin', current], { timeoutMs: GIT_TIMEOUT_MS })
    if (!push.ok) {
      throw new Error(`git push 失败：${tail(push.stderr, 6)}\n检查远程是否可写，以及本机 Git 认证。`)
    }

    const head = await runGit(target, ['rev-parse', '--short', 'HEAD'], { timeoutMs: 10_000 })
    const sha = head.ok ? head.stdout.trim() : commit.sha ?? '?'
    const local = commit.committed
      ? `本地提交 ${sha}（${commit.changed} 个文件）`
      : '本地没有新改动'
    const remote = behind > 0 ? `拉取了 ${behind} 个远端提交` : '远端没有新提交'
    return {
      note: `同步完成：分支 ${current}；${local}；${remote}；已推送 origin/${current}。`,
    }
  })
}

/**
 * Register `mimir_leader_sync`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - preset scope carrying the tool registry.
 */
export function apply(ctx) {
  ctx.tools.register({
    name: 'mimir_leader_sync',
    description: [
      '把学习库绑定到 GitHub/Git 仓库，并在不同机器之间同步。',
      'action=bind：在现有库上初始化 Git（新建仓库默认只跟踪 Learn/ 和 Tools/）、添加 origin、首次提交并推送；如果远程已有内容且当前目录为空，会自动改为 clone。',
      'action=clone：把远程克隆到当前空目录，用于新机器。',
      'action=status：查看远程、分支、未提交改动和 ahead/behind，不改文件。',
      'action=sync：先确认本 Leader 的导师都空闲，持有共享写锁后自动提交本地改动、pull --rebase、再 push；冲突时撤销 rebase 并报告，不会留下冲突标记。',
      '使用本机 Git 的认证方式（SSH key 或 credential helper）；不会弹窗要密码或保存 token。学习资料建议用私有仓库。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'bind', 'clone', 'sync'],
          description: 'status=查看；bind=绑定现有库；clone=克隆到空目录；sync=提交并拉取/推送。',
        },
        remote: {
          type: 'string',
          description: 'bind/clone 必填：仓库地址，例如 https://github.com/<你>/<库>.git 或 git@github.com:<你>/<库>.git。不要在这里拼 token。',
        },
        branch: {
          type: 'string',
          description: 'bind/clone 的分支，默认 main（远程只有一个分支时会采用它）；sync 只能同步当前分支。',
        },
        path: {
          type: 'string',
          description: '可选：Leader 工作目录内的子目录；默认就是 Leader 的整个工作目录。',
        },
        message: {
          type: 'string',
          description: 'sync/bind 的提交说明；省略时自动生成。',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { note: { type: 'string' } },
        required: ['note'],
      },
      render(_args, value) {
        return [{ type: 'text', text: value.note }]
      },
    },
    timeoutMs: 600_000,
    async execute(args, exec) {
      if (args.action === 'status') return statusAction(exec, args)
      if (args.action === 'bind') {
        return withSyncLease(ctx, exec, callerOf(exec).session.id, () => bindAction(ctx, exec, args))
      }
      if (args.action === 'clone') {
        const leader = callerOf(exec)
        const cwd = leader.session.header.cwd
        if (cwd === undefined) throw new Error('当前 Leader 会话没有工作目录。')
        const remote = remoteOf(args.remote)
        const explicitBranch = args.branch !== undefined
        const branch = explicitBranch ? branchOf(args.branch) : undefined
        const target = await targetOf(cwd, args.path)
        await ensureGit(cwd)
        return withSyncLease(ctx, exec, leader.session.id, () => cloneInto(target, remote, branch))
      }
      return syncAction(ctx, exec, args)
    },
  })
}
