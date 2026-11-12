'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { ClipboardPaste, Download, Loader2 } from 'lucide-react';
import { detectUrl, guessPlatform, PLATFORM_NAMES } from '@vd/shared';
import { PlatformIcon } from '@/components/platform-icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface UrlFormProps {
  onSubmit: (url: string) => void;
  onPlatformChange?: (platform: ReturnType<typeof guessPlatform>) => void;
  busy?: boolean;
}

const CLIPBOARD_HELP = "Couldn't read the clipboard. Paste the link with Ctrl+V (⌘V on Mac) instead.";

export function UrlForm({ onSubmit, onPlatformChange, busy = false }: UrlFormProps) {
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const messageId = useId();

  const platform = useMemo(() => guessPlatform(value), [value]);

  function update(next: string) {
    setValue(next);
    setMessage(null);
    onPlatformChange?.(guessPlatform(next));
  }

  async function paste() {
    try {
      if (!navigator.clipboard?.readText) throw new Error('clipboard unavailable');
      const text = await navigator.clipboard.readText();
      update(text.trim());
      inputRef.current?.focus();
    } catch {
      setMessage(CLIPBOARD_HELP);
    }
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed === '') {
      setMessage('Paste a YouTube, Instagram or Facebook link first.');
      inputRef.current?.focus();
      return;
    }
    const detection = detectUrl(trimmed);
    if (!detection.ok) {
      setMessage(detection.message);
      inputRef.current?.focus();
      return;
    }
    setMessage(null);
    onSubmit(trimmed);
  }

  return (
    <form onSubmit={submit} noValidate className="w-full space-y-3">
      <label htmlFor={inputId} className="sr-only">
        Media link
      </label>
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Input
            id={inputId}
            ref={inputRef}
            value={value}
            onChange={(event) => update(event.target.value)}
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="Paste a YouTube, Instagram or Facebook link"
            aria-invalid={message ? true : undefined}
            aria-describedby={message ? messageId : undefined}
            className="h-14 pr-28 text-base"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void paste()}
            className="absolute right-2 top-1/2 -translate-y-1/2"
          >
            <ClipboardPaste className="size-4" aria-hidden />
            Paste
          </Button>
        </div>
        <Button type="submit" size="lg" disabled={busy} className="h-14 sm:min-w-52">
          {busy ? (
            <>
              <Loader2 className="size-5 animate-spin motion-reduce:animate-none" aria-hidden />
              Checking link…
            </>
          ) : (
            <>
              <Download className="size-5" aria-hidden />
              Get download options
            </>
          )}
        </Button>
      </div>

      <div className="min-h-6 text-sm" aria-live="polite">
        {message ? (
          <p id={messageId} className="font-medium text-red-700">
            {message}
          </p>
        ) : platform ? (
          <p data-testid="platform-chip" className="inline-flex items-center gap-2 text-brand-800">
            <PlatformIcon platform={platform} className="size-4" />
            <span>{PLATFORM_NAMES[platform]} link detected</span>
          </p>
        ) : (
          <p className="text-muted">We&apos;ll check what&apos;s available for the link, then you choose MP4 or MP3.</p>
        )}
      </div>
    </form>
  );
}
