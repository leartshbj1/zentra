'use client';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
export function Choice({
  label,
  value,
  onChange,
  options,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <label className="support-field">
      <span>{label}</span>
      <Select
        value={value || '__none'}
        onValueChange={(v) =>
          onChange(v === '__none' || v === null ? '' : String(v))
        }
        disabled={disabled}
        items={options.map((o) => ({
          value: o.value || '__none',
          label: o.label,
        }))}
      >
        <SelectTrigger aria-label={label} className="support-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value || '__none'} value={o.value || '__none'}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
export function Field({
  label,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="support-field">
      <span>{label}</span>
      <input {...props} />
    </label>
  );
}
export function formatDate(seconds: number) {
  return new Intl.DateTimeFormat('fr-CH', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(seconds * 1000);
}
