import test from 'node:test'
import assert from 'node:assert/strict'
import { apply as applyLeader } from '../leader-tool.js'
import { apply as applySharedLock } from '../shared-lock-tool.js'

/** Build a fake Cordis context good enough for the Leader and lock tools. */
function fakeContext() {
  const tools = new Map()
  const agents = new Map()
  const listeners = new Map()
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
      },
    },
    on(name, callback) {
      const list = listeners.get(name) ?? []
      list.push(callback)
      listeners.set(name, list)
      return () => {}
    },
    agents: {
      get(id) {
        return agents.get(id)
      },
      async create({ sessionId, meta, setup }) {
        const messages = []
        const session = {
          id: sessionId,
          title: undefined,
          header: { cwd: meta.cwd, id: sessionId, agentPreset: meta.agentPreset },
          append() {},
          deriveMessages() {
            return messages.slice()
          },
        }
        const agent = {
          id: sessionId,
          session,
          status: 'idle',
          inbox: { nextTurn: [], nextStep: [] },
          ctx: {
            on() {
              return () => {}
            },
          },
          pushMessage(message) {
            messages.push(message)
          },
          followup(message) {
            messages.push({ role: 'user', content: message.content })
            this.status = 'running'
          },
          steer(message) {
            messages.push({ role: 'user', content: message.content })
          },
          cancel() {
            this.status = 'idle'
          },
        }
        await setup({}, agent)
        agents.set(sessionId, agent)
        return { agent }
      },
    },
    agentPresets: {
      async resolve() {
        return {}
      },
      async mount() {},
    },
    sessionTitle: {
      rename(session, title) {
        session.title = title
        return { title }
      },
      get(session) {
        return session.title
      },
    },
  }
  return { ctx, tools, agents, listeners }
}

function fakeLeader() {
  return {
    id: 'leader-session',
    session: {
      id: 'leader-session',
      header: { cwd: '/vault' },
      append() {},
      deriveMessages() {
        return []
      },
    },
    inbox: { nextTurn: [], nextStep: [] },
    status: 'idle',
  }
}

const exec = (agent) => ({ agent, signal: new AbortController().signal, callId: 'call-1' })

test('leader opens a tutor Session, titles it, and writes its first message', async () => {
  const { ctx, tools, agents } = fakeContext()
  applyLeader(ctx)
  const leader = fakeLeader()

  const opened = await tools.get('mimir_leader_open').execute(
    { title: '概率论 · 条件概率', opening: '只讲条件概率、全概率和贝叶斯；不要展开独立性。' },
    exec(leader),
  )

  assert.equal(opened.title, '概率论 · 条件概率')
  assert.match(opened.note, /已开启导师会话/)
  const tutor = agents.get(opened.sessionId)
  assert.ok(tutor)
  assert.equal(tutor.session.title, '概率论 · 条件概率')
  assert.equal(tutor.status, 'running')
  const first = tutor.session.deriveMessages()[0]
  const text = first.content.map((block) => block.text).join('')
  assert.match(text, /只讲条件概率/)
  assert.match(text, /不要调用 mimir_new_session/)
  assert.match(text, /mimir_shared_lock/)

  await assert.rejects(
    tools.get('mimir_leader_open').execute({ title: '概率论 · 条件概率', opening: '重复开一个模块。' }, exec(leader)),
    /已经有一个标题/,
  )
})

test('leader lists, sends, reads, and stops its tutors', async () => {
  const { ctx, tools, agents } = fakeContext()
  applyLeader(ctx)
  const leader = fakeLeader()

  const opened = await tools.get('mimir_leader_open').execute(
    { title: '线性代数 · 向量空间', opening: '从向量空间公理开始。' },
    exec(leader),
  )
  const tutor = agents.get(opened.sessionId)
  tutor.status = 'idle'

  const listed = await tools.get('mimir_leader_list').execute({}, exec(leader))
  assert.match(listed.note, /向量空间/)
  assert.match(listed.note, /idle/)

  const sent = await tools.get('mimir_leader_send').execute(
    { session_id: opened.sessionId, message: '补一个二维例子。', mode: 'followup' },
    exec(leader),
  )
  assert.match(sent.note, /next|下一轮|已把/)
  const lastUser = tutor.session.deriveMessages().at(-1).content[0].text
  assert.match(lastUser, /\[Leader 指令\] 补一个二维例子/)

  tutor.pushMessage({ role: 'assistant', content: [{ type: 'text', text: '模块报告：完成；产出：向量空间笔记。' }] })
  const read = await tools.get('mimir_leader_read').execute(
    { session_id: opened.sessionId, messages: 2, role: 'both' },
    exec(leader),
  )
  assert.match(read.note, /模块报告/)
  assert.match(read.note, /\[Leader 指令\]/)

  const stopped = await tools.get('mimir_leader_stop').execute(
    { session_id: opened.sessionId },
    exec(leader),
  )
  assert.match(stopped.note, /已中止/)
})

test('shared lock serialises two tutors in application order', async () => {
  const { ctx, tools, agents, listeners } = fakeContext()
  applyLeader(ctx)
  applySharedLock(ctx)
  const lock = tools.get('mimir_shared_lock')
  const leader = fakeLeader()

  const first = await tools.get('mimir_leader_open').execute({ title: '模块一', opening: '开一。' }, exec(leader))
  const second = await tools.get('mimir_leader_open').execute({ title: '模块二', opening: '开二。' }, exec(leader))
  const tutorA = agents.get(first.sessionId)
  const tutorB = agents.get(second.sessionId)

  const leaseA = await lock.execute({ action: 'acquire', files: ['学习清单.md'] }, exec(tutorA))
  assert.match(leaseA.note, /已获得共享写锁/)

  const pendingB = lock.execute({ action: 'acquire', files: ['学习清单.md'] }, exec(tutorB))
  const status = await lock.execute({ action: 'status' }, exec(tutorB))
  assert.match(status.note, /写锁持有者/)
  assert.match(status.note, /排队/)

  const releasedA = await lock.execute({ action: 'release' }, exec(tutorA))
  assert.match(releasedA.note, /已释放/)

  const leaseB = await pendingB
  assert.match(leaseB.note, /已获得共享写锁/)
  await lock.execute({ action: 'release' }, exec(tutorB))

  const idle = await lock.execute({ action: 'status' }, exec(tutorA))
  assert.match(idle.note, /空闲/)

  // The fs gate refuses a direct write to a shared hub until the Session holds
  // the lease, and leaves other presets alone.
  const gate = listeners.get('fs/write-intent')[0]
  const sharedTarget = { displayPath: '/vault/Learn/学习清单.md' }
  assert.throws(() => gate(sharedTarget, { agent: tutorA }, () => ({ kind: 'createIfAbsent' })), /mimir_shared_lock/)
  const lease = await lock.execute({ action: 'acquire', files: ['学习清单.md'] }, exec(tutorA))
  assert.ok(lease.note.includes('已获得'))
  let delegated = false
  const decision = gate(sharedTarget, { agent: tutorA }, () => {
    delegated = true
    return { kind: 'createIfAbsent' }
  })
  assert.deepEqual(decision, { kind: 'createIfAbsent' })
  assert.equal(delegated, true)
  await lock.execute({ action: 'release', lease_id: lease.note.match(/lease-\d+/)[0] }, exec(tutorA))

  const standardAgent = { session: { id: 'standard', header: { agentPreset: 'standard' } } }
  assert.doesNotThrow(() => gate(sharedTarget, { agent: standardAgent }, () => undefined))
  assert.doesNotThrow(() => gate({ displayPath: '/vault/Learn/Concepts/note.md' }, { agent: tutorA }, () => undefined))
})
