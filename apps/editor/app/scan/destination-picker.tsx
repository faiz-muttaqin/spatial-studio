'use client'

import { usePascalI18n } from '@pascal-app/core/i18n'
import type { ProjectSummary } from '@/lib/scan/attach'
import { cn } from '@/lib/utils'

export type Destination = { kind: 'new'; name: string } | { kind: 'existing'; sceneId: string }

const INPUT =
  'h-11 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary'

export function DestinationPicker({
  projects,
  destination,
  disabled,
  onChange,
}: {
  projects: readonly ProjectSummary[] | null
  destination: Destination
  disabled: boolean
  onChange: (destination: Destination) => void
}) {
  const i18n = usePascalI18n()
  const hasProjects = (projects?.length ?? 0) > 0

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
          disabled={disabled || !hasProjects}
          onClick={() => projects?.[0] && onChange({ kind: 'existing', sceneId: projects[0].id })}
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
            {projects?.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {projects === null ? (
        <p className="text-muted-foreground text-xs">
          {i18n._({ id: 'app.scan.destination.loading', message: 'Loading projects…' })}
        </p>
      ) : null}
    </div>
  )
}
