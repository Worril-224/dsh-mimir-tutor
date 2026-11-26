/**
 * `mimir_shared_lock` — the one write gate shared by every tutor.
 *
 * Tutors may run in parallel. Their module-specific notes (session notes,
 * concept notes, maps) are separate files, but the vault hubs — the learning
 * index, learner profile, learning list, glossary, reading list, and review
 * queue — are shared. This tool serialises writes to those files in
 * application order: `acquire` joins a FIFO queue and resolves only when the
 * previous holder releases, so the tutor reads and writes with no other tutor
 * inside the same window. `release` is called immediately after the write.
 *
 * The lease is released automatically when the tutor's turn goes idle, when
 * the Session is disposed, after {@link LEASE_TTL_MS} of neglect, or by the
 * Leader's `mimir_leader_locks` tool. A forgotten release therefore delays
 * the queue, but does not wedge it.
 *
 * @module dsh-mimir-tutor/shared-lock-tool
 */

import { LEASE_TTL_MS, getCoordinator } from './coordinator.js'

/** Plugin name shown by the loader. */
export const name = 'mimir-shared-lock'

/** Host services this tool reads. */
export const inject = ['tools']

/** Human-facing list of the shared hubs, used in the tool description. */
const SHARED_FILES = '🌱 学习索引.md、学习者档案.md、学习清单.md、术语表.md、阅读清单.md、Reviews/复习队列.md'

/**
 * Canonical vault-relative paths whose writes must hold the lease. Matched by
 * suffix on the normalized display path, so a vault mounted at any prefix works.
 */
const SHARED_PATHS = [
  '/Learn/🌱 学习索引.md',
  '/Learn/学习者档案.md',
  '/Learn/学习清单.md',
  '/Learn/术语表.md',
  '/Learn/阅读清单.md',
  '/Learn/Reviews/复习队列.md',
]

/**
 * Whether a resolved filesystem target is one of the shared hubs.
 * @param {unknown} target - resolved `FsTarget` supplied by the fs tool.
 * @returns {boolean} true for a shared hub.
 */
function isSharedTarget(target) {
  const raw = target !== null && typeof target === 'object' && typeof target.displayPath === 'string'
    ? target.displayPath.replace(/\\/g, '/')
    : ''
  if (raw === '') return false
  const normalized = raw.startsWith('/') ? raw : `/${raw}`
  return SHARED_PATHS.some((path) => normalized.endsWith(path))
}

/**
 * Refuse a direct fs write to a shared hub unless the calling Session holds the
 * lease. This is the enforcement half of the protocol: a tutor cannot skip
 * `mimir_shared_lock` by calling `write` or `edit` directly. A caller without
 * an agent (a plugin maintenance write) is left alone.
 * @param {object} coordinator - the shared coordinator.
 * @param {unknown} target - resolved `FsTarget`.
 * @param {unknown} actor - the tool-execution context passed to the intent waterfall.
 */
function assertSharedWriteAllowed(coordinator, target, actor) {
  if (!isSharedTarget(target)) return
  const session = actor?.agent?.session
  const sessionId = session?.id
  if (sessionId === undefined) return
  // Scope the gate to Sessions composed by this bundle. A standard or custom
  // Session in the same Host must never be blocked by Mimir's own protocol.
  const preset = session.header?.agentPreset
  if (preset !== 'mimir-tutor' && preset !== 'mimir-librarian') return
  if (coordinator.snapshot().holder?.sessionId === sessionId) return
  throw new Error(
    `写共享文件「${target.displayPath}」之前必须先调用 mimir_shared_lock（action=acquire）并按顺序拿到写锁；`
    + '拿到锁后重新读取文件、再写，写完立即 action=release。',
  )
}

/**
 * Keep only non-empty strings from a model-supplied list.
 * @param {unknown} value - candidate list.
 * @returns {string[]} the cleaned list.
 */
function normaliseFiles(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim())
    .slice(0, 20)
}

/**
 * Describe the lock from one caller's point of view.
 * @param {object} snapshot - coordinator snapshot.
 * @param {string} sessionId - the calling Session.
 * @returns {string} a model-facing paragraph.
 */
function describe(snapshot, sessionId) {
  if (snapshot.holder === null) {
    return snapshot.queue.length === 0
      ? '共享写锁空闲：现在没有导师持有写锁，也没有排队申请。'
      : `共享写锁空闲，但有 ${snapshot.queue.length} 个申请在排队（按申请顺序）。`
  }
  const mine = snapshot.holder.sessionId === sessionId ? '（本会话持有）' : ''
  const held = Math.round(snapshot.holder.heldMs / 1000)
  const waiting = snapshot.queue.length === 0
    ? '没有排队申请。'
    : `排队：${snapshot.queue.map((entry) => `${entry.position}. ${entry.sessionId}`).join('；')}。`
  return `写锁持有者：${snapshot.holder.sessionId}${mine}，已持有 ${held} 秒。${waiting}`
}

/**
 * Register `mimir_shared_lock`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - preset scope carrying the tool registry.
 */
export function apply(ctx) {
  const coordinator = getCoordinator()

  // One listener per preset activation: an idle or disposed Session releases
  // only ITS OWN lease and drops ITS OWN waiters, so a sibling finishing a
  // turn can never open another tutor's write window. The event payload names
  // the exact Session, which is what makes the shared scope safe.
  ctx.on('agent/status', (payload) => {
    if (payload?.status !== 'idle' || payload?.agent === undefined) return
    coordinator.releaseAllForSession(payload.agent.id, '导师回合结束')
  })
  ctx.on('agent/disposed', (payload) => {
    if (payload?.agent === undefined) return
    coordinator.releaseAllForSession(payload.agent.id, '导师会话关闭')
  })

  // Enforce the lease on the normal `write` / `edit` tools too, not only on
  // this tool. A direct write to a shared hub without the lease is refused
  // with a message that tells the model exactly how to recover.
  //
  // The intent waterfalls are single-slot decisions, and
  // `fs-observation-policy` occupies the slot without calling `next()`.
  // Prepending this check makes it run first and delegate with `next()`, so
  // both the write gate and the observed-version guard still happen.
  ctx.on('fs/write-intent', (target, actor, next) => {
    assertSharedWriteAllowed(coordinator, target, actor)
    return next()
  }, { prepend: true })
  ctx.on('fs/edit-intent', (target, actor, next) => {
    assertSharedWriteAllowed(coordinator, target, actor)
    return next()
  }, { prepend: true })
  ctx.on('fs/delete-intent', (target, actor, next) => {
    assertSharedWriteAllowed(coordinator, target, actor)
    return next()
  }, { prepend: true })

  ctx.tools.register({
    name: 'mimir_shared_lock',
    description: [
      '多位导师并行时，共享文件只能一个一个写。这个工具就是那道门。',
      `写共享文件（${SHARED_FILES}，以及任何你不是唯一作者的笔记）之前调用 action=acquire；它按申请顺序排队，轮到你时返回。`,
      '拿到锁后立刻读、立刻写，写完立即 action=release。没有锁时直接 write/edit/apply_patch 这六个共享枢纽会被拒绝；不要为了绕开等待去写另一个路径。',
      '只属于本模块的会话笔记、概念笔记、图谱不需要这把锁，可以直接写。',
      'action=status 只查看当前持有者和队列，不申请。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['acquire', 'release', 'status'],
          description: 'acquire=申请并按顺序等待写锁；release=写完释放；status=查看当前锁，不申请。',
        },
        lease_id: {
          type: 'string',
          description: 'acquire 返回的租约 id。release 时可省略；省略则释放本会话持有的锁。',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '这次准备写哪些共享文件，只用于排队展示，可省略。',
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
    // Waiting behind other tutors is the normal case; allow a long, cooperative wait.
    timeoutMs: 600_000,
    async execute(args, exec) {
      const caller = exec.agent
      if (caller === undefined) throw new Error('mimir_shared_lock 只能在导师会话里调用')
      const sessionId = caller.session.id

      if (args.action === 'acquire') {
        const files = normaliseFiles(args.files)
        const lease = await coordinator.acquire(
          sessionId,
          { leaderSessionId: coordinator.leaderOf(sessionId), files },
          exec.signal,
        )
        const tail = lease.queueLength === 0
          ? ''
          : `；你后面还有 ${lease.queueLength} 个申请在排队`
        return {
          note: `已获得共享写锁 ${lease.leaseId}${lease.alreadyHeld ? '（本会话已经持有）' : ''}${tail}。现在可以写：${files.length === 0 ? '共享文件' : files.join('、')}。写完立即调用 action=release。`,
        }
      }

      if (args.action === 'release') {
        return { note: coordinator.release(args.lease_id, sessionId).note }
      }

      return { note: describe(coordinator.snapshot(), sessionId) }
    },
  })
}
