'use client';

import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { logout } from '@/lib/api-client';

export function SignOutButton() {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await logout();
    } finally {
      // Even if the request failed, leave: the next page load re-validates the session.
      window.location.replace('/login');
    }
  }

  return (
    <Button variant="ghost" size="sm" onClick={() => void signOut()} disabled={busy}>
      <LogOut className="size-4" aria-hidden />
      Sign out
    </Button>
  );
}
