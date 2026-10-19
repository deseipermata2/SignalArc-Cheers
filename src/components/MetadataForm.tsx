/**
 * MetadataForm — optional title, description, and funding target for gift creation.
 *
 * Title is required (1–100 chars); description and target are optional.
 * The target is visual only and never gates payment — shown with a clear label.
 * This component only collects the draft; saving happens after on-chain confirmation.
 */

import { parseContributionAmount } from '../lib/cheers-contract'

export interface GiftMetaFields {
  title: string
  description: string
  targetInput: string   // raw user input string
}

export interface GiftMetaErrors {
  title: string | null
  description: string | null
  target: string | null
}

interface MetadataFormProps {
  fields: GiftMetaFields
  errors: GiftMetaErrors
  onChange: (fields: GiftMetaFields) => void
  onErrorChange: (errors: GiftMetaErrors) => void
}

function FieldLabel({ children, optional }: { children: React.ReactNode; optional?: boolean }) {
  return (
    <p className="text-sm font-semibold mb-2 flex items-center gap-2" style={{ color: 'var(--ink-2)' }}>
      {children}
      {optional && (
        <span className="text-xs font-normal" style={{ color: 'var(--subtle)' }}>Optional</span>
      )}
    </p>
  )
}

export function MetadataForm({ fields, errors, onChange, onErrorChange }: MetadataFormProps) {
  function handleTitle(val: string) {
    onChange({ ...fields, title: val })
    if (!val.trim()) onErrorChange({ ...errors, title: 'Title is required.' })
    else if (val.trim().length > 100) onErrorChange({ ...errors, title: 'Title must be 100 characters or fewer.' })
    else onErrorChange({ ...errors, title: null })
  }

  function handleDescription(val: string) {
    onChange({ ...fields, description: val })
    if (val.length > 500) onErrorChange({ ...errors, description: 'Description must be 500 characters or fewer.' })
    else onErrorChange({ ...errors, description: null })
  }

  function handleTarget(val: string) {
    onChange({ ...fields, targetInput: val })
    if (!val.trim()) {
      onErrorChange({ ...errors, target: null })
      return
    }
    const result = parseContributionAmount(val)
    if (!result.ok) onErrorChange({ ...errors, target: result.error })
    else onErrorChange({ ...errors, target: null })
  }

  const inputStyle = (hasError: boolean) => ({
    background: 'var(--surface-muted)',
    border: `1px solid ${hasError ? 'var(--danger)' : 'var(--border-strong)'}`,
    color: 'var(--ink)',
    caretColor: 'var(--accent)',
  })

  return (
    <div className="space-y-4">
      {/* Title */}
      <div>
        <FieldLabel>Gift title</FieldLabel>
        <input
          type="text"
          value={fields.title}
          maxLength={105}
          onChange={(e) => handleTitle(e.target.value)}
          placeholder="e.g. Happy Birthday, Alex!"
          className="w-full rounded-xl px-4 py-3 text-sm outline-none"
          style={inputStyle(!!errors.title)}
          onFocus={(e) => { if (!errors.title) e.currentTarget.style.borderColor = 'var(--accent)' }}
          onBlur={(e) => { e.currentTarget.style.borderColor = errors.title ? 'var(--danger)' : 'var(--border-strong)' }}
        />
        {errors.title && (
          <p className="text-xs mt-1.5" style={{ color: 'var(--danger)' }} role="alert">{errors.title}</p>
        )}
        <p className="text-xs mt-1" style={{ color: 'var(--subtle)' }}>
          {fields.title.length}/100 — This title is immutable once saved.
        </p>
      </div>

      {/* Description */}
      <div>
        <FieldLabel optional>Description</FieldLabel>
        <textarea
          value={fields.description}
          maxLength={510}
          rows={3}
          onChange={(e) => handleDescription(e.target.value)}
          placeholder="Add a personal message or instructions for contributors…"
          className="w-full rounded-xl px-4 py-3 text-sm outline-none resize-none"
          style={inputStyle(!!errors.description)}
          onFocus={(e) => { if (!errors.description) e.currentTarget.style.borderColor = 'var(--accent)' }}
          onBlur={(e) => { e.currentTarget.style.borderColor = errors.description ? 'var(--danger)' : 'var(--border-strong)' }}
        />
        {errors.description && (
          <p className="text-xs mt-1.5" style={{ color: 'var(--danger)' }} role="alert">{errors.description}</p>
        )}
      </div>

      {/* Funding target */}
      <div>
        <FieldLabel optional>Funding target (USDC)</FieldLabel>
        <div className="relative">
          <span
            className="absolute left-4 top-1/2 -translate-y-1/2 text-sm font-semibold pointer-events-none select-none"
            style={{ color: 'var(--ink-2)' }}
          >
            $
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={fields.targetInput}
            onChange={(e) => handleTarget(e.target.value)}
            placeholder="0.00"
            className="w-full rounded-xl pl-8 pr-4 py-3 text-sm font-semibold tabular outline-none"
            style={inputStyle(!!errors.target)}
            onFocus={(e) => { if (!errors.target) e.currentTarget.style.borderColor = 'var(--accent)' }}
            onBlur={(e) => { e.currentTarget.style.borderColor = errors.target ? 'var(--danger)' : 'var(--border-strong)' }}
          />
        </div>
        {errors.target && (
          <p className="text-xs mt-1.5" style={{ color: 'var(--danger)' }} role="alert">{errors.target}</p>
        )}
        <p className="text-xs mt-1" style={{ color: 'var(--subtle)' }}>
          Visual only — contributions are accepted at any amount regardless of target.
        </p>
      </div>
    </div>
  )
}

/** Validate the metadata fields; returns true if all fields are valid. */
export function validateMetadata(
  fields: GiftMetaFields,
  onError: (errors: GiftMetaErrors) => void,
): boolean {
  const errors: GiftMetaErrors = { title: null, description: null, target: null }
  let valid = true

  if (!fields.title.trim()) {
    errors.title = 'Title is required.'
    valid = false
  } else if (fields.title.trim().length > 100) {
    errors.title = 'Title must be 100 characters or fewer.'
    valid = false
  }

  if (fields.description.length > 500) {
    errors.description = 'Description must be 500 characters or fewer.'
    valid = false
  }

  if (fields.targetInput.trim()) {
    const result = parseContributionAmount(fields.targetInput)
    if (!result.ok) {
      errors.target = result.error
      valid = false
    }
  }

  onError(errors)
  return valid
}

/** Convert MetadataForm fields to API payload fields. */
export function metaFieldsToPayload(fields: GiftMetaFields): {
  title: string
  description: string | null
  targetAmountRaw: string | null
} {
  const targetResult = fields.targetInput.trim()
    ? parseContributionAmount(fields.targetInput)
    : null

  return {
    title: fields.title.trim(),
    description: fields.description.trim() || null,
    targetAmountRaw: targetResult?.ok ? String(targetResult.raw) : null,
  }
}
