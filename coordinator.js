/**
 * Process-wide state for the Mimir Leader mode.
 *
 * Two jobs live here, both deliberately dependency-free so every preset can
 * import the same module without resolving a harness package:
 *
 * 1. A **roster** of tutor Sessions owned by each Leader Session. The Leader
 *    opens them, writes their first message, and later lists, messages, or
 *    reads them.
 * 2. A **shared-write lease**: one global FIFO lock over the vault files that
 *    more than one tutor may want to touch (learning list, learner profile,
 *    glossary, reading list, review queue, learning index). A tutor calls
 *    `mimir_shared_lock acquire`, gets the lease only when every earlier
 *    applicant has released, reads and writes while holding it, then releases.
 *    The lock is granted in application order, which is the ordering the
 *    Leader promises.
 *
 * The module is imported by `leader-tool.js` and `shared-lock-tool.js`. Those
 * live in different preset scopes, so the instance is anchored on
 * `globalThis` under a registry Symbol: even if the package is resolved twice
 * (or a preset revision is mounted more than once), both tools still see the
 * same roster and the same queue.
 *
 * @module dsh-mimir-tutor/coordinator
 */

/** A lease held longer than this is force-released so one stalled tutor cannot wedge the queue. */
export const LEASE_TTL_MS = 180_000

/** First-line marker the Leader writes into every tutor's opening message. */
export const LEADER_OPENING_MARKER = '[Mimir · Leader → 导师]'

/** Registry key on `globalThis`; `Symbol.for` survives duplicate module instances. */
const COORDINATOR_KEY = Symbol.for('dsh-mimir-tutor.leader-coordinator')

/**
 * Return the process-wide coordinator, creating it on first use.
 * @returns {Coordinator} the shared instance.
 */
export function getCoordinator() {
  const existing = globalThis[COORDINATOR_KEY]
  if (existing !== undefined) return existing
  const created = new Coordinator()
  globalThis[COORDINATOR_KEY] = created
  return created
}

/** Error used when a queued acquire is cancelled before it is granted. */
function cancelledError() {
  return new Error('共享写锁申请已取消；当前没有获得写锁，也没有写入任何文件。')
}

/**
 * Roster + FIFO write-lease coordinator.
 */
export class Coordinator {
  constructor() {
    /** @type {Map<string, Map<string, object>>} leader session id -> tutor records */
    this.leaders = new Map()
    /** @type {object[]} requests waiting for the lease, oldest first */
    this.queue = []
    /** @type {object | null} the current lease */
    this.holder = null
    this.nextRequestId = 1
    this.nextLeaseId = 1
  }

  /**
   * Remember a tutor Session opened by a Leader.
   * @param {string} leaderSessionId - the Leader's Session id.
   * @param {{ sessionId: string, title: string, opening?: string, createdAt?: number }} record - tutor facts.
   * @returns {object} the stored record.
   */
  registerMentor(leaderSessionId, record) {
    let roster = this.leaders.get(leaderSessionId)
    if (roster === undefined) {
      roster = new Map()
      this.leaders.set(leaderSessionId, roster)
    }
    const stored = {
      leaderSessionId,
      title: record.title,
      opening: record.opening,
      createdAt: record.createdAt ?? Date.now(),
      sessionId: record.sessionId,
    }
    roster.set(stored.sessionId, stored)
    return stored
  }

  /**
   * List the tutor Sessions one Leader opened, oldest first.
   * @param {string} leaderSessionId - the Leader's Session id.
   * @returns {object[]} tutor records.
   */
  mentorsOf(leaderSessionId) {
    const roster = this.leaders.get(leaderSessionId)
    if (roster === undefined) return []
    return [...roster.values()].sort((left, right) => left.createdAt - right.createdAt)
  }

  /**
   * Find a tutor record anywhere in this process.
   * @param {string} sessionId - the tutor Session id.
   * @returns {object | undefined} the record, when this process opened it.
   */
  findMentor(sessionId) {
    for (const roster of this.leaders.values()) {
      const found = roster.get(sessionId)
      if (found !== undefined) return found
    }
    return undefined
  }

  /**
   * Which Leader owns a tutor Session.
   * @param {string} sessionId - the tutor Session id.
   * @returns {string | undefined} the owning Leader Session id.
   */
  leaderOf(sessionId) {
    return this.findMentor(sessionId)?.leaderSessionId
  }

  /**
   * Apply for the shared-write lease. Resolves only when this Session is at the
   * front of the queue and the previous holder has released, so the caller may
   * read-modify-write immediately after it resolves.
   * @param {string} sessionId - the applying Session.
   * @param {{ leaderSessionId?: string, files?: string[] }} [options] - owning Leader and intended files, for display only.
   * @param {AbortSignal} [signal] - cancels the application while it waits.
   * @returns {Promise<object>} the granted lease view.
   */
  acquire(sessionId, options = {}, signal) {
    // Idempotent inside one Session: a second acquire is not a deadlock.
    if (this.holder !== null && this.holder.sessionId === sessionId) {
      return Promise.resolve(this.leaseView(this.holder, true))
    }
    const pending = this.queue.find((entry) => entry.sessionId === sessionId)
    if (pending !== undefined) return pending.promise

    const entry = {
      id: this.nextRequestId++,
      sessionId,
      leaderSessionId: options.leaderSessionId,
      files: normaliseFiles(options.files),
      enqueuedAt: Date.now(),
      resolve: undefined,
      reject: undefined,
      cleanup: undefined,
      promise: undefined,
    }
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve
      entry.reject = reject
    })
    // The tool invocation still receives the rejection; this branch only stops
    // an abandoned waiter (turn cancelled, executor gone) from becoming an
    // unhandled rejection in the Host process.
    entry.promise.catch(() => {})

    if (signal !== undefined) {
      if (signal.aborted) {
        entry.reject(cancelledError())
        return entry.promise
      }
      const onAbort = () => this.cancel(entry)
      entry.cleanup = () => signal.removeEventListener('abort', onAbort)
      signal.addEventListener('abort', onAbort, { once: true })
    }

    this.queue.push(entry)
    this.pump()
    return entry.promise
  }

  /**
   * Remove one waiting application.
   * @param {object} entry - the queued request.
   */
  cancel(entry) {
    const index = this.queue.indexOf(entry)
    if (index >= 0) this.queue.splice(index, 1)
    if (entry.cleanup !== undefined) entry.cleanup()
    entry.cleanup = undefined
    entry.reject(cancelledError())
  }

  /**
   * Grant the lease to the next applicant, when it is free.
   */
  pump() {
    if (this.holder !== null || this.queue.length === 0) return
    const entry = this.queue.shift()
    if (entry.cleanup !== undefined) entry.cleanup()
    entry.cleanup = undefined

    const lease = {
      id: `lease-${this.nextLeaseId++}`,
      sessionId: entry.sessionId,
      leaderSessionId: entry.leaderSessionId,
      files: entry.files,
      acquiredAt: Date.now(),
      timer: undefined,
    }
    lease.timer = setTimeout(() => {
      if (this.holder !== lease) return
      this.holder = null
      this.pump()
    }, LEASE_TTL_MS)
    // Do not keep the process alive only for a lease timeout.
    if (typeof lease.timer.unref === 'function') lease.timer.unref()

    this.holder = lease
    entry.resolve(this.leaseView(lease, false))
  }

  /**
   * Shape one lease for the model.
   * @param {object} lease - the held lease.
   * @param {boolean} alreadyHeld - whether the caller already held it.
   * @returns {object} a detached view.
   */
  leaseView(lease, alreadyHeld) {
    return {
      leaseId: lease.id,
      sessionId: lease.sessionId,
      files: [...lease.files],
      alreadyHeld,
      queueLength: this.queue.length,
      note: alreadyHeld
        ? `本会话已经持有共享写锁 ${lease.id}；直接写，写完调用 action=release。`
        : `已获得共享写锁 ${lease.id}；现在可以写共享文件，写完立即调用 action=release。`,
    }
  }

  /**
   * Release a lease. Without `force`, the lease id and/or owning Session must
   * match, so one tutor cannot release another's write window by accident.
   * @param {string | undefined} leaseId - the lease to release; omit to release the caller's own.
   * @param {string | undefined} sessionId - the calling Session.
   * @param {{ force?: boolean }} [options] - Leader override.
   * @returns {{ released: boolean, note: string }} outcome.
   */
  release(leaseId, sessionId, options = {}) {
    const lease = this.holder
    if (lease === null) {
      return { released: false, note: '当前没有导师持有共享写锁，无需释放。' }
    }
    if (options.force !== true) {
      if (sessionId !== undefined && lease.sessionId !== sessionId) {
        throw new Error(`共享写锁 ${lease.id} 正由另一个会话持有，不能由本会话释放。`)
      }
      if (leaseId !== undefined && lease.id !== leaseId) {
        throw new Error(`给定的 lease_id=${leaseId} 与当前写锁 ${lease.id} 不一致。`)
      }
    }
    return this.releaseHolder(lease, `已释放共享写锁 ${lease.id}`)
  }

  /**
   * Drop the current holder and immediately grant the next applicant.
   * @param {object} lease - the lease to drop.
   * @param {string} note - model-facing explanation.
   * @returns {{ released: boolean, note: string }} outcome.
   */
  releaseHolder(lease, note) {
    if (lease.timer !== undefined) clearTimeout(lease.timer)
    this.holder = null
    this.pump()
    const next = this.holder === null
      ? ''
      : ` 下一个申请（${this.holder.sessionId}）已按顺序获得写锁。`
    return { released: true, note: `${note}。${next}`.trim() }
  }

  /**
   * Release a Session's lease and discard its waiting applications. Called
   * when that Session goes idle, is stopped, or is disposed, so a forgotten
   * release cannot wedge the queue.
   * @param {string} sessionId - the Session to clean up.
   * @param {string} reason - why the cleanup ran, for the rejected waiters.
   * @returns {{ released: number, cancelled: number }} counts.
   */
  releaseAllForSession(sessionId, reason = '会话结束') {
    let cancelled = 0
    for (const entry of [...this.queue]) {
      if (entry.sessionId !== sessionId) continue
      const index = this.queue.indexOf(entry)
      if (index >= 0) this.queue.splice(index, 1)
      if (entry.cleanup !== undefined) entry.cleanup()
      entry.cleanup = undefined
      entry.reject(new Error(`共享写锁申请已取消：${reason}。`))
      cancelled += 1
    }
    let released = 0
    if (this.holder !== null && this.holder.sessionId === sessionId) {
      this.releaseHolder(this.holder, `共享写锁因${reason}自动释放`)
      released = 1
    }
    return { released, cancelled }
  }

  /**
   * Snapshot the lock for display.
   * @returns {{ holder: object | null, queue: object[] }} the current state.
   */
  snapshot() {
    const now = Date.now()
    return {
      holder: this.holder === null
        ? null
        : {
          leaseId: this.holder.id,
          sessionId: this.holder.sessionId,
          leaderSessionId: this.holder.leaderSessionId,
          files: [...this.holder.files],
          heldMs: now - this.holder.acquiredAt,
        },
      queue: this.queue.map((entry, index) => ({
        position: index + 1,
        sessionId: entry.sessionId,
        leaderSessionId: entry.leaderSessionId,
        files: [...entry.files],
        waitingMs: now - entry.enqueuedAt,
      })),
    }
  }
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
