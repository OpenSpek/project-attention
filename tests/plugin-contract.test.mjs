import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.join(here, '..')
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
    `${match[1]}\nthis.core = { findCurrentProject, indicatorVisible, sessionBelongsToProject, exactSessionId, resolveStoredSessionId, buildAttentionModel, revealMatchedFolder: typeof revealMatchedFolder === 'function' ? revealMatchedFolder : undefined }`,
    context
  )
  return { source, ...context.core }
}

const projects = [
  { id: 'p_current', name: 'Current Project', board_slug: 'current-board', folders: [{ path: 'C:/work/current', is_primary: true }] },
  { id: 'p_other', name: 'Other Project', board_slug: 'other-board', folders: [{ path: 'C:/work/other', is_primary: true }] }
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

function model({ currentItems = [], otherItems = [], activeStoredSessionId = 's_current', currentTree = tree({ id: 's_current' }), otherTree = tree({ id: 's_other' }) } = {}) {
  const { buildAttentionModel } = loadCore()
  return buildAttentionModel({
    projects,
    currentProjectId: 'p_current',
    snapshotsByProject: {
      p_current: snapshot(projects[0], currentItems),
      p_other: snapshot(projects[1], otherItems)
    },
    treesByProject: { p_current: currentTree, p_other: otherTree },
    activeStoredSessionId
  })
}

test('zero attention anywhere renders no status item', () => {
  const { indicatorVisible } = loadCore()
  const view = model()
  assert.equal(view.totalCount, 0)
  assert.equal(indicatorVisible(view), false)
})

test('current-only attention keeps current details primary', () => {
  const { indicatorVisible } = loadCore()
  const view = model({ currentItems: [{ id: 't_current', useful_summary: 'Needs operator' }] })
  assert.equal(view.totalCount, 1)
  assert.equal(view.current.count, 1)
  assert.deepEqual(view.background, [])
  assert.equal(indicatorVisible(view), true)
})

test('background-only attention appears as a concise Project footer signal without card leakage', () => {
  const view = model({ otherItems: [{ id: 't_other', useful_summary: 'Waiting for review' }, { id: 't_other_2', useful_summary: 'Must stay hidden' }] })
  assert.equal(view.totalCount, 2)
  assert.equal(view.current.count, 0)
  assert.equal(view.background.length, 1)
  assert.equal(view.background[0].name, 'Other Project')
  assert.equal(view.background[0].count, 2)
  assert.equal(view.background[0].summary, 'Waiting for review')
  assert.equal('items' in view.background[0], false)
  assert.doesNotMatch(JSON.stringify(view.background[0]), /t_other_2|Must stay hidden/)
})

test('current and background attention are partitioned while the compact count is total actionable cards', () => {
  const view = model({
    currentItems: [{ id: 't_current', useful_summary: 'Current reason' }],
    otherItems: [{ id: 't_other', useful_summary: 'Other reason' }]
  })
  assert.equal(view.totalCount, 2)
  assert.equal(view.current.count, 1)
  assert.equal(view.background[0].count, 1)
})

test('detached or mismatched active session fails closed for current Project data', () => {
  const view = model({
    currentItems: [{ id: 't_current', useful_summary: 'Must not leak' }],
    activeStoredSessionId: 's_detached'
  })
  assert.equal(view.current.state, 'mismatch')
  assert.equal(view.current.count, 0)
  assert.equal(JSON.stringify(view.current).includes('Must not leak'), false)
})

test('runtime active-session identity resolves to the exact public stored-session key', () => {
  const { resolveStoredSessionId } = loadCore()
  const active = [
    { id: 'runtime-a', session_key: 'stored-a', title: 'Renamed title' },
    { id: 'runtime-b', session_key: 'stored-b', title: 'Another title' }
  ]
  assert.equal(resolveStoredSessionId(active, 'runtime-b'), 'stored-b')
  assert.equal(resolveStoredSessionId(active, 'stored-b'), null)
  assert.equal(resolveStoredSessionId(active, 'Another title'), null)
})

test('session membership uses exact stored identity or authoritative lineage root, never title', () => {
  const { sessionBelongsToProject } = loadCore()
  const projectTree = tree({ id: 's_tip', _lineage_root_id: 's_root', title: 'Renamed freely' })
  assert.equal(sessionBelongsToProject(projectTree, 's_tip'), true)
  assert.equal(sessionBelongsToProject(projectTree, 's_root'), true)
  assert.equal(sessionBelongsToProject(projectTree, 'Renamed freely'), false)
})

test('exact background navigation resolves only a unique authoritative stored session ID', () => {
  const { exactSessionId } = loadCore()
  assert.equal(exactSessionId(tree({ id: 's_only' })), 's_only')
  assert.equal(exactSessionId(tree({ id: 's_one' }, { id: 's_two' })), null)
  assert.equal(exactSessionId(null), null)
})

test('current Project uses the longest exact folder boundary match', () => {
  const { findCurrentProject } = loadCore()
  const candidates = [
    { id: 'parent', board_slug: 'parent-board', folders: [{ path: 'C:/work' }] },
    { id: 'alpha', board_slug: 'alpha-board', folders: [{ path: 'C:/work/alpha' }] }
  ]
  assert.equal(findCurrentProject(candidates, 'C:/work/alpha/sub').id, 'alpha')
  assert.equal(findCurrentProject(candidates, 'C:/work/alphabet').id, 'parent')
  assert.equal(findCurrentProject([{ id: 'alpha', folders: [{ path: 'C:/work/alpha' }] }], 'C:/work/alphabet'), null)
  assert.equal(findCurrentProject(candidates, ''), null)
})

test('routine matched view omits session success copy while preserving the mismatch exception', () => {
  const { source } = loadCore()
  assert.doesNotMatch(source, /Current active session/)
  assert.match(source, /No exact active-session Project match\./)
  assert.doesNotMatch(source, /MetadataRow,\s*\{\s*label:\s*['"]Session['"]/)
  assert.doesNotMatch(source, /Open Kanban|host\.navigate\(['"]\/kanban|generic Kanban|last-selected board/i)
  assert.doesNotMatch(source, /name:\s*['"]warning['"]|⚠|border-\(--ui-yellow\)/i)
})

test('matched folder control reveals only the exact folder after explicit click', async () => {
  const { source, revealMatchedFolder } = loadCore()
  assert.equal(typeof revealMatchedFolder, 'function')
  assert.match(source, /['"]aria-label['"]:\s*['"]Show matched folder in File Explorer['"]/)
  assert.match(source, /onClick:\s*\(\)\s*=>\s*revealMatchedFolder\(ctx,\s*snapshot\.matched_folder/)
  assert.doesNotMatch(source, /window\.hermesDesktop|child_process|shell\.|openExternal|host\.navigate\([^\n]*matched_folder/)

  const calls = []
  const ctx = { os: { revealPath: async value => { calls.push(['revealPath', value]); return true } } }
  const notify = message => calls.push(['notify', message])
  const result = await revealMatchedFolder(ctx, 'C:/work/current', notify)

  assert.equal(result, true)
  assert.deepEqual(calls, [['revealPath', 'C:/work/current']])
})

test('failed folder reveal reports an error without crashing or mutating state', async () => {
  const { revealMatchedFolder } = loadCore()
  assert.equal(typeof revealMatchedFolder, 'function')
  const snapshot = Object.freeze({ matched_folder: 'C:/work/current', count: 1 })
  const before = JSON.stringify(snapshot)

  for (const revealPath of [async () => false, async () => { throw new Error('blocked') }]) {
    const notices = []
    const result = await revealMatchedFolder({ os: { revealPath } }, snapshot.matched_folder, message => notices.push(message))
    assert.equal(result, false)
    assert.deepEqual(notices, ['Could not show the matched folder in File Explorer.'])
    assert.equal(JSON.stringify(snapshot), before)
  }
})

test('background row opens only its exact supported session mapping', () => {
  const { source } = loadCore()
  assert.match(source, /host\.openSession\(project\.sessionId\)/)
  assert.match(source, /project\.sessionId\s*\?/)
  assert.doesNotMatch(source, /host\.openSession\([^\n]*(title|name)/)
})

test('package metadata identifies the v2.1 candidate consistently', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const pluginYaml = fs.readFileSync(pluginYamlPath, 'utf8')
  assert.equal(manifest.version, '0.2.1')
  assert.match(pluginYaml, /^version:\s*0\.2\.1$/m)
})

test('package metadata also avoids an alarm-style warning triangle', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  assert.notEqual(manifest.icon, 'AlertTriangle')
})

test('disk plugin imports only supported public modules and no hardcoded palette', () => {
  const { source } = loadCore()
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1])
  assert.deepEqual([...new Set(imports)].sort(), ['@hermes/plugin-sdk', 'react/jsx-runtime'])
  assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b|\brgb\s*\(|\bblack\b|\bwhite\b/i)
})
