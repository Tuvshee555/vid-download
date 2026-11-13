import { redirect } from 'next/navigation';
import { ServerCrash } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { Downloader } from '@/components/downloader';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { authDisabled, serverMode } from '@/lib/server/standalone';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await getSession();
  if (session.status === 'unauthenticated') redirect('/login');

  if (session.status === 'unreachable') {
    return (
      <AppShell>
        <Alert variant="destructive">
          <ServerCrash aria-hidden />
          <AlertTitle>The MediaDock server is unreachable</AlertTitle>
          <AlertDescription>
            <p>The API didn&apos;t respond. It may be starting up (free hosting plans sleep when idle) — refresh in a minute.</p>
          </AlertDescription>
        </Alert>
      </AppShell>
    );
  }

  return (
    <AppShell signedIn={!authDisabled()}>
      <Downloader mode={serverMode()} />
    </AppShell>
  );
}
