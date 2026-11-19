#!/usr/bin/env node
/**
 * vault-chart.mjs — draw a Mimir map as an SVG dependency chart.
 *
 * Reads `Learn/Maps/*.md` with a `graph:` spine and writes
 * `Learn/Viz/<subject>-map.svg`. Foundations sit at the top, the goal at the
 * bottom, and node colour follows the linked concept note's status:
 *
 *   established → green, learning → amber, fragile → red dashed,
 *   planned → grey dotted, foundations → blue, goal → purple.
 *
 * Usage:
 *   node Tools/vault-chart.mjs                 # redraw every map
 *   node Tools/vault-chart.mjs --subject 真菌学  # one subject only
 *   node Tools/vault-chart.mjs --root .
 *
 * The chart is deterministic: same notes, same SVG.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'

const argv = process.argv.slice(2)
const root = resolve(flagValue('--root') ?? '.')
const onlySubject = flagValue('--subject')

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
  const value = stripComment(raw).trim()
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
        out[key] = parseBlock(indent + 1)
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
      if (indentOf(line) !== indent || !line.trim().startsWith('- ')) break
      const rest = line.trim().slice(2)
      if (rest.trim() === '') {
        index += 1
        out.push(parseBlock(indent + 1))
        continue
      }
      out.push(parseScalar(rest))
      index += 1
    }
    return out
  }

  return parseBlock(0) ?? {}
}

function splitFrontmatter(text) {
  if (!text.startsWith('---')) return { data: null, body: text }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { data: null, body: text }
  const head = text.slice(3, end).replace(/^\r?\n/, '')
  const body = text.slice(end + 4).replace(/^\r?\n/, '')
  try {
    return { data: parseYaml(head), body }
  } catch {
    return { data: null, body: text }
  }
}

/* ------------------------------------------------------------------ vault */

function markdownFiles(dir) {
  const found = []
  const walk = (current) => {
    let names
    try {
      names = readdirSync(current)
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith('.')) continue
      const path = join(current, name)
      let info
      try {
        info = statSync(path)
      } catch {
        continue
      }
      if (info.isDirectory()) walk(path)
      else if (info.isFile() && name.endsWith('.md')) found.push(path)
    }
  }
  walk(dir)
  return found
}

function loadConcepts() {
  const byName = new Map()
  const byShort = new Map()
  for (const path of markdownFiles(join(root, 'Learn', 'Concepts'))) {
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

function conceptFor(value, concepts) {
  const target = linkTarget(value)
  if (target !== null) return concepts.byName.get(target) ?? null
  if (typeof value !== 'string') return null
  const text = value.trim()
  return concepts.byName.get(text) ?? concepts.byShort.get(text) ?? null
}

function styleFor(value, concepts, isFoundation, isGoal) {
  if (isFoundation) return { fill: '#e8f0fe', stroke: '#4285f4', color: '#174ea6', dash: null, label: 'foundation' }
  if (isGoal) return { fill: '#f3e8fd', stroke: '#9334e6', color: '#4a148c', dash: null, label: 'goal' }
  const concept = conceptFor(value, concepts)
  if (!concept) return { fill: '#f1f3f4', stroke: '#9aa0a6', color: '#5f6368', dash: '3 3', label: 'planned' }
  if (concept.fragile === true) return { fill: '#fce8e6', stroke: '#d93025', color: '#5c1a16', dash: '6 3', label: 'fragile' }
  if (concept.status === 'established') return { fill: '#e6f4ea', stroke: '#34a853', color: '#1e4620', dash: null, label: 'held' }
  if (concept.status === 'learning') return { fill: '#fef7e0', stroke: '#f9ab00', color: '#5c4400', dash: null, label: 'learning' }
  return { fill: '#f1f3f4', stroke: '#9aa0a6', color: '#5f6368', dash: '3 3', label: 'planned' }
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
    }
  }
  return {
    goal: { id: 'G', label: String(graph.goal ?? (Array.isArray(graph.goals) ? graph.goals[0] : '') ?? '目标') },
    foundations,
    nodes,
    edges,
  }
}

function computeLevels(graph) {
  const ids = ['G', ...graph.foundations.map((item) => item.id), ...Object.keys(graph.nodes)]
  const level = new Map()
  for (const foundation of graph.foundations) level.set(foundation.id, 0)
  let guard = 0
  let changed = true
  while (changed && guard <= ids.length + 1) {
    changed = false
    guard += 1
    for (const edge of graph.edges) {
      if (!level.has(edge.from)) continue
      const want = level.get(edge.from) + 1
      if (!level.has(edge.to) || level.get(edge.to) < want) {
        level.set(edge.to, want)
        changed = true
      }
    }
  }
  for (const id of ids) if (!level.has(id)) level.set(id, 1)
  const maxNode = Math.max(0, ...[...level.entries()].filter(([id]) => id !== 'G').map(([, value]) => value))
  const goalIncoming = graph.edges.filter((edge) => edge.to === 'G').map((edge) => level.get(edge.from) ?? 0)
  const goalLevel = Math.max(maxNode + 1, goalIncoming.length > 0 ? Math.max(...goalIncoming) + 1 : 0)
  level.set('G', goalLevel)
  return level
}

/* ------------------------------------------------------------------ SVG */

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function wrap(label, max = 13) {
  const text = String(label).replace(/\s+/g, ' ').trim()
  if (text.length <= max) return [text]
  const punctuation = '，。；、：,.;:'
  for (let cut = Math.min(max, text.length - 1); cut >= Math.floor(max / 2); cut -= 1) {
    if (punctuation.includes(text[cut])) {
      const first = text.slice(0, cut + 1)
      const rest = text.slice(cut + 1)
      return rest.length <= max ? [first, rest] : [first, `${rest.slice(0, max - 1)}…`]
    }
  }
  const first = text.slice(0, max)
  const rest = text.slice(max)
  return rest.length <= max ? [first, rest] : [first, `${rest.slice(0, max - 1)}…`]
}

function slug(text) {
  return String(text)
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'map'
}

const W = 196
const H = 52
const HGAP = 34
const VGAP = 78
const MARGIN = 36

function draw(graph, concepts) {
  const levels = computeLevels(graph)
  const ids = ['G', ...graph.foundations.map((item) => item.id), ...Object.keys(graph.nodes)]
  const byLevel = new Map()
  for (const id of ids) {
    const value = levels.get(id) ?? 0
    if (!byLevel.has(value)) byLevel.set(value, [])
    byLevel.get(value).push(id)
  }
  const levelKeys = [...byLevel.keys()].sort((a, b) => a - b)
  for (const key of levelKeys) byLevel.get(key).sort((a, b) => ids.indexOf(a) - ids.indexOf(b))

  const maxCount = Math.max(...levelKeys.map((key) => byLevel.get(key).length))
  const width = Math.max(520, maxCount * W + (maxCount - 1) * HGAP + MARGIN * 2)
  const height = levelKeys.length * H + (levelKeys.length - 1) * VGAP + MARGIN * 2

  const positions = new Map()
  for (const key of levelKeys) {
    const row = byLevel.get(key)
    const rowWidth = row.length * W + (row.length - 1) * HGAP
    const start = (width - rowWidth) / 2
    row.forEach((id, index) => {
      positions.set(id, {
        x: start + index * (W + HGAP),
        y: MARGIN + key * (H + VGAP),
      })
    })
  }

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
  const valueOf = (id) => {
    if (id === 'G') return graph.goal.label
    return graph.nodes[id] ?? ''
  }
  const isFoundation = (id) => graph.foundations.some((item) => item.id === id)
  const isGoal = (id) => id === 'G'

  const parts = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}" viewBox="0 0 ${Math.round(width)} ${Math.round(height)}" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans CJK SC', sans-serif">`)
  parts.push(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#9aa0a6"/></marker></defs>`)
  parts.push(`<rect width="100%" height="100%" fill="transparent"/>`)

  for (const edge of graph.edges) {
    const from = positions.get(edge.from)
    const to = positions.get(edge.to)
    if (!from || !to) continue
    const x1 = from.x + W / 2
    const y1 = from.y + H
    const x2 = to.x + W / 2
    const y2 = to.y
    const mid = (y1 + y2) / 2
    parts.push(`<path d="M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}" fill="none" stroke="#9aa0a6" stroke-width="1.6" marker-end="url(#arrow)"/>`)
  }

  for (const id of ids) {
    const position = positions.get(id)
    if (!position) continue
    const style = styleFor(valueOf(id), concepts, isFoundation(id), isGoal(id))
    const dash = style.dash ? ` stroke-dasharray="${style.dash}"` : ''
    parts.push(`<rect x="${position.x}" y="${position.y}" width="${W}" height="${H}" rx="12" ry="12" fill="${style.fill}" stroke="${style.stroke}" stroke-width="1.6"${dash}/>`)
    const lines = wrap(labelOf(id))
    const startY = position.y + H / 2 - (lines.length - 1) * 8
    for (let line = 0; line < lines.length; line += 1) {
      parts.push(`<text x="${position.x + W / 2}" y="${startY + line * 16}" text-anchor="middle" dominant-baseline="middle" font-size="12.5" fill="${style.color}">${escapeXml(lines[line])}</text>`)
    }
  }

  parts.push(`</svg>`)
  return parts.join('\n')
}

/* ------------------------------------------------------------------ main */

const concepts = loadConcepts()
const mapsDir = join(root, 'Learn', 'Maps')
const vizDir = join(root, 'Learn', 'Viz')
mkdirSync(vizDir, { recursive: true })

let drawn = 0
let failed = 0

for (const path of markdownFiles(mapsDir)) {
  const { data } = splitFrontmatter(readFileSync(path, 'utf8'))
  if (!data || !data.graph) continue
  const subject = String(data.subject ?? basename(path, '.md').replace(/\s*—\s*map$/i, '')).trim()
  if (onlySubject !== undefined && subject !== onlySubject) continue
  const graph = parseGraph(data)
  if (!graph || graph.foundations.length === 0 || graph.edges.length === 0) {
    console.log(`! ${basename(path)}: 没有可画的 graph（foundations/edges 为空）`)
    continue
  }
  const file = `${slug(subject)}-map.svg`
  const target = join(vizDir, file)
  try {
    writeFileSync(target, draw(graph, concepts), 'utf8')
    drawn += 1
    console.log(`✓ ${basename(path)} → Learn/Viz/${file}`)
    console.log(`  ![[${file}]]`)
  } catch (error) {
    failed += 1
    console.log(`✗ ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log(`\n${drawn} map(s) drawn${failed > 0 ? `, ${failed} failed` : ''}`)
process.exitCode = failed > 0 ? 1 : 0
