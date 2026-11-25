'use client'

import { usePascalI18n } from '@pascal-app/core/i18n'
import { useState } from 'react'
import { SECONDARY_PILL } from '@/components/app-shell'
import type { ProjectSummary } from '@/lib/scan/attach'
import { cn } from '@/lib/utils'

export type Destination = { kind: 'new'; name: string } | { kind: 'existing'; sceneId: string }

export type ProjectsState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; projects: ProjectSummary[]; truncated: boolean }

const INPUT =
  'h-11 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary'

/** Past this many projects the picker offers a name filter. */
const FILTER_THRESHOLD = 8

export function DestinationPicker({
  projects,
  destination,
  disabled,
  lockedByScan,
  onChange,
  onRetryProjects,
}: {
  projects: ProjectsState
  destination: Destination
  disabled: boolean
  /** A scan in progress was started for this destination; changing it would split the two. */
  lockedByScan: boolean
  onChange: (destination: Destination) => void
  onRetryProjects: () => void
}) {
  const i18n = usePascalI18n()
  const [filter, setFilter] = useState('')
  const list = projects.status === 'ready' ? projects.projects : []
  const query = filter.trim().toLocaleLowerCase()
  const visible = query
    ? list.filter((project) => project.name.toLocaleLowerCase().includes(query))
    : list
  // Keep the chosen project selectable even when the filter hides it.
  const chosen =
    destination.kind === 'existing'
      ? list.find((project) => project.id === destination.sceneId)
      : undefined
  const options = chosen && !visible.includes(chosen) ? [chosen, ...visible] : visible

  const option = (active: boolean) =>
    cn(
      'flex h-11 items-center justify-center rounded-lg border text-sm transition-colors',
      active ? 'border-primary bg-primary/10 font-medium' : 'border-border text-muted-foreground',
    )

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2" role="radiogroup">
        <button
          aria-checked={destination.kind === 'new'}
          className={option(destination.kind === 'new')}
          disabled={disabled}
          onClick={() => onChange({ kind: 'new', name: '' })}
          role="radio"
          type="button"
        >
          {i18n._({ id: 'app.scan.destination.new', message: 'New project' })}
        </button>
        <button
          aria-checked={destination.kind === 'existing'}
          className={option(destination.kind === 'existing')}
          disabled={disabled || list.length === 0}
          onClick={() => list[0] && onChange({ kind: 'existing', sceneId: list[0].id })}
          role="radio"
          type="button"
        >
          {i18n._({ id: 'app.scan.destination.existing', message: 'Existing project' })}
        </button>
      </div>

      {destination.kind === 'new' ? (
        <label className="block space-y-1">
          <span className="text-muted-foreground text-xs">
            {i18n._({ id: 'app.scan.destination.name', message: 'Project name' })}
          </span>
          <input
            className={INPUT}
            disabled={disabled}
            maxLength={200}
            onChange={(event) => onChange({ kind: 'new', name: event.target.value })}
            placeholder={i18n._({
              id: 'app.scan.destination.namePlaceholder',
              message: 'Named after the scan date if left empty',
            })}
            value={destination.name}
          />
        </label>
      ) : (
        <div className="space-y-2">
          {list.length > FILTER_THRESHOLD ? (
            <input
              aria-label={i18n._({ id: 'app.scan.destination.filter', message: 'Filter projects' })}
              className={INPUT}
              disabled={disabled}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={i18n._({
                id: 'app.scan.destination.filter',
                message: 'Filter projects',
              })}
              type="search"
              value={filter}
            />
          ) : null}
          <label className="block space-y-1">
            <span className="text-muted-foreground text-xs">
              {i18n._({ id: 'app.scan.destination.project', message: 'Project' })}
            </span>
            <select
              className={INPUT}
              disabled={disabled}
              onChange={(event) => onChange({ kind: 'existing', sceneId: event.target.value })}
              value={destination.sceneId}
            >
              {options.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          {query && visible.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {i18n._({ id: 'app.scan.destination.noMatch', message: 'No project matches.' })}
            </p>
          ) : null}
          {projects.status === 'ready' && projects.truncated ? (
            <p className="text-muted-foreground text-xs">
              {i18n._({
                id: 'app.scan.destination.truncated',
                message: 'Showing the {count} most recently updated projects.',
                values: { count: list.length },
              })}
            </p>
          ) : null}
        </div>
      )}

      {projects.status === 'loading' ? (
        <p className="text-muted-foreground text-xs">
          {i18n._({ id: 'app.scan.destination.loading', message: 'Loading projects…' })}
        </p>
      ) : null}
      {projects.status === 'error' ? (
        <div className="flex items-center justify-between gap-2" role="alert">
          <p className="text-red-400 text-xs">
            {i18n._({
              id: 'app.scan.destination.loadFailed',
              message: 'Could not load your projects.',
            })}
          </p>
          <button className={SECONDARY_PILL} onClick={onRetryProjects} type="button">
            {i18n._({ id: 'app.scan.destination.retry', message: 'Try again' })}
          </button>
        </div>
      ) : null}
      {lockedByScan ? (
        <p className="text-muted-foreground text-xs">
          {i18n._({
            id: 'app.scan.destination.locked',
            message: 'The destination is fixed until this scan is attached or discarded.',
          })}
        </p>
      ) : null}
    </div>
  )
}
