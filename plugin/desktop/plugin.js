import {
  Badge,
  cn,
  host,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  STATUSBAR_AREAS,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'project-attention'

/* PROJECT_ATTENTION_CORE_START */
const MISMATCH = { state: 'mismatch', count: 0, items: [] }

function normalizedPath(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

function pathContains(folder, cwd) {
  const base = normalizedPath(folder)
  const target = normalizedPath(cwd)
  return Boolean(base && target && (target === base || target.startsWith(`${base}/`)))
}

function findCurrentProject(projects, cwd) {
  if (!cwd) return null
  let best = null
  let bestLength = -1
  for (const project of projects || []) {
    if (project.archived) continue
    for (const folder of project.folders || []) {
      const candidate = normalizedPath(folder.path)
      if (pathContains(candidate, cwd) && candidate.length > bestLength) {
        best = project
        bestLength = candidate.length
      }
    }
  }
  return best
}

function projectSessionRows(projectTree) {
  const rows = []
  for (const repo of projectTree?.repos || []) {
    for (const group of repo.groups || []) {
      rows.push(...(group.sessions || []))
    }
  }
  return rows
}

function resolveStoredSessionId(activeSessions, runtimeSessionId) {
  const runtime = String(runtimeSessionId || '').trim()
  if (!runtime) return null
  const exact = (activeSessions || []).find(session => session.id === runtime)
  const stored = String(exact?.session_key || '').trim()
  return stored || null
}

function sessionBelongsToProject(projectTree, sessionId) {
  const target = String(sessionId || '').trim()
  if (!target) return false
  return projectSessionRows(projectTree).some(session => session.id === target || session._lineage_root_id === target)
}

function exactSessionId(projectTree) {
  if (Number(projectTree?.sessionCount) !== 1) return null
  const ids = [...new Set(projectSessionRows(projectTree).map(session => String(session.id || '').trim()).filter(Boolean))]
  return ids.length === 1 ? ids[0] : null
}

function buildAttentionModel({ projects, currentProjectId, snapshotsByProject, treesByProject, activeStoredSessionId }) {
  const listed = (projects || []).filter(project => !project.archived && project.board_slug)
  const currentProject = listed.find(project => project.id === currentProjectId) || null
  const currentCandidate = currentProject ? snapshotsByProject?.[currentProject.id] : null
  const currentMatches = Boolean(
    currentProject &&
      currentCandidate?.state === 'ok' &&
      sessionBelongsToProject(treesByProject?.[currentProject.id], activeStoredSessionId)
  )
  const current = currentMatches ? currentCandidate : { ...MISMATCH }
  const background = listed
    .filter(project => project.id !== currentProject?.id)
    .map(project => {
      const snapshot = snapshotsByProject?.[project.id]
      if (snapshot?.state !== 'ok' || Number(snapshot.count) <= 0) return null
      return {
        id: project.id,
        name: project.name || 'Unnamed Project',
        count: Number(snapshot.count),
        summary: String(snapshot.items?.[0]?.useful_summary || ''),
        sessionId: exactSessionId(treesByProject?.[project.id])
      }
    })
    .filter(Boolean)
  const totalCount = Number(current.count || 0) + background.reduce((sum, project) => sum + project.count, 0)
  return { current, currentProject, currentMatches, background, totalCount }
}

function indicatorVisible(model) {
  return Number(model?.totalCount) > 0
}

async function revealMatchedFolder(ctx, matchedFolder, notify) {
  try {
    if (await ctx.os.revealPath(matchedFolder)) return true
  } catch {
    // The public reveal API can reject when the path cannot be shown.
  }
  notify('Could not show the matched folder in File Explorer.')
  return false
}
/* PROJECT_ATTENTION_CORE_END */

function preferredFolder(project) {
  return (
    project?.primary_path ||
    project?.folders?.find(folder => folder.is_primary)?.path ||
    project?.folders?.[0]?.path ||
    ''
  )
}

async function loadProjectSnapshot(ctx, project, cwd) {
  if (!project?.id || !project.board_slug || !cwd) return { ...MISMATCH }
  const query = new URLSearchParams({ project_id: project.id, board: project.board_slug, cwd })
  try {
    return await ctx.rest(`/attention?${query.toString()}`)
  } catch {
    return { ...MISMATCH }
  }
}

async function loadProjectTree(projectId) {
  try {
    const payload = await host.request('projects.project_sessions', { project_id: projectId })
    return payload?.project || null
  } catch {
    return null
  }
}

async function loadStoredSessionId(runtimeSessionId) {
  if (!runtimeSessionId) return null
  try {
    const payload = await host.request('session.active_list', { current_session_id: runtimeSessionId })
    return resolveStoredSessionId(payload?.sessions, runtimeSessionId)
  } catch {
    return null
  }
}

async function loadAttention(ctx, cwd, runtimeSessionId) {
  const payload = await host.request('projects.list')
  const projects = (payload?.projects || []).filter(project => !project.archived && project.board_slug)
  const currentProject = findCurrentProject(projects, cwd)
  const snapshotPairs = await Promise.all(
    projects.map(async project => [
      project.id,
      await loadProjectSnapshot(ctx, project, project.id === currentProject?.id ? cwd : preferredFolder(project))
    ])
  )
  const snapshotsByProject = Object.fromEntries(snapshotPairs)
  const mappedProjects = projects.filter(
    project => project.id === currentProject?.id || Number(snapshotsByProject[project.id]?.count) > 0
  )
  const [activeStoredSessionId, treePairs] = await Promise.all([
    loadStoredSessionId(runtimeSessionId),
    Promise.all(mappedProjects.map(async project => [project.id, await loadProjectTree(project.id)]))
  ])
  return buildAttentionModel({
    projects,
    currentProjectId: currentProject?.id || null,
    snapshotsByProject,
    treesByProject: Object.fromEntries(treePairs),
    activeStoredSessionId
  })
}

function MetadataRow({ label, value }) {
  return jsxs('div', {
    className: 'grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2 text-xs',
    children: [
      jsx('span', { className: 'text-(--ui-text-quaternary)', children: label }),
      jsx('span', { className: 'truncate text-(--ui-text-secondary)', title: value, children: value })
    ]
  })
}

function FolderMetadataRow({ ctx, snapshot }) {
  return jsxs('div', {
    className: 'grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2 text-xs',
    children: [
      jsx('span', { className: 'text-(--ui-text-quaternary)', children: 'Folder match' }),
      jsx('button', {
        'aria-label': 'Show matched folder in File Explorer',
        className: 'w-full min-w-0 truncate rounded-sm text-left text-(--ui-text-secondary) underline decoration-(--ui-stroke-secondary) underline-offset-2 transition-colors hover:text-(--ui-text-primary) focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--ui-accent)',
        onClick: () => revealMatchedFolder(ctx, snapshot.matched_folder, message => host.notify({ kind: 'error', message })),
        title: snapshot.matched_folder,
        type: 'button',
        children: snapshot.matched_folder
      })
    ]
  })
}

function AttentionItem({ item }) {
  return jsxs('div', {
    className: 'flex flex-col gap-1 border-b border-(--ui-stroke-secondary) py-2 last:border-b-0',
    children: [
      jsxs('div', {
        className: 'flex items-start justify-between gap-2',
        children: [
          jsx('span', { className: 'min-w-0 text-sm font-medium', children: item.title }),
          jsx(Badge, { variant: item.status === 'blocked' ? 'warn' : 'muted', children: item.status })
        ]
      }),
      jsx('div', { className: 'text-xs leading-relaxed text-(--ui-text-tertiary)', children: item.useful_summary }),
      jsx('div', { className: 'font-mono text-[0.625rem] text-(--ui-text-quaternary)', children: item.id })
    ]
  })
}

function BackgroundProjectRow({ project }) {
  const content = jsxs('span', {
    className: 'flex min-w-0 flex-1 items-start justify-between gap-3',
    children: [
      jsxs('span', {
        className: 'min-w-0',
        children: [
          jsx('span', { className: 'block truncate text-xs font-medium text-(--ui-text-secondary)', children: project.name }),
          project.summary
            ? jsx('span', { className: 'block truncate text-[0.6875rem] text-(--ui-text-quaternary)', children: project.summary })
            : null
        ]
      }),
      jsx('span', { className: 'shrink-0 text-xs tabular-nums text-(--ui-text-tertiary)', children: project.count })
    ]
  })
  return project.sessionId ?
    jsx('button', {
      'aria-label': `Open ${project.name}`,
      className: 'flex w-full rounded-sm px-1 py-1.5 text-left transition-colors hover:bg-(--chrome-action-hover) focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--ui-accent)',
      onClick: () => host.openSession(project.sessionId),
      type: 'button',
      children: content
    }) :
    jsx('div', { className: 'flex w-full px-1 py-1.5', children: content })
}

function CurrentProjectSection({ ctx, model }) {
  if (!model.currentMatches) {
    return jsxs('div', {
      className: 'flex flex-col gap-1 p-3',
      children: [
        jsx('span', { className: 'text-xs font-medium text-(--ui-text-secondary)', children: 'Current Project' }),
        jsx('span', { className: 'text-xs text-(--ui-text-quaternary)', children: 'No exact active-session Project match.' })
      ]
    })
  }

  const snapshot = model.current
  return jsxs('div', {
    children: [
      jsxs('div', {
        className: 'flex flex-col gap-2 border-b border-(--ui-stroke-secondary) p-3',
        children: [
          jsx(MetadataRow, { label: 'Project', value: snapshot.project.name }),
          jsx(FolderMetadataRow, { ctx, snapshot }),
          jsx(MetadataRow, { label: 'Board', value: snapshot.board.slug })
        ]
      }),
      Number(snapshot.count) > 0
        ? jsx(ScrollArea, {
            className: 'max-h-64 px-3',
            children: snapshot.items.map(item => jsx(AttentionItem, { item }, item.id))
          })
        : jsx('div', {
            className: 'px-3 py-4 text-xs text-(--ui-text-quaternary)',
            children: 'No blocked or review cards in the current Project.'
          })
    ]
  })
}

function OtherProjectsSection({ projects }) {
  return jsxs('div', {
    className: 'border-t border-(--ui-stroke-secondary) p-3',
    children: [
      jsx('div', { className: 'mb-1 text-[0.6875rem] font-medium text-(--ui-text-tertiary)', children: 'Other Project attention' }),
      projects.length
        ? jsx('div', { className: 'flex flex-col', children: projects.map(project => jsx(BackgroundProjectRow, { project }, project.id)) })
        : jsx('div', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)', children: 'No other Projects need attention.' })
    ]
  })
}

function AttentionStatus({ ctx }) {
  const cwd = useValue(host.state.cwd)
  const sessionId = useValue(host.state.activeSessionId)
  const profile = useValue(host.state.profile)
  const gateway = useValue(host.state.gateway)
  const { data: model } = useQuery({
    enabled: gateway === 'open',
    queryKey: [ID, 'attention-v2', profile, sessionId, cwd],
    queryFn: () => loadAttention(ctx, cwd, sessionId),
    refetchInterval: 15_000,
    retry: false
  })

  if (!indicatorVisible(model)) return null

  return jsxs(Popover, {
    children: [
      jsx(PopoverTrigger, {
        asChild: true,
        children: jsxs('button', {
          'aria-label': `${model.totalCount} Project attention item${model.totalCount === 1 ? '' : 's'}`,
          className: cn(
            'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] font-medium tabular-nums text-(--ui-text-secondary)',
            'transition-colors hover:bg-(--chrome-action-hover)'
          ),
          type: 'button',
          children: [
            jsx('span', { 'aria-hidden': true, className: 'size-1.5 rounded-full bg-(--ui-yellow) opacity-60' }),
            jsx('span', { children: model.totalCount })
          ]
        })
      }),
      jsxs(PopoverContent, {
        align: 'end',
        className: 'w-[min(26rem,calc(100vw-1rem))] p-0',
        sideOffset: 6,
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between gap-3 border-b border-(--ui-stroke-secondary) p-3',
            children: [
              jsx('span', { className: 'font-medium', children: 'Project Attention' }),
              jsx('span', { className: 'text-xs tabular-nums text-(--ui-text-tertiary)', children: `${model.totalCount} actionable` })
            ]
          }),
          jsx(CurrentProjectSection, { ctx, model }),
          jsx(OtherProjectsSection, { projects: model.background })
        ]
      })
    ]
  })
}

export default {
  id: ID,
  name: 'Project Attention',
  description: 'Read-only attention for native Projects and their bound Kanban boards.',
  defaultEnabled: false,
  register(ctx) {
    ctx.register({
      id: 'status',
      area: STATUSBAR_AREAS.right,
      order: 75,
      render: () => jsx(AttentionStatus, { ctx })
    })
  }
}
