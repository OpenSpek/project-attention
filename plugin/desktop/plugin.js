import {
  Badge,
  cn,
  host,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  StatusDot,
  STATUSBAR_AREAS,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'project-attention'

/* PROJECT_ATTENTION_CORE_START */
const MISMATCH = { state: 'mismatch', count: 0, items: [] }

function projectSessionRows(projectTree) {
  const rows = []
  for (const repo of projectTree?.repos || []) {
    for (const group of repo.groups || []) {
      rows.push(...(group.sessions || []))
    }
  }
  return rows
}

function exactSessionId(projectTree) {
  if (Number(projectTree?.sessionCount) !== 1) return null
  const ids = [...new Set(projectSessionRows(projectTree).map(session => String(session.id || '').trim()).filter(Boolean))]
  return ids.length === 1 ? ids[0] : null
}

function buildAttentionModel({ projects, snapshotsByProject, treesByProject }) {
  const listed = (projects || []).filter(project => !project.archived && project.board_slug)
  const attentionProjects = listed
    .map(project => {
      const snapshot = snapshotsByProject?.[project.id]
      if (snapshot?.state !== 'ok' || Number(snapshot.count) <= 0) return null
      return {
        id: project.id,
        name: project.name || 'Unnamed Project',
        count: Number(snapshot.count),
        snapshot,
        sessionId: exactSessionId(treesByProject?.[project.id])
      }
    })
    .filter(Boolean)
  const totalCount = attentionProjects.reduce((sum, project) => sum + project.count, 0)
  return { projects: attentionProjects, totalCount }
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

async function loadAttention(ctx) {
  const payload = await host.request('projects.list')
  const projects = (payload?.projects || []).filter(project => !project.archived && project.board_slug)
  const snapshotPairs = await Promise.all(
    projects.map(async project => [project.id, await loadProjectSnapshot(ctx, project, preferredFolder(project))])
  )
  const snapshotsByProject = Object.fromEntries(snapshotPairs)
  const actionableProjects = projects.filter(project => Number(snapshotsByProject[project.id]?.count) > 0)
  const treePairs = await Promise.all(actionableProjects.map(async project => [project.id, await loadProjectTree(project.id)]))
  return buildAttentionModel({
    projects,
    snapshotsByProject,
    treesByProject: Object.fromEntries(treePairs)
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

function ProjectHeading({ project }) {
  const content = jsxs('span', {
    className: 'flex min-w-0 flex-1 items-center justify-between gap-3',
    children: [
      jsx('span', { className: 'truncate text-sm font-medium text-(--ui-text-secondary)', children: project.name }),
      jsx('span', { className: 'shrink-0 text-xs tabular-nums text-(--ui-text-tertiary)', children: project.count })
    ]
  })
  return project.sessionId
    ? jsx('button', {
        'aria-label': `Open ${project.name}`,
        className: 'flex w-full rounded-sm text-left transition-colors hover:text-(--ui-text-primary) focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--ui-accent)',
        onClick: () => host.openSession(project.sessionId),
        type: 'button',
        children: content
      })
    : jsx('div', { className: 'flex w-full', children: content })
}

function ProjectAttentionSection({ ctx, project }) {
  const snapshot = project.snapshot
  return jsxs('section', {
    className: 'border-b border-(--ui-stroke-secondary) last:border-b-0',
    children: [
      jsxs('div', {
        className: 'flex flex-col gap-2 p-3',
        children: [
          jsx(ProjectHeading, { project }),
          jsx(FolderMetadataRow, { ctx, snapshot }),
          jsx(MetadataRow, { label: 'Board', value: snapshot.board.slug })
        ]
      }),
      jsx('div', {
        className: 'border-t border-(--ui-stroke-secondary) px-3',
        children: snapshot.items.map(item => jsx(AttentionItem, { item }, item.id))
      })
    ]
  })
}

function AttentionStatus({ ctx }) {
  const profile = useValue(host.state.profile)
  const gateway = useValue(host.state.gateway)
  const { data: model } = useQuery({
    enabled: gateway === 'open',
    queryKey: [ID, 'attention-v4', profile],
    queryFn: () => loadAttention(ctx),
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
            jsx(StatusDot, { 'aria-hidden': true, className: 'scale-75 opacity-60', tone: 'warn' }),
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
          jsx(ScrollArea, {
            className: 'max-h-64',
            children: model.projects.map(project => jsx(ProjectAttentionSection, { ctx, project }, project.id))
          })
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
