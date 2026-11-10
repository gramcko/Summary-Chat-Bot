"use client";

import type { ChangeEvent, ReactNode } from "react";

const BASE_INPUT =
  "block w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm " +
  "placeholder:text-slate-400 focus:outline-none focus-visible:outline-none " +
  "focus:border-brand-600 focus:ring-2 focus:ring-brand-200 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500";

function inputClasses(error: string | undefined): string {
  return `${BASE_INPUT} ${error === undefined ? "border-slate-300" : "border-red-400"}`;
}

const LABEL_CLASS = "block text-sm font-medium text-slate-800";
const HINT_CLASS = "mt-1 text-xs text-slate-500";
const ERROR_CLASS = "mt-1 text-xs font-medium text-red-700";
const REQUIRED_MARK = <span className="text-red-700"> *</span>;

interface FieldLabelProps {
  htmlFor: string;
  label: ReactNode;
  required?: boolean;
}

function FieldLabel({ htmlFor, label, required = false }: FieldLabelProps) {
  return (
    <label htmlFor={htmlFor} className={LABEL_CLASS}>
      {label}
      {required ? REQUIRED_MARK : null}
    </label>
  );
}

function describedBy(
  id: string,
  hint: string | undefined,
  error: string | undefined,
): string | undefined {
  const ids = [
    hint === undefined ? null : `${id}-hint`,
    error === undefined ? null : `${id}-error`,
  ].filter((value): value is string => value !== null);
  return ids.length === 0 ? undefined : ids.join(" ");
}

interface FieldMessagesProps {
  id: string;
  hint?: string;
  error?: string;
}

function FieldMessages({ id, hint, error }: FieldMessagesProps) {
  return (
    <>
      {hint !== undefined && error === undefined ? (
        <p id={`${id}-hint`} className={HINT_CLASS}>
          {hint}
        </p>
      ) : null}
      {error === undefined ? null : (
        <p id={`${id}-error`} className={ERROR_CLASS}>
          {error}
        </p>
      )}
    </>
  );
}

export interface TextFieldProps {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "password" | "url" | "time" | "date" | "datetime-local";
  hint?: string;
  error?: string;
  required?: boolean;
  placeholder?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  spellCheck?: boolean;
  maxLength?: number;
  min?: string;
  max?: string;
  step?: number | string;
  list?: string;
  className?: string;
  mono?: boolean;
}

export function TextField({
  id,
  label,
  value,
  onChange,
  type = "text",
  hint,
  error,
  required = false,
  placeholder,
  autoComplete,
  autoFocus = false,
  disabled = false,
  readOnly = false,
  spellCheck,
  maxLength,
  min,
  max,
  step,
  list,
  className = "",
  mono = false,
}: TextFieldProps) {
  return (
    <div className={className}>
      <FieldLabel htmlFor={id} label={label} required={required} />
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          onChange(event.target.value)
        }
        className={`mt-1.5 ${inputClasses(error)} ${mono ? "font-mono" : ""}`}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy(id, hint, error)}
        aria-required={required || undefined}
        required={required}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        disabled={disabled}
        readOnly={readOnly}
        spellCheck={spellCheck}
        maxLength={maxLength}
        min={min}
        max={max}
        step={step}
        list={list}
      />
      <FieldMessages id={id} hint={hint} error={error} />
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
}

export function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  placeholder,
  hint,
  error,
  required = false,
  disabled = false,
  className = "",
}: SelectFieldProps) {
  return (
    <div className={className}>
      <FieldLabel htmlFor={id} label={label} required={required} />
      <select
        id={id}
        name={id}
        value={value}
        onChange={(event: ChangeEvent<HTMLSelectElement>) =>
          onChange(event.target.value)
        }
        className={`mt-1.5 ${inputClasses(error)}`}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy(id, hint, error)}
        aria-required={required || undefined}
        required={required}
        disabled={disabled}
      >
        {placeholder === undefined ? null : (
          <option value="">{placeholder}</option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <FieldMessages id={id} hint={hint} error={error} />
    </div>
  );
}

export interface CheckboxFieldProps {
  id: string;
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  description?: string;
  error?: string;
  disabled?: boolean;
  className?: string;
}

export function CheckboxField({
  id,
  label,
  checked,
  onChange,
  description,
  error,
  disabled = false,
  className = "",
}: CheckboxFieldProps) {
  return (
    <div className={className}>
      <div className="flex items-start gap-3">
        <input
          id={id}
          name={id}
          type="checkbox"
          checked={checked}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onChange(event.target.checked)
          }
          disabled={disabled}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy(id, description, error)}
          className="mt-0.5 h-4 w-4 rounded border-slate-400 text-brand-600 focus:ring-2 focus:ring-brand-200 disabled:opacity-60"
        />
        <div className="min-w-0">
          <label htmlFor={id} className="text-sm font-medium text-slate-800">
            {label}
          </label>
          <FieldMessages id={id} hint={description} error={error} />
        </div>
      </div>
    </div>
  );
}

export interface TextAreaFieldProps {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
  required?: boolean;
  placeholder?: string;
  /** Hard input limit (HTML `maxLength`); omitted means no truncation. */
  maxLength?: number;
  /** Display limit for the `n / max` counter (defaults to `maxLength`). */
  counterMax?: number;
  rows?: number;
  disabled?: boolean;
  spellCheck?: boolean;
  className?: string;
  /** Shows `n / max` under the field (requires `maxLength` or `counterMax`). */
  showCounter?: boolean;
}

export function TextAreaField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  required = false,
  placeholder,
  maxLength,
  counterMax,
  rows = 4,
  disabled = false,
  spellCheck,
  className = "",
  showCounter = false,
}: TextAreaFieldProps) {
  const displayMax = counterMax ?? maxLength;
  const counterId =
    showCounter && displayMax !== undefined ? `${id}-counter` : undefined;
  const describedByIds = [
    hint === undefined ? null : `${id}-hint`,
    error === undefined ? null : `${id}-error`,
    counterId ?? null,
  ].filter((entry): entry is string => entry !== null);

  return (
    <div className={className}>
      <FieldLabel htmlFor={id} label={label} required={required} />
      <textarea
        id={id}
        name={id}
        value={value}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
          onChange(event.target.value)
        }
        rows={rows}
        className={`mt-1.5 min-h-24 w-full resize-y ${inputClasses(error)}`}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={
          describedByIds.length === 0 ? undefined : describedByIds.join(" ")
        }
        aria-required={required || undefined}
        required={required}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        spellCheck={spellCheck}
      />
      <FieldMessages id={id} hint={hint} error={error} />
      {counterId === undefined ? null : (
        <p
          id={counterId}
          className={`mt-1 text-right text-xs tabular-nums ${
            displayMax !== undefined && value.length > displayMax
              ? "font-medium text-red-700"
              : "text-slate-500"
          }`}
        >
          {value.length} / {displayMax}
        </p>
      )}
    </div>
  );
}
