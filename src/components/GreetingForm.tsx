/**
 * GreetingForm — optional display name and message for contribution greetings.
 *
 * Saved after on-chain confirmation, not during the contribution flow.
 * An initially empty greeting can be filled once; existing nonempty messages
 * are immutable — the backend enforces this.
 *
 * This signature authorizes saving metadata; it does NOT transfer USDC
 * or approve token spending.
 */

export interface GreetingFields {
  displayName: string
  message: string
}

export interface GreetingErrors {
  displayName: string | null
  message: string | null
}

interface GreetingFormProps {
  fields: GreetingFields
  errors: GreetingErrors
  onChange: (fields: GreetingFields) => void
  onErrorChange: (errors: GreetingErrors) => void
  /** If true, fields are shown but not editable (already saved) */
  readonly?: boolean
}

export function GreetingForm({ fields, errors, onChange, onErrorChange, readonly }: GreetingFormProps) {
  function handleDisplayName(val: string) {
    onChange({ ...fields, displayName: val })
    if (val.trim().length > 60) onErrorChange({ ...errors, displayName: 'Display name must be 60 characters or fewer.' })
    else onErrorChange({ ...errors, displayName: null })
  }

  function handleMessage(val: string) {
    onChange({ ...fields, message: val })
    if (val.length > 280) onErrorChange({ ...errors, message: 'Message must be 280 characters or fewer.' })
    else onErrorChange({ ...errors, message: null })
  }

  const inputStyle = (hasError: boolean) => ({
    background: readonly ? 'var(--surface-muted)' : 'var(--surface-muted)',
    border: `1px solid ${hasError ? 'var(--danger)' : 'var(--border-strong)'}`,
    color: 'var(--ink)',
    caretColor: 'var(--accent)',
    opacity: readonly ? 0.7 : 1,
  })

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs font-semibold mb-1.5 flex items-center gap-2" style={{ color: 'var(--ink-2)' }}>
          Your name
          <span className="text-xs font-normal" style={{ color: 'var(--subtle)' }}>Optional</span>
        </p>
        <input
          type="text"
          value={fields.displayName}
          maxLength={65}
          readOnly={readonly}
          onChange={(e) => handleDisplayName(e.target.value)}
          placeholder="How you'd like to appear to the recipient"
          className="w-full rounded-xl px-4 py-2.5 text-sm outline-none"
          style={inputStyle(!!errors.displayName)}
          onFocus={(e) => { if (!errors.displayName && !readonly) e.currentTarget.style.borderColor = 'var(--accent)' }}
          onBlur={(e) => { e.currentTarget.style.borderColor = errors.displayName ? 'var(--danger)' : 'var(--border-strong)' }}
        />
        {errors.displayName && (
          <p className="text-xs mt-1" style={{ color: 'var(--danger)' }} role="alert">{errors.displayName}</p>
        )}
      </div>

      <div>
        <p className="text-xs font-semibold mb-1.5 flex items-center gap-2" style={{ color: 'var(--ink-2)' }}>
          Greeting
          <span className="text-xs font-normal" style={{ color: 'var(--subtle)' }}>Optional</span>
        </p>
        <textarea
          value={fields.message}
          maxLength={285}
          rows={3}
          readOnly={readonly}
          onChange={(e) => handleMessage(e.target.value)}
          placeholder="Leave a message for the recipient…"
          className="w-full rounded-xl px-4 py-2.5 text-sm outline-none resize-none"
          style={inputStyle(!!errors.message)}
          onFocus={(e) => { if (!errors.message && !readonly) e.currentTarget.style.borderColor = 'var(--accent)' }}
          onBlur={(e) => { e.currentTarget.style.borderColor = errors.message ? 'var(--danger)' : 'var(--border-strong)' }}
        />
        {errors.message && (
          <p className="text-xs mt-1" style={{ color: 'var(--danger)' }} role="alert">{errors.message}</p>
        )}
        {!readonly && (
          <p className="text-xs mt-1" style={{ color: 'var(--subtle)' }}>
            {fields.message.length}/280
          </p>
        )}
      </div>
    </div>
  )
}

export function validateGreeting(
  fields: GreetingFields,
  onError: (errors: GreetingErrors) => void,
): boolean {
  const errors: GreetingErrors = { displayName: null, message: null }
  let valid = true
  if (fields.displayName.trim().length > 60) {
    errors.displayName = 'Display name must be 60 characters or fewer.'
    valid = false
  }
  if (fields.message.length > 280) {
    errors.message = 'Message must be 280 characters or fewer.'
    valid = false
  }
  onError(errors)
  return valid
}
