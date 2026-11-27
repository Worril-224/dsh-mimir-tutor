import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The coordinator persists its roster under $DSH_HOME. Point it at a throwaway
// home so a test run never reads or writes the developer's real Leader roster.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mimir-test-'))
import test from 'node:test'
import assert from 'node:assert/strict'
import { Coordinator } from '../coordinator.js'

/** Let queued promise continuations run. */
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('shared write lease is granted in application order', async () => {
  const coordinator = new Coordinator()
  const first = await coordinator.acquire('session-a')
  assert.equal(first.sessionId, 'session-a')

  const order = []
  const second = coordinator.acquire('session-b').then((lease) => {
    order.push(lease.sessionId)
    return lease
  })
  const third = coordinator.acquire('session-c').then((lease) => {
    order.push(lease.sessionId)
    return lease
  })

  await tick()
  assert.deepEqual(order, [], 'B and C must wait while A holds the lease')
  assert.equal(coordinator.snapshot().queue.length, 2)
  assert.deepEqual(
    coordinator.snapshot().queue.map((entry) => entry.sessionId),
    ['session-b', 'session-c'],
  )

  coordinator.release(first.leaseId, 'session-a')
  await tick()
  assert.deepEqual(order, ['session-b'])

  const leaseB = await second
  coordinator.release(leaseB.leaseId, 'session-b')
  await tick()
  assert.deepEqual(order, ['session-b', 'session-c'])

  const leaseC = await third
  assert.equal(leaseC.sessionId, 'session-c')
  assert.equal(coordinator.snapshot().holder?.sessionId, 'session-c')
})

test('one session cannot release another session lease', async () => {
  const coordinator = new Coordinator()
  const lease = await coordinator.acquire('session-a')
  assert.throws(() => coordinator.release(lease.leaseId, 'session-b'), /另一个会话/)
  assert.equal(coordinator.snapshot().holder?.sessionId, 'session-a')
  coordinator.release(lease.leaseId, 'session-a')
})

test('acquire is idempotent inside one session', async () => {
  const coordinator = new Coordinator()
  const first = await coordinator.acquire('session-a')
  const second = await coordinator.acquire('session-a')
  assert.equal(second.leaseId, first.leaseId)
  assert.equal(second.alreadyHeld, true)
  coordinator.release(first.leaseId, 'session-a')
})

test('aborted application leaves the queue', async () => {
  const coordinator = new Coordinator()
  const leaseA = await coordinator.acquire('session-a')
  const controller = new AbortController()
  const waiting = coordinator.acquire('session-b', {}, controller.signal)
  await tick()
  assert.equal(coordinator.snapshot().queue.length, 1)
  controller.abort()
  await assert.rejects(waiting, /取消/)
  assert.equal(coordinator.snapshot().queue.length, 0)
  coordinator.release(leaseA.leaseId, 'session-a')
})

test('releaseAllForSession cleans the holder and one session waiters', async () => {
  const coordinator = new Coordinator()
  const leaseA = await coordinator.acquire('session-a')
  const waitingB = coordinator.acquire('session-b')
  const waitingC = coordinator.acquire('session-c')
  await tick()
  assert.equal(coordinator.snapshot().queue.length, 2)

  const cancelled = coordinator.releaseAllForSession('session-b', 'test')
  assert.equal(cancelled.released, 0)
  assert.equal(cancelled.cancelled, 1)
  assert.equal(coordinator.snapshot().holder?.sessionId, 'session-a')

  const released = coordinator.releaseAllForSession('session-a', 'test')
  assert.equal(released.released, 1)
  assert.equal(coordinator.snapshot().holder?.sessionId, 'session-c')

  const leaseC = await waitingC
  await assert.rejects(waitingB, /取消/)
  coordinator.release(leaseC.leaseId, 'session-c')
})
