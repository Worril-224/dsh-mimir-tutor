#!/usr/bin/env node
/**
 * vault-map.mjs — validate the dependency spine of a Mimir learning vault.
 *
 * Reads `Learn/Maps/*.md` and `Learn/Sessions/*.md`, checks every `graph:` spine
 * (foundations, nodes, goal, edges) and reports drift. With `--write`, rewrites
 * the generated mermaid block between
 *
 *   %% BEGIN generated · vault-map.mjs
 *   %% END generated · vault-map.mjs
 *
 * so its node classes match the concept notes' current status.
 *
 * Usage:
 *   node Tools/vault-map.mjs            # validate, report drift
 *   node Tools/vault-map.mjs --write    # validate and rewrite generated blocks
 *   node Tools/vault-map.mjs --root .   # explicit vault root
 *
 * Exit code 1 means a real spine error (for example an edge naming an unknown
 * node). Warnings do not fail the run.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'

const argv = process.argv.slice(2)
const root = resolve(flagValue('--root') ?? '.')
const shouldWrite = argv.includes('--write')
const quiet = argv.includes('--quiet')

function flagValue(flag) {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}

/* ------------------------------------------------------------------ YAML-ish */

function stripComment(value) {
  let quoted = null
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    if (quoted !== null) {
      if (char === quoted) quoted = null
      continue
    }
    if (char === '"' || char === "'") {
      quoted = char
      continue
    }
    if (char === '#' && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i)
  }
  return value
}

function parseScalar(raw) {
  let value = stripComment(raw).trim()
  if (value === '' || value === 'null' || value === '~') return null
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return Number(value)
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((part) => parseScalar(part))
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const inner = value.slice(1, -1).trim()
    if (inner === '') return {}
    const out = {}
    for (const part of inner.split(',')) {
      const colon = part.indexOf(':')
      if (colon < 0) continue
      out[unquote(part.slice(0, colon))] = parseScalar(part.slice(colon + 1))
    }
    return out
  }
  return unquote(value)
}

function unquote(value) {
  const text = value.trim()
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'")
  }
  return text
}

/** Parse the small YAML subset a vault frontmatter uses. */
function parseYaml(source) {
  const lines = source.split(/\r?\n/)
  let index = 0

  const indentOf = (line) => line.match(/^ */)[0].length
  const isSkippable = (line) => line.trim() === '' || line.trim().startsWith('#')

  function skip() {
    while (index < lines.length && isSkippable(lines[index])) index += 1
  }

  function parseBlock(minIndent) {
    skip()
    if (index >= lines.length) return null
    const indent = indentOf(lines[index])
    if (indent < minIndent) return null
    if (lines[index].trim().startsWith('- ')) return parseList(indent)
    return parseMap(indent)
  }

  function parseMap(indent) {
    const out = {}
    while (index < lines.length) {
      skip()
      if (index >= lines.length) break
      const line = lines[index]
      const current = indentOf(line)
      if (current < indent) break
      if (current > indent) {
        index += 1
        continue
      }
      const trimmed = line.trim()
      if (trimmed.startsWith('- ')) break
      const colon = trimmed.indexOf(':')
      if (colon < 0) {
        index += 1
        continue
      }
      const key = unquote(trimmed.slice(0, colon))
      const rest = trimmed.slice(colon + 1)
      index += 1
      if (rest.trim() === '') {
        const value = parseBlock(indent + 1)
        out[key] = value
      } else if (/^\s*[|>][-+]?\s*$/.test(rest)) {
        const folded = rest.trim().startsWith('>')
        const block = []
        let blockIndent = null
        while (index < lines.length) {
          const next = lines[index]
          if (next.trim() === '') {
            block.push('')
            index += 1
            continue
          }
          const nextIndent = indentOf(next)
          if (nextIndent <= indent) break
          if (blockIndent === null) blockIndent = nextIndent
          block.push(next.slice(blockIndent))
          index += 1
        }
        out[key] = folded ? block.join(' ').trim() : block.join('\n').trimEnd()
      } else {
        out[key] = parseScalar(rest)
      }
    }
    return out
  }

  function parseList(indent) {
    const out = []
    while (index < lines.length) {
      skip()
      if (index >= lines.length) break
      const line = lines[index]
      const current = indentOf(line)
      if (current !== indent || !line.trim().startsWith('- ')) break
      const rest = line.trim().slice(2)
      const itemIndent = indent + 2
      if (rest.trim() === '') {
        index += 1
        out.push(parseBlock(indent + 1))
        continue
      }
      const colon = rest.indexOf(':')
      if (colon > 0 && !rest.startsWith('"') && !rest.startsWith("'") && /^\s/.test(rest.slice(colon + 1)) === false) {
        // A map item such as "- id: F1".
        const item = {}
        const key = unquote(rest.slice(0, colon))
        const value = rest.slice(colon + 1)
        index += 1
        item[key] = value.trim() === '' ? parseBlock(itemIndent) : parseScalar(value)
        while (index < lines.length) {
          skip()
          if (index >= lines.length) break
          const next = lines[index]
          if (indentOf(next) !== itemIndent) break
          const nextTrim = next.trim()
          if (nextTrim.startsWith('- ')) break
          const nextColon = nextTrim.indexOf(':')
          if (nextColon < 0) break
          const nextKey = unquote(nextTrim.slice(0, nextColon))
          const nextValue = nextTrim.slice(nextColon + 1)
          index += 1
          item[nextKey] = nextValue.trim() === '' ? parseBlock(itemIndent + 1) : parseScalar(nextValue)
        }
        out.push(item)
      } else {
        out.push(parseScalar(rest))
        index += 1
      }
    }
    return out
  }

  const parsed = parseBlock(0)
  return parsed ?? {}
}

function splitFrontmatter(text) {
  if (!text.startsWith('---')) return { data: null, body: text, bodyStart: 0 }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { data: null, body: text, bodyStart: 0 }
  const head = text.slice(3, end).replace(/^\r?\n/, '')
  const rest = text.slice(end + 4)
  const body = rest.replace(/^\r?\n/, '')
  const bodyStart = text.length - body.length
  try {
    return { data: parseYaml(head), body, bodyStart }
  } catch {
    return { data: null, body: text, bodyStart: 0 }
  }
}

/* ------------------------------------------------------------------ vault I/O */

function markdownFiles(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md') && !name.startsWith('.'))
      .map((name) => join(dir, name))
      .filter((path) => statSync(path).isFile())
  } catch {
    return []
  }
}

function loadConcepts() {
  const conceptsDir = join(root, 'Learn', 'Concepts')
  const byName = new Map()
  const byShort = new Map()
  for (const path of markdownFiles(conceptsDir)) {
    const name = basename(path, '.md')
    const { data } = splitFrontmatter(readFileSync(path, 'utf8'))
    byName.set(name, data ?? {})
    if (data && typeof data.short === 'string' && data.short.trim() !== '') {
      if (!byShort.has(data.short.trim())) byShort.set(data.short.trim(), data)
    }
  }
  return { byName, byShort }
}

function linkTarget(value) {
  if (typeof value !== 'string') return null
  const match = value.match(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/)
  return match ? match[1].trim() : null
}

function classFor(concept) {
  if (!concept) return 'planned'
  if (concept.fragile === true) return 'fragile'
  if (concept.status === 'established') return 'held'
  if (concept.status === 'learning') return 'learning'
  if (concept.status === 'seed') return 'planned'
  return 'planned'
}

function nodeConcept(value, concepts) {
  const target = linkTarget(value)
  if (target !== null) return concepts.byName.get(target) ?? null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (concepts.byName.has(text)) return concepts.byName.get(text)
  if (concepts.byShort.has(text)) return concepts.byShort.get(text)
  return null
}

/* ------------------------------------------------------------------ graph */

function parseFoundations(list) {
  const out = []
  if (!Array.isArray(list)) return out
  list.forEach((entry, index) => {
    if (typeof entry === 'string') {
      const match = entry.match(/^\s*([A-Za-z0-9_-]+)\s*\|(.*)$/)
      if (match) out.push({ id: match[1], label: match[2].trim() })
      else out.push({ id: `F${index + 1}`, label: entry.trim() })
    } else if (entry && typeof entry === 'object') {
      const id = entry.id ?? `F${index + 1}`
      out.push({ id: String(id), label: String(entry.label ?? entry.text ?? id) })
    }
  })
  return out
}

function parseGraph(data) {
  const graph = data && typeof data.graph === 'object' && data.graph !== null ? data.graph : null
  if (!graph) return null
  const foundations = parseFoundations(graph.foundations)
  const planned = graph.nodes && typeof graph.nodes === 'object' && !Array.isArray(graph.nodes) ? graph.nodes : {}
  const linked = data.nodes && typeof data.nodes === 'object' && !Array.isArray(data.nodes) ? data.nodes : {}
  const nodes = {}
  for (const [id, value] of Object.entries(planned)) nodes[id] = value
  for (const [id, value] of Object.entries(linked)) nodes[id] = value
  const edges = []
  if (Array.isArray(graph.edges)) {
    for (const entry of graph.edges) {
      if (typeof entry !== 'string') continue
      const match = entry.match(/^\s*(\S+)\s*(?:-->|->|→)\s*(\S+)\s*$/)
      if (match) edges.push({ from: match[1], to: match[2] })
      else edges.push({ invalid: entry })
    }
  }
  return {
    goal: { id: 'G', label: String(graph.goal ?? (Array.isArray(graph.goals) ? graph.goals[0] : '') ?? '目标') },
    foundations,
    nodes,
    edges,
  }
}

function escapeMermaid(label) {
  return String(label).replace(/"/g, "'").replace(/\n+/g, ' ').trim()
}

function renderGenerated(data, graph, concepts) {
  const ids = new Set(['G', ...graph.foundations.map((item) => item.id), ...Object.keys(graph.nodes)])
  const classes = new Map()
  for (const foundation of graph.foundations) classes.set(foundation.id, 'foundation')
  classes.set('G', 'goal')
  for (const [id, value] of Object.entries(graph.nodes)) {
    classes.set(id, classFor(nodeConcept(value, concepts)))
  }
  const lines = ['graph TD']
  const labelOf = (id) => {
    if (id === 'G') return graph.goal.label
    const foundation = graph.foundations.find((item) => item.id === id)
    if (foundation) return foundation.label
    const raw = graph.nodes[id]
    const target = linkTarget(raw)
    if (target !== null) {
      const concept = concepts.byName.get(target)
      return (concept && typeof concept.short === 'string' && concept.short.trim() !== '') ? concept.short.trim() : target
    }
    return String(raw ?? id)
  }
  for (const edge of graph.edges) {
    if (edge.invalid) continue
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue
    lines.push(`  ${edge.from}["${escapeMermaid(labelOf(edge.from))}"] --> ${edge.to}["${escapeMermaid(labelOf(edge.to))}"]`)
  }
  const defs = {
    foundation: 'fill:#e8f0fe,stroke:#4285f4,color:#174ea6',
    goal: 'fill:#f3e8fd,stroke:#9334e6,color:#4a148c',
    held: 'fill:#e6f4ea,stroke:#34a853,color:#1e4620',
    learning: 'fill:#fef7e0,stroke:#f9ab00,color:#5c4400',
    fragile: 'fill:#fce8e6,stroke:#d93025,color:#5c1a16',
    planned: 'fill:#f1f3f4,stroke:#9aa0a6,color:#5f6368',
  }
  for (const [name, style] of Object.entries(defs)) lines.push(`  classDef ${name} ${style}`)
  for (const [id, name] of classes) lines.push(`  class ${id} ${name}`)
  return lines.join('\n')
}

function generatedBlock(data, graph, concepts) {
  const body = renderGenerated(data, graph, concepts)
  return `%% BEGIN generated · vault-map.mjs\n${body}\n%% END generated · vault-map.mjs`
}

/* ------------------------------------------------------------------ main */

const errors = []
const warnings = []
const checked = []

const concepts = loadConcepts()

function checkNote(path) {
  const text = readFileSync(path, 'utf8')
  const { data, body, bodyStart } = splitFrontmatter(text)
  if (!data || !data.graph) return
  const graph = parseGraph(data)
  if (!graph) return
  const relative = path.slice(root.length + 1)
  const ids = new Set(['G', ...graph.foundations.map((item) => item.id), ...Object.keys(graph.nodes)])

  if (graph.foundations.length === 0) warnings.push(`${relative}: graph.foundations 为空`)
  if (Object.keys(graph.nodes).length === 0) warnings.push(`${relative}: 没有节点`)
  if (graph.edges.length === 0) warnings.push(`${relative}: graph.edges 为空`)

  for (const edge of graph.edges) {
    if (edge.invalid) {
      errors.push(`${relative}: 无法解析的边 "${edge.invalid}"（格式应为 A -> B）`)
      continue
    }
    for (const end of [edge.from, edge.to]) {
      if (!ids.has(end)) errors.push(`${relative}: 边 ${edge.from} -> ${edge.to} 指名了不存在的节点 "${end}"`)
    }
  }

  const foundationIds = new Set(graph.foundations.map((item) => item.id))
  for (const edge of graph.edges) {
    if (edge.invalid) continue
    if (edge.from === edge.to) warnings.push(`${relative}: 自环 ${edge.from} -> ${edge.to}`)
    if (foundationIds.has(edge.to)) {
      warnings.push(`${relative}: 边 ${edge.from} -> ${edge.to} 指向了根基 ${edge.to}（根基不该有入边）`)
    }
  }

  // Kahn's algorithm: a cycle makes the teaching order undefined.
  const indegree = new Map([...ids].map((id) => [id, 0]))
  const adjacency = new Map([...ids].map((id) => [id, []]))
  for (const edge of graph.edges) {
    if (edge.invalid || !ids.has(edge.from) || !ids.has(edge.to)) continue
    adjacency.get(edge.from).push(edge.to)
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
  }
  const queue = [...ids].filter((id) => indegree.get(id) === 0)
  let visited = 0
  while (queue.length > 0) {
    const id = queue.shift()
    visited += 1
    for (const next of adjacency.get(id) ?? []) {
      indegree.set(next, indegree.get(next) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  if (visited < ids.size) errors.push(`${relative}: graph 里有环，讲授顺序没有定义`)

  for (const [id, value] of Object.entries(graph.nodes)) {
    const target = linkTarget(value)
    if (target !== null && !concepts.byName.has(target)) {
      warnings.push(`${relative}: 节点 ${id} 链接的 [[${target}]] 在 Learn/Concepts/ 里不存在`)
    }
  }

  const begin = body.indexOf('%% BEGIN generated · vault-map.mjs')
  const end = body.indexOf('%% END generated · vault-map.mjs')
  if (begin >= 0 && end > begin) {
    const expected = generatedBlock(data, graph, concepts)
    const current = body.slice(begin, end + '%% END generated · vault-map.mjs'.length)
    if (current !== expected) {
      if (shouldWrite) {
        const endMarker = '%% END generated · vault-map.mjs'
        writeFileSync(path, text.slice(0, bodyStart) + body.slice(0, begin) + expected + body.slice(end + endMarker.length), 'utf8')
        checked.push(`${relative}: generated 块已重写`)
      } else {
        warnings.push(`${relative}: generated 块与当前状态不一致（用 --write 重写）`)
      }
    } else {
      checked.push(`${relative}: ok`)
    }
  } else if ((begin >= 0) !== (end >= 0)) {
    errors.push(`${relative}: generated 块只找到一半标记`)
  } else {
    checked.push(`${relative}: ok（无 generated 块，用 vault-chart.mjs 出 SVG）`)
  }
}

for (const folder of ['Maps', 'Sessions']) {
  for (const path of markdownFiles(join(root, 'Learn', folder))) checkNote(path)
}

if (!quiet) {
  for (const line of checked) console.log(`✓ ${line}`)
  for (const line of warnings) console.log(`! ${line}`)
  for (const line of errors) console.log(`✗ ${line}`)
  console.log(`\n${errors.length} error(s), ${warnings.length} warning(s)`)
}

process.exitCode = errors.length > 0 ? 1 : 0
