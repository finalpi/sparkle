export type ConnectionGroupSort =
  'name' | 'count' | 'upload' | 'download' | 'uploadSpeed' | 'downloadSpeed'

export interface ConnectionGroup {
  key: string
  label: string
  process: string
  processPath: string
  sourceIP: string
  count: number
  upload: number
  download: number
  uploadSpeed: number
  downloadSpeed: number
  connections: ControllerConnectionDetail[]
}

export type ConnectionGroupSummary = Omit<
  ConnectionGroup,
  'uploadSpeed' | 'downloadSpeed' | 'connections'
>

export function groupKey(conn: ControllerConnectionDetail): string {
  const process = conn.metadata.process || ''
  return process !== '' ? process : conn.metadata.sourceIP || ''
}

export function buildConnectionGroups(
  connections: ControllerConnectionDetail[],
  sort: ConnectionGroupSort,
  asc: boolean,
  summaries: ConnectionGroupSummary[] = []
): ConnectionGroup[] {
  const groups = new Map<string, ConnectionGroup>()

  for (const summary of summaries) {
    groups.set(summary.key, {
      ...summary,
      uploadSpeed: 0,
      downloadSpeed: 0,
      connections: []
    })
  }

  for (const conn of connections) {
    const key = groupKey(conn)
    const process = conn.metadata.process || ''
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        label: process !== '' ? process : conn.metadata.sourceIP || '',
        process,
        processPath: conn.metadata.processPath || '',
        sourceIP: conn.metadata.sourceIP || '',
        count: 0,
        upload: 0,
        download: 0,
        uploadSpeed: 0,
        downloadSpeed: 0,
        connections: []
      }
      groups.set(key, group)
    }

    group.count += 1
    group.upload += conn.upload || 0
    group.download += conn.download || 0
    group.uploadSpeed += conn.uploadSpeed || 0
    group.downloadSpeed += conn.downloadSpeed || 0
    group.connections.push(conn)
    if (!group.processPath && conn.metadata.processPath) {
      group.processPath = conn.metadata.processPath
    }
  }

  const rows = Array.from(groups.values())
  sortGroups(rows, sort, asc)
  return rows
}

export function summarizeConnectionGroups(
  connections: ControllerConnectionDetail[]
): ConnectionGroupSummary[] {
  return buildConnectionGroups(connections, 'name', true).map(
    ({
      uploadSpeed: _uploadSpeed,
      downloadSpeed: _downloadSpeed,
      connections: _connections,
      ...group
    }) => group
  )
}

export function mergeConnectionGroupSummaries(
  current: ConnectionGroupSummary[],
  additions: ConnectionGroupSummary[]
): ConnectionGroupSummary[] {
  const merged = new Map(current.map((summary) => [summary.key, { ...summary }]))

  for (const addition of additions) {
    const existing = merged.get(addition.key)
    if (!existing) {
      merged.set(addition.key, { ...addition })
      continue
    }

    existing.count += addition.count
    existing.upload += addition.upload
    existing.download += addition.download
    if (!existing.processPath && addition.processPath) existing.processPath = addition.processPath
  }

  return Array.from(merged.values())
}

function sortGroups(rows: ConnectionGroup[], sort: ConnectionGroupSort, asc: boolean): void {
  const dir = asc ? 1 : -1
  let comparator: (a: ConnectionGroup, b: ConnectionGroup) => number
  switch (sort) {
    case 'count':
      comparator = (a, b) => (a.count - b.count) * dir
      break
    case 'upload':
      comparator = (a, b) => (a.upload - b.upload) * dir
      break
    case 'download':
      comparator = (a, b) => (a.download - b.download) * dir
      break
    case 'uploadSpeed':
      comparator = (a, b) => (a.uploadSpeed - b.uploadSpeed) * dir
      break
    case 'downloadSpeed':
      comparator = (a, b) => (a.downloadSpeed - b.downloadSpeed) * dir
      break
    case 'name':
    default:
      comparator = (a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()) * dir
      break
  }
  rows.sort(comparator)
}
