'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, LogIn } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isApiClientError, login } from '@/lib/api-client';

function messageFor(error: unknown): string {
  if (!isApiClientError(error)) return 'Something went wrong. Please try again.';
  if (error.code === 'UNAUTHENTICATED' || error.status === 401) return 'That password is not correct.';
  if (error.code === 'RATE_LIMITED' || error.status === 429) {
    return 'Too many sign-in attempts. Wait a minute or two, then try again.';
  }
  return error.message;
}

export function LoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const errorId = useId();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password === '') {
      setError('Enter the access password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(password);
      router.replace('/');
      router.refresh();
    } catch (caught) {
      setError(messageFor(caught));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div className="space-y-2">
        <label htmlFor={fieldId} className="text-sm font-medium">
          Access password
        </label>
        <Input
          id={fieldId}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          autoFocus
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
      </div>
      {error ? (
        <Alert variant="destructive" id={errorId}>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" size="lg" disabled={busy} className="w-full">
        {busy ? <Loader2 className="size-5 animate-spin motion-reduce:animate-none" aria-hidden /> : <LogIn className="size-5" aria-hidden />}
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
