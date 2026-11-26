/**
 * mimir_new_session — open a sibling Session for the next study module.
 *
 * One module per Session keeps a long course from piling every topic into one
 * transcript, keeps each turn's context to the module at hand, and gives the
 * learner a named Session to reopen when a review touches that module.
 *
 * The tool is deliberately dependency-free (no imports beyond a Node builtin):
 * preset plugins resolve modules from the profile, which does not carry the
 * harness packages, so a bare `@deepseek-ai/...` import here would fail at load.
 *
 * @module dsh-mimir-tutor/session-tool
 */

import { randomUUID } from 'node:crypto'
import { LEADER_OPENING_MARKER } from './coordinator.js'

/** Plugin name shown by the loader. */
export const name = 'mimir-new-session'

/** Host services this tool reads. */
export const inject = ['tools', 'agents', 'sessions', 'agentPresets', 'sessionTitle']

/** Preset every new study Session is composed from. */
const PRESET = 'mimir-tutor'

/** Longest title accepted by the session-title service, in characters. */
const TITLE_LIMIT = 40

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
 * Whether this tutor Session was opened by a Mimir Leader. The Leader writes a
 * marked first message; scanning the first user turn is enough, and it does not
 * add another durable event type to the session.
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent - the calling tutor.
 * @returns {boolean} true when the Leader owns session openings.
 */
function leaderSpawned(agent) {
  try {
    const firstUser = agent.session.deriveMessages().find((message) => message.role === 'user')
    if (firstUser === undefined) return false
    return firstUser.content.some((block) => block.type === 'text' && typeof block.text === 'string' && block.text.includes(LEADER_OPENING_MARKER))
  } catch {
    return false
  }
}

/**
 * Register the `mimir_new_session` tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - preset scope carrying the Host services.
 */
export function apply(ctx) {
  ctx.tools.register({
    name: 'mimir_new_session',
    description: [
      '为下一个学习模块新开一个会话（Session），让每个模块的学习集中在一个会话里。',
      '用一个模块结束、或学习者暂时停下这个模块时调用：先在本会话里写完回（会话笔记、概念、图谱、复习条目），',
      '再用目标模块的标题调用本工具。不要在一个会话里同时教两个模块；也不要在同一轮里连开多个会话。',
      '新会话与当前会话同一工作目录、同一「Mimir 导师」预设，标题已设好，学习者可以在会话列表里直接打开。',
      '调用后，用一句话告诉学习者新会话的标题和下一步，不要替学习者在新会话里发消息。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          description: '新会话的标题，格式「模块 · 本次目标」，例如「机器学习 · 线性回归」。不超过 40 字。',
        },
        next: {
          type: 'string',
          description: '新会话的第一步：一句话说明从哪里接上，例如「先复习最小二乘，再讲正则化」。可省略。',
        },
      },
      required: ['title'],
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
      const caller = exec === undefined ? undefined : exec.agent
      if (caller === undefined) throw new Error('mimir_new_session 只能在一个 Mimir 导师会话里调用')
      if (leaderSpawned(caller)) {
        throw new Error('本次会话由 Mimir · Leader 开启：不要新开会话。把模块报告写进最后一条消息，由 Leader 决定下一个会话。')
      }

      const cwd = caller.session.header.cwd
      if (cwd === undefined) throw new Error('当前会话没有工作目录，无法新开会话')

      const preset = await ctx.agentPresets.resolve(PRESET)
      if (preset.broken !== undefined) {
        throw new Error(`预设「${PRESET}」当前不可用：${preset.broken}。先修好插件，再新开会话。`)
      }

      const handle = await ctx.agents.create({
        sessionId: `session-${randomUUID()}`,
        meta: { cwd, agentPreset: PRESET },
        setup: async (agentCtx, agent) => {
          await ctx.agentPresets.mount(agentCtx, PRESET)
          agent.session.append('agent-preset/selected', { agentPreset: PRESET })
        },
      })

      const title = titleOf(args.title)
      let stored = title
      try {
        stored = ctx.sessionTitle.rename(handle.agent.session, title).title
      } catch {
        // A title failure must not strand a live Session; the learner can rename it.
      }

      const next = typeof args.next === 'string' && args.next.trim() !== ''
        ? ` 进去之后从这一步开始：${args.next.trim()}`
        : ''
      const note = `已新开会话《${stored}》。在左侧会话列表里切换过去即可；本会话保留，模块的笔记和图谱都已经写进库里。${next}`

      return { sessionId: handle.agent.id, title: stored, note }
    },
  })
}
