import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..', 'plugin')
const pluginPath = path.join(pluginRoot, 'desktop', 'plugin.js')
const manifestPath = path.join(pluginRoot, 'dashboard', 'manifest.json')
const pluginYamlPath = path.join(pluginRoot, 'plugin.yaml')

function loadCore() {
  const source = fs.readFileSync(pluginPath, 'utf8')
  const match = source.match(/\/\* PROJECT_ATTENTION_CORE_START \*\/([\s\S]*?)\/\* PROJECT_ATTENTION_CORE_END \*\//)
  assert.ok(match, 'plugin exposes the bounded pure core block')
  const context = { URLSearchParams }
  vm.createContext(context)
  vm.runInContext(
    `${match[1]}\nthis.core = { indicatorVisible, exactSessionId, buildAttentionModel, revealMatchedFolder }`,
    context
  )
  return { source, ...context.core }
}

const projects = [
  { id: 'p_alpha', name: 'Alpha Project', board_slug: 'alpha-board', folders: [{ path: 'C:/work/alpha', is_primary: true }] },
  { id: 'p_beta', name: 'Beta Project', board_slug: 'beta-board', folders: [{ path: 'C:/work/beta', is_primary: true }] },
  { id: 'p_archived', name: 'Archived Project', board_slug: 'archived-board', archived: true, folders: [{ path: 'C:/work/archived' }] },
  { id: 'p_unbound', name: 'Unbound Project', folders: [{ path: 'C:/work/unbound' }] }
]

const tree = (...sessions) => ({
  repos: [{ groups: [{ sessions }] }],
  sessionCount: sessions.length
})

const snapshot = (project, items = []) => ({
  state: 'ok',
  count: items.length,
  project: { id: project.id, name: project.name },
  board: { slug: project.board_slug },
  matched_folder: project.folders[0].path,
  items
})

function model({ alphaItems = [], betaItems = [], alphaSnapshot, betaSnapshot, alphaTree = tree({ id: 's_alpha' }), betaTree = tree({ id: 's_beta' }) } = {}) {
  const { buildAttentionModel } = loadCore()
  return buildAttentionModel({
    projects,
    snapshotsByProject: {
      p_alpha: alphaSnapshot ?? snapshot(projects[0], alphaItems),
      p_beta: betaSnapshot ?? snapshot(projects[1], betaItems),
      p_archived: snapshot(projects[2], [{ id: 't_archived' }]),
      p_unbound: { state: 'ok', count: 1, items: [{ id: 't_unbound' }] }
    },
    treesByProject: { p_alpha: alphaTree, p_beta: betaTree }
  })
}

test('zero attention anywhere renders no status item', () => {
  const { indicatorVisible } = loadCore()
  const view = model()
  assert.equal(view.totalCount, 0)
  assert.deepEqual(Array.from(view.projects), [])
  assert.equal(indicatorVisible(view), false)
})

test('all-attention model includes every actionable Project without a current/background partition', () => {
  const view = model({
    alphaItems: [{ id: 't_alpha', useful_summary: 'First reason' }],
    betaItems: [{ id: 't_beta', useful_summary: 'Second reason' }]
  })

  assert.deepEqual(Array.from(view.projects, project => project.name), ['Alpha Project', 'Beta Project'])
  assert.equal(view.projects[0].snapshot.items[0].id, 't_alpha')
  assert.equal(view.projects[1].snapshot.items[0].id, 't_beta')
  assert.equal(view.totalCount, 2)
  assert.equal('current' in view, false)
  assert.equal('background' in view, false)
})

test('zero, archived, unbound, and failed snapshots are omitted', () => {
  const view = model({
    alphaItems: [],
    betaSnapshot: { state: 'mismatch', count: 9, items: [{ id: 'must-not-render' }] }
  })
  assert.deepEqual(Array.from(view.projects), [])
  assert.equal(JSON.stringify(view).includes('must-not-render'), false)
})

test('total count sums actionable cards across included Projects', () => {
  const view = model({
    alphaItems: [{ id: 'a1' }, { id: 'a2' }],
    betaItems: [{ id: 'b1' }]
  })
  assert.equal(view.totalCount, 3)
  assert.equal(view.projects[0].count, 2)
  assert.equal(view.projects[1].count, 1)
})

test('Project navigation resolves only a unique authoritative stored session ID', () => {
  const { exactSessionId } = loadCore()
  assert.equal(exactSessionId(tree({ id: 's_only', title: 'Rename-safe' })), 's_only')
  assert.equal(exactSessionId(tree({ id: 's_one' }, { id: 's_two' })), null)
  assert.equal(exactSessionId(null), null)
})

test('model keeps navigation fail-closed when a Project has multiple sessions', () => {
  const view = model({
    alphaItems: [{ id: 'a1' }],
    alphaTree: tree({ id: 's_one' }, { id: 's_two' })
  })
  assert.equal(view.projects[0].sessionId, null)
})

test('status indicator uses the supported warning dot component', () => {
  const { source } = loadCore()
  assert.match(source, /\bStatusDot\b/)
  assert.match(source, /jsx\(StatusDot,\s*\{[^}]*tone:\s*['"]warn['"]/s)
  assert.doesNotMatch(source, /bg-\(--ui-yellow\)/)
})

test('UI makes no unsupported current or background Project claim', () => {
  const { source } = loadCore()
  assert.doesNotMatch(source, /Current Project|Other Project attention|No exact active-session Project match/i)
  assert.doesNotMatch(source, /payload\?\.active_id|host\.state\.(activeSessionId|cwd)/)
  assert.match(source, /model\.projects\.map\(project => jsx\(ProjectAttentionSection/)
  assert.doesNotMatch(source, /Open Kanban|host\.navigate\(['"]\/kanban|generic Kanban|last-selected board/i)
  assert.doesNotMatch(source, /name:\s*['"]warning['"]|⚠|border-\(--ui-yellow\)/i)
})

test('matched folder control reveals only the exact folder after explicit click', async () => {
  const { source, revealMatchedFolder } = loadCore()
  assert.match(source, /['"]aria-label['"]:\s*['"]Show matched folder in File Explorer['"]/)
  assert.match(source, /onClick:\s*\(\)\s*=>\s*revealMatchedFolder\(ctx,\s*snapshot\.matched_folder/)
  assert.doesNotMatch(source, /window\.hermesDesktop|child_process|shell\.|openExternal|host\.navigate\([^\n]*matched_folder/)

  const calls = []
  const ctx = { os: { revealPath: async value => { calls.push(['revealPath', value]); return true } } }
  const result = await revealMatchedFolder(ctx, 'C:/work/alpha', message => calls.push(['notify', message]))

  assert.equal(result, true)
  assert.deepEqual(calls, [['revealPath', 'C:/work/alpha']])
})

test('failed folder reveal reports an error without crashing or mutating state', async () => {
  const { revealMatchedFolder } = loadCore()
  const frozen = Object.freeze({ matched_folder: 'C:/work/alpha', count: 1 })
  const before = JSON.stringify(frozen)

  for (const revealPath of [async () => false, async () => { throw new Error('blocked') }]) {
    const notices = []
    const result = await revealMatchedFolder({ os: { revealPath } }, frozen.matched_folder, message => notices.push(message))
    assert.equal(result, false)
    assert.deepEqual(notices, ['Could not show the matched folder in File Explorer.'])
    assert.equal(JSON.stringify(frozen), before)
  }
})

test('Project heading opens only its exact supported session mapping', () => {
  const { source } = loadCore()
  assert.match(source, /host\.openSession\(project\.sessionId\)/)
  assert.match(source, /project\.sessionId\s*\n\s*\?/)
  assert.doesNotMatch(source, /host\.openSession\([^\n]*(title|name)/)
})

test('package metadata identifies the v0.2.3 release consistently', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const pluginYaml = fs.readFileSync(pluginYamlPath, 'utf8')
  assert.equal(manifest.version, '0.2.3')
  assert.match(pluginYaml, /^version:\s*0\.2\.3$/m)
})

test('package metadata avoids an alarm-style warning triangle', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  assert.notEqual(manifest.icon, 'AlertTriangle')
})

test('disk plugin imports only supported public modules and no hardcoded palette', () => {
  const { source } = loadCore()
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1])
  assert.deepEqual([...new Set(imports)].sort(), ['@hermes/plugin-sdk', 'react/jsx-runtime'])
  assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b|\brgb\s*\(|\bblack\b|\bwhite\b/i)
})
