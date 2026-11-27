/**
 * Mimir · Leader tools.
 *
 * A Leader Session is deliberately not a tutor: it owns no teaching method and
 * writes nothing into the vault. Its job is to open tutor Sessions, author the
 * first message each tutor receives, and keep the shared-file write queue in
 * order. The tutors remain ordinary `mimir-tutor` Sessions, so the learner can
 * switch to any of them and be taught by the same preset as before.
 *
 * Dependencies are kept to Host services already present in every profile that
 * runs the tutor. No harness package is imported: preset plugins resolve from
 * the profile, which does not carry those packages.
 *
 * @module dsh-mimir-tutor/leader-tool
 */

import { randomUUID } from 'node:crypto'
import { LEADER_OPENING_MARKER, getCoordinator } from './coordinator.js'

/** Plugin name shown by the loader. */
export const name = 'mimir-leader-tools'

/** Host services these tools read. */
export const inject = ['tools', 'agents', 'agentPresets', 'sessions', 'sessionTitle']

/** Every tutor Session is composed from the existing tutor preset. */
const TUTOR_PRESET = 'mimir-tutor'

const FALLBACK_MODEL_SELECTION = Object.freeze({
  provider: process.env.MIMIR_TUTOR_PROVIDER ?? 'deepseek-official',
  model: process.env.MIMIR_TUTOR_MODEL ?? 'deepseek-flash',
  reasoningEffort: process.env.MIMIR_TUTOR_EFFORT ?? 'high',
})

function resolveModelSelection(ctx) {
  try {
    // Read the default-model service lazily: it is optional, and declaring it
    // as a required inject would unload this whole plugin on deployments that
    // do not mount it.
    const service = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
    const current = service?.currentSelection?.()
    if (current?.provider !== undefined && current.model !== undefined) return current
  } catch {
    /* fall through */
  }
  return { ...FALLBACK_MODEL_SELECTION }
}

/**
 * How long a tool waits for the tutor's turn to settle before reporting
 * "still running". A failing transport settles in seconds, so the default
 * catches the common breakage without blocking an otherwise healthy turn.
 */
const TURN_WAIT_MS = (() => {
  const raw = Number.parseInt(process.env.MIMIR_LEADER_WAIT_MS ?? '', 10)
  return Number.isFinite(raw) && raw >= 0 ? raw : 20_000
})()

/**
 * Build the user message a tutor receives.
 *
 * `agent.followup()` takes a full `UserMessage`: the harness's own
 * `createUserMessage()` always sets `role: 'user'` and a fresh `id`. Omitting
 * `role` here is not a cosmetic difference — the DeepSeek serializer groups
 * adjacent messages by `role`, so an undefined role makes it compare equal to
 * the (absent) previous wire message and then dereference it, which surfaces
 * as `TRANSPORT` before any HTTP request is made.
 * @param {string} text - message body.
 * @returns {object} a user message the agent loop accepts.
 */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * Find the last `turn/end` this watch is allowed to see.
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent - the tutor.
 * @param {number} startSeq - Session sequence captured before the message.
 * @returns {object | undefined} the settlement event.
 */
function turnEndAfter(agent, startSeq) {
  try {
    const events = agent.session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.seq < startSeq) break
      if (event.type === 'turn/end') return event
    }
  } catch {
    // A session that cannot be read is reported as still running.
  }
  return undefined
}

/**
 * Wait for the tutor's turn to settle and report its reason.
 *
 * Polling the Session log is deliberately used instead of a Host event
 * listener: preset plugins are mounted in their own scope, so a
 * `session/event` subscription there does not observe another Session's
 * events. `startSeq` keeps an older turn's settlement out of the answer.
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent - the tutor.
 * @param {number} startSeq - Session sequence captured before the message.
 * @param {number} [timeoutMs] - how long to wait.
 * @returns {Promise<{ kind: string, message?: string }>} the settled outcome.
 */
async function turnOutcome(agent, startSeq, timeoutMs = TURN_WAIT_MS) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const event = turnEndAfter(agent, startSeq)
    if (event !== undefined) {
      const reason = event.data && event.data.reason ? event.data.reason : {}
      if (reason.kind === 'error') {
        const error = reason.error
        return {
          kind: 'error',
          message: error instanceof Error ? error.message : String(error ?? '未知错误'),
        }
      }
      return { kind: typeof reason.kind === 'string' ? reason.kind : 'completed' }
    }
    if (Date.now() >= deadline) return { kind: 'timeout' }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 250)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }
}

/**
 * Render one turn outcome for a model-facing note.
 * @param {string} label - what was being attempted, e.g. 「第一回合」.
 * @param {{ kind: string, message?: string }} outcome - settled outcome.
 * @returns {string} a short sentence.
 */
function describeOutcome(label, outcome) {
  if (outcome.kind === 'completed') return `${label}已完成。`
  if (outcome.kind === 'error') return `${label}失败：${outcome.message}。`
  if (outcome.kind === 'timeout') return `${label}仍在运行。`
  return `${label}结束（${outcome.kind}）。`
}

/** Longest title accepted by the session-title service, in characters. */
const TITLE_LIMIT = 40

/** Files a tutor must not write without the shared-write lease. */
const SHARED_FILES = [
  '🌱 学习索引.md',
  '学习者档案.md',
  '学习清单.md',
  '术语表.md',
  '阅读清单.md',
  'Reviews/复习队列.md',
].join('、')

/** Longest single message excerpt returned by `mimir_leader_read`. */
const MESSAGE_EXCERPT = 1600

/** Longest total transcript body returned by `mimir_leader_read`. */
const TRANSCRIPT_LIMIT = 9000

/**
 * Trim a proposed title to the accepted length and reject an empty one.
 * @param {unknown} raw - model-supplied title.
 * @returns {string} the title to store.
 */
function titleOf(raw) {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  if (text === '') throw new Error('title 不能为空；用「模块 · 本次目标」的短标题，例如「机器学习 · 线性回归」')
  return Array.from(text).slice(0, TITLE_LIMIT).join('')
}

/**
 * Normalise the Leader-authored opening message.
 * @param {unknown} raw - model-supplied opening.
 * @returns {string} the non-empty opening.
 */
function openingOf(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') {
    throw new Error('opening 不能为空；导师看到的第一条消息就是它，要写清模块目标、范围、依赖和结束报告。')
  }
  return text
}

/**
 * The calling Session id.
 * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec - tool execution.
 * @param {string} toolName - tool name used in the failure message.
 * @returns {import('@deepseek-ai/dsh-agent').Agent} the calling agent.
 */
function callerOf(exec, toolName) {
  const caller = exec === undefined ? undefined : exec.agent
  if (caller === undefined) throw new Error(`${toolName} 只能在 Mimir · Leader 会话里调用`)
  return caller
}

/**
 * Look up a tutor Session in this Leader's roster and check it is still live.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} leaderSessionId - the calling Leader.
 * @param {string} sessionId - claimed tutor Session id.
 * @returns {{ record: object, agent: import('@deepseek-ai/dsh-agent').Agent }} the roster record and live agent.
 */
function liveTutor(ctx, leaderSessionId, sessionId) {
  const record = getCoordinator().findMentor(sessionId)
  if (record === undefined || record.leaderSessionId !== leaderSessionId) {
    throw new Error('这个会话不是本 Leader 开启的导师会话；先用 mimir_leader_open 开启它。')
  }
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) {
    throw new Error(`导师会话 ${sessionId} 当前没有加载（可能 Host 已重启或会话已关闭），无法在本次运行里调度它。`)
  }
  return { record, agent }
}

/**
 * Whether an agent has finished everything queued for it.
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent - live agent.
 * @returns {boolean} true when idle with an empty inbox.
 */
function isIdle(agent) {
  if (agent.status !== 'idle') return false
  return agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0
}

/**
 * Collect the text blocks of one message.
 * @param {import('@deepseek-ai/dsh-llm').Message} message - derived message.
 * @returns {string} joined text.
 */
function textOf(message) {
  const blocks = Array.isArray(message.content) ? message.content : []
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => block.text)
    .filter((text) => typeof text === 'string' && text !== '')
    .join('\n')
}

/**
 * Last assistant excerpt for the roster list.
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent - live tutor.
 * @returns {string} a one-line excerpt, or an empty string.
 */
function lastAssistantExcerpt(agent) {
  try {
    const messages = agent.session.deriveMessages()
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.role !== 'assistant') continue
      const text = textOf(message).replace(/\s+/g, ' ').trim()
      if (text === '') continue
      return Array.from(text).slice(0, 90).join('') + (Array.from(text).length > 90 ? '…' : '')
    }
  } catch {
    // A session whose history cannot be derived is still listable by status.
  }
  return ''
}

/**
 * Read a title back from the live Session, falling back to the stored one.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent - live tutor.
 * @param {string} fallback - title recorded when the Session was opened.
 * @returns {string} the best known title.
 */
function titleOfSession(ctx, agent, fallback) {
  try {
    const title = ctx.sessionTitle.get(agent.session)
    return typeof title === 'string' && title !== '' ? title : fallback
  } catch {
    return fallback
  }
}

/**
 * Format the shared-write snapshot for a model-facing note.
 * @param {object} snapshot - coordinator snapshot.
 * @returns {string} one paragraph.
 */
function describeLocks(snapshot) {
  const holder = snapshot.holder === null
    ? '当前没有导师持有共享写锁。'
    : `当前写锁：${snapshot.holder.sessionId}（已持有 ${Math.round(snapshot.holder.heldMs / 1000)} 秒${snapshot.holder.files.length > 0 ? `；计划写 ${snapshot.holder.files.join('、')}` : ''}）。`
  const queue = snapshot.queue.length === 0
    ? '没有排队的写锁申请。'
    : `排队中（按申请顺序）：${snapshot.queue.map((entry) => `${entry.position}. ${entry.sessionId}`).join('；')}。`
  return `${holder}${queue}`
}

/**
 * Build the first message a tutor receives. The Leader's `opening` is the
 * substantive instruction; the appended protocol is what makes parallel
 * tutoring safe, and it is present even when the Leader forgets to mention it.
 * @param {string} opening - Leader-authored brief.
 * @param {{ leaderSessionId: string, title: string }} facts - routing facts.
 * @returns {string} the complete first user message.
 */
function buildOpening(opening, facts) {
  return [
    `${LEADER_OPENING_MARKER} 你负责「${facts.title}」。`,
    `主导航会话：${facts.leaderSessionId}。`,
    '',
    opening,
    '',
    '—— 调度约定（Leader 自动附上）——',
    `- 本会话由 Leader 开启（Mimir · Leader）。不要调用 mimir_new_session，也不要自行开新会话；模块讲完就停下，等 Leader 的指令。`,
    `- 写共享文件（${SHARED_FILES}，以及任何你不是唯一作者的笔记）之前，先调用 mimir_shared_lock（action=acquire）；拿到锁后再读、再写；写完立即 action=release。没有锁时直接 write/edit 共享文件会被拒绝。只属于本模块的会话笔记、概念笔记、图谱可以直接写。`,
    '- 模块讲完或需要暂停时，在最后一条消息里写一行「模块报告：完成/暂停；产出：…；下一步：…」，然后停下。',
  ].join('\n')
}

/**
 * Register the Leader tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - preset scope carrying the Host services.
 */
export function apply(ctx) {
  ctx.tools.register({
    name: 'mimir_leader_open',
    description: [
      '开启一个 Mimir 导师会话（Session），并把第一句话发给它。',
      '学习者确认课程拆分后，每个模块调用一次；一个模块只开一个会话，不要重复开同一模块。',
      'opening 是导师看到的第一条消息：写清本模块的目标、范围、依赖、必须写回的内容，以及结束时怎么报告。',
      '工具会补齐调度约定（不要自己开新会话、共享文件先申请 mimir_shared_lock、结束写模块报告），但 opening 本身必须自足。',
      '会话与 Leader 同一工作目录、使用同一个「Mimir 导师」预设，标题已设好；调用后出现在学习者会话列表的「未分组」里。',
      '返回的 note 会写明第一回合结果是完成、失败还是仍在运行；失败时把错误原文转告学习者，不要谎报成功。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          description: '导师会话标题，格式「模块 · 本次目标」，例如「机器学习 · 线性回归」。不超过 40 字。',
        },
        opening: {
          type: 'string',
          description: '你写给导师的第一条消息。写清模块目标、范围、依赖、要写回什么、结束报告要求；不要只写「开始吧」。',
        },
      },
      required: ['title', 'opening'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['sessionId', 'title', 'note'],
      },
      render(_args, value) {
        return [{ type: 'text', text: value.note }]
      },
    },
    async execute(args, exec) {
      const leader = callerOf(exec, 'mimir_leader_open')
      const cwd = leader.session.header.cwd
      if (cwd === undefined) throw new Error('当前 Leader 会话没有工作目录，无法开启导师会话')

      const preset = await ctx.agentPresets.resolve(TUTOR_PRESET)
      if (preset.broken !== undefined) {
        throw new Error(`预设「${TUTOR_PRESET}」当前不可用：${preset.broken}。先修好插件，再开启导师会话。`)
      }

      const title = titleOf(args.title)
      const opening = openingOf(args.opening)
      const coordinator = getCoordinator()
      const duplicate = coordinator.mentorsOf(leader.session.id).find((record) => record.title === title)
      if (duplicate !== undefined) {
        throw new Error(`已经有一个标题为《${title}》的导师会话（${duplicate.sessionId}）。一个模块只开一个会话；要继续这个模块，用 mimir_leader_send 给它发消息。`)
      }
      const handle = await ctx.agents.create({
        sessionId: `session-${randomUUID()}`,
        meta: { cwd, agentPreset: TUTOR_PRESET },
        agentOptions: resolveModelSelection(ctx),
        setup: async (agentCtx, agent) => {
          await ctx.agentPresets.mount(agentCtx, TUTOR_PRESET)
          agent.session.append('agent-preset/selected', { agentPreset: TUTOR_PRESET })
        },
      })

      let stored = title
      try {
        stored = ctx.sessionTitle.rename(handle.agent.session, title).title
      } catch {
        // A title failure must not strand a live Session; the Leader can rename it later.
      }

      const sessionId = handle.agent.id
      // Capture the sequence before queueing: a fast transport failure settles
      // the turn in well under a second.
      const outcomes = turnOutcome(handle.agent, handle.agent.session.seq)
      try {
        handle.agent.followup(userMessage(buildOpening(opening, {
          leaderSessionId: leader.session.id,
          title: stored,
        })))
      } catch (error) {
        // A Session without its opening would be an orphan no Leader can drive.
        try {
          await handle.dispose()
        } catch {
          // The original send failure is the useful one.
        }
        throw new Error(`导师会话已创建但第一句话没有发出去，已回收：${error instanceof Error ? error.message : String(error)}`)
      }
      coordinator.registerMentor(leader.session.id, {
        sessionId,
        title: stored,
        opening,
        createdAt: Date.now(),
      })

      const outcome = await outcomes
      return {
        sessionId,
        title: stored,
        note: `已开启导师会话《${stored}》（${sessionId}），并把你的第一句话发给它；${describeOutcome('第一回合', outcome)}学习者在左侧会话列表的「未分组」里切换过去即可。`,
      }
    },
  })

  ctx.tools.register({
    name: 'mimir_leader_send',
    description: [
      '给一个已经开启的导师会话发消息。',
      '默认 followup：在当前回合之后排一个新回合；导师正在讲、你要中途纠偏时用 mode=steer。',
      '只用于本 Leader 开启的导师会话；发完会返回导师当前状态。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session_id: { type: 'string', description: 'mimir_leader_open 返回的导师会话 id。' },
        message: { type: 'string', description: '给导师的消息；工具会自动加上「[Leader 指令]」前缀。' },
        mode: {
          type: 'string',
          enum: ['followup', 'steer'],
          description: 'followup=排到当前回合之后（默认）；steer=在当前回合的下一个步骤插入纠偏。',
        },
      },
      required: ['session_id', 'message'],
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
    async execute(args, exec) {
      const leader = callerOf(exec, 'mimir_leader_send')
      const { record, agent } = liveTutor(ctx, leader.session.id, args.session_id)
      const text = typeof args.message === 'string' ? args.message.trim() : ''
      if (text === '') throw new Error('message 不能为空')
      const mode = args.mode === 'steer' ? 'steer' : 'followup'
      const outcomes = turnOutcome(agent, agent.session.seq)
      const message = userMessage(`[Leader 指令] ${text}`)
      if (mode === 'steer') agent.steer(message)
      else agent.followup(message)
      const outcome = await outcomes
      return {
        note: `已把${mode === 'steer' ? '纠偏指令' : '下一轮消息'}发给《${record.title}》。${describeOutcome('这一回合', outcome)}`,
      }
    },
  })

  ctx.tools.register({
    name: 'mimir_leader_list',
    description: '列出本 Leader 开启的导师会话：标题、运行状态、消息数、最后一条助手消息的摘录，以及共享写锁的当前持有者和排队顺序。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
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
    async execute(_args, exec) {
      const leader = callerOf(exec, 'mimir_leader_list')
      const roster = getCoordinator().mentorsOf(leader.session.id)
      if (roster.length === 0) {
        return { note: '你还没有开启任何导师会话。先用 mimir_leader_open 开一个模块。' }
      }
      const lines = roster.map((record, index) => {
        const agent = ctx.agents.get(record.sessionId)
        if (agent === undefined) {
          return `${index + 1}. ${record.sessionId} 《${record.title}》 状态=offline（本次运行没有加载；不能调度）`
        }
        const title = titleOfSession(ctx, agent, record.title)
        const count = (() => {
          try {
            return String(agent.session.deriveMessages().length)
          } catch {
            return '?'
          }
        })()
        const excerpt = lastAssistantExcerpt(agent)
        return `${index + 1}. ${record.sessionId} 《${title}》 状态=${agent.status} 消息=${count}${excerpt === '' ? '' : ` 最后：${excerpt}`}`
      })
      const locks = describeLocks(getCoordinator().snapshot())
      return { note: `${lines.join('\n')}\n\n${locks}` }
    },
  })

  ctx.tools.register({
    name: 'mimir_leader_read',
    description: [
      '读取一个导师会话最近的对话，用来了解进度或把导师的产出转告学习者。',
      '默认只读助手消息；role=both 时也读用户消息（包括 Leader 自己发的开场白）。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session_id: { type: 'string', description: '导师会话 id。' },
        messages: { type: 'number', description: '读取最后几条，默认 4，最多 10。' },
        role: { type: 'string', enum: ['assistant', 'both'], description: '默认 assistant；both 包含用户消息。' },
      },
      required: ['session_id'],
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
    async execute(args, exec) {
      const leader = callerOf(exec, 'mimir_leader_read')
      const { record, agent } = liveTutor(ctx, leader.session.id, args.session_id)
      const requested = Number.isFinite(args.messages) ? Math.trunc(args.messages) : 4
      const count = Math.min(Math.max(requested, 1), 10)
      const role = args.role === 'both' ? 'both' : 'assistant'

      let messages
      try {
        messages = agent.session.deriveMessages()
      } catch (error) {
        throw new Error(`无法读取导师会话的对话历史：${error instanceof Error ? error.message : String(error)}`)
      }
      const selected = messages
        .filter((message) => message.role === 'assistant' || (role === 'both' && message.role === 'user'))
        .slice(-count)

      if (selected.length === 0) {
        return { note: `《${record.title}》还没有可读的消息；导师可能刚启动。用 mimir_leader_wait 等它跑完一个回合。` }
      }

      let used = 0
      const sections = []
      for (const message of selected) {
        const body = textOf(message).trim()
        if (body === '') continue
        const clipped = Array.from(body).slice(0, MESSAGE_EXCERPT).join('')
        const section = `### ${message.role === 'assistant' ? '导师' : '用户'}\n${clipped}${Array.from(body).length > MESSAGE_EXCERPT ? '\n…（截断）' : ''}`
        if (used + section.length > TRANSCRIPT_LIMIT) break
        sections.push(section)
        used += section.length
      }
      if (sections.length === 0) {
        return { note: `《${record.title}》最近的消息只有工具调用，没有可转述的文本。` }
      }
      return { note: `《${record.title}》最近 ${sections.length} 条消息：\n\n${sections.join('\n\n')}` }
    },
  })

  ctx.tools.register({
    name: 'mimir_leader_wait',
    description: [
      '等一个导师会话（或不指定 session_id 时等本 Leader 的全部导师）跑完当前回合。',
      '给 timeout_ms 一个上界；超时不会取消导师，只返回「还在运行」。',
      '不要用它等一整节课：导师要学习者回答问题时，回合不会结束。定期用 list/read 看进度。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session_id: { type: 'string', description: '要等待的导师会话 id；省略则等全部本 Leader 的导师。' },
        timeout_ms: { type: 'number', description: '最长等待毫秒，默认 60000，范围 1000–120000。' },
      },
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
    timeoutMs: 150_000,
    async execute(args, exec) {
      const leader = callerOf(exec, 'mimir_leader_wait')
      const coordinator = getCoordinator()
      const records = args.session_id === undefined
        ? coordinator.mentorsOf(leader.session.id)
        : [liveTutor(ctx, leader.session.id, args.session_id).record]
      if (records.length === 0) return { note: '没有可等待的导师会话。' }

      const targets = records.map((record) => ({ record, agent: ctx.agents.get(record.sessionId) }))
      const requested = Number.isFinite(args.timeout_ms) ? Math.trunc(args.timeout_ms) : 60_000
      const timeoutMs = Math.min(Math.max(requested, 1_000), 120_000)
      const deadline = Date.now() + timeoutMs

      while (Date.now() < deadline) {
        if (exec.signal.aborted) throw new Error('等待已取消。')
        const busy = targets.filter((target) => target.agent !== undefined && !isIdle(target.agent))
        if (busy.length === 0) break
        await new Promise((resolve) => setTimeout(resolve, 200))
      }

      const lines = targets.map(({ record, agent }) => {
        if (agent === undefined) return `- 《${record.title}》 offline（本次运行没有加载）`
        return isIdle(agent)
          ? `- 《${record.title}》 已空闲（回合结束）`
          : `- 《${record.title}》 仍在运行（等它跑完或稍后再看）`
      })
      const live = targets.filter(({ agent }) => agent !== undefined)
      const allLiveIdle = live.length > 0 && live.every(({ agent }) => isIdle(agent))
      const offline = targets.length - live.length
      const summary = allLiveIdle
        ? (offline > 0 ? `在线导师已全部空闲；${offline} 个会话 offline。` : '全部导师已空闲。')
        : `等待了约 ${Math.round(timeoutMs / 1000)} 秒，仍有导师在运行${offline > 0 ? `；另有 ${offline} 个 offline` : ''}。`
      return { note: `${summary}\n${lines.join('\n')}` }
    },
  })

  ctx.tools.register({
    name: 'mimir_leader_stop',
    description: '中止一个导师会话当前的回合（并释放它持有的共享写锁）。用它处理跑偏或不再需要的导师；不会删除会话或学习库内容。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session_id: { type: 'string', description: '要停止的导师会话 id。' },
        keep_inbox: { type: 'boolean', description: '为 true 时保留排队中的消息；默认 false，连同队列一起丢弃。' },
      },
      required: ['session_id'],
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
    async execute(args, exec) {
      const leader = callerOf(exec, 'mimir_leader_stop')
      const { record, agent } = liveTutor(ctx, leader.session.id, args.session_id)
      agent.cancel({ kind: 'user' }, { keepInbox: args.keep_inbox === true })
      const cleanup = getCoordinator().releaseAllForSession(record.sessionId, 'Leader 停止')
      return {
        note: `已中止《${record.title}》的当前回合。${cleanup.released > 0 ? '它持有的共享写锁已释放。' : ''}${cleanup.cancelled > 0 ? `删除了 ${cleanup.cancelled} 个排队中的写锁申请。` : ''}`,
      }
    },
  })

  ctx.tools.register({
    name: 'mimir_leader_locks',
    description: [
      '查看共享写锁的持有者和排队顺序，或在导师卡住时强制释放。',
      'action=release 且给 session_id 时清掉该导师的锁和排队；不给 session_id 时释放当前持有者的锁。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'release'], description: 'status=查看（默认）；release=强制释放。' },
        session_id: { type: 'string', description: 'release 时要清理的导师会话 id；省略则释放当前持有者。' },
      },
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
    async execute(args, exec) {
      const leader = callerOf(exec, 'mimir_leader_locks')
      const coordinator = getCoordinator()
      if (args.action === 'release') {
        if (args.session_id !== undefined) {
          const record = coordinator.findMentor(args.session_id)
          if (record === undefined || record.leaderSessionId !== leader.session.id) {
            throw new Error('这个会话不是本 Leader 开启的导师会话。')
          }
          const result = coordinator.releaseAllForSession(args.session_id, 'Leader 强制释放')
          return { note: `已清理《${record.title}》的写锁状态：释放 ${result.released} 个锁，取消 ${result.cancelled} 个排队申请。` }
        }
        const result = coordinator.release(undefined, undefined, { force: true })
        return { note: result.note }
      }
      return { note: describeLocks(coordinator.snapshot()) }
    },
  })
}
