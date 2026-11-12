import { Lock } from 'lucide-react';
import { Logo } from '@/components/logo';
import { SignOutButton } from '@/components/sign-out-button';

interface AppShellProps {
  children: React.ReactNode;
  signedIn?: boolean;
  /** Narrower column for the sign-in screen. */
  narrow?: boolean;
}

export function AppShell({ children, signedIn = false, narrow = false }: AppShellProps) {
  const width = narrow ? 'max-w-md' : 'max-w-3xl';
  return (
    <div className="flex min-h-dvh flex-col">
      <header className={`mx-auto w-full px-4 py-5 sm:px-6 ${width}`}>
        <Logo />
      </header>
      <main className={`mx-auto w-full flex-1 px-4 pb-16 pt-4 sm:px-6 sm:pt-10 ${width}`}>{children}</main>
      <footer className="border-t border-line bg-surface">
        <div className={`mx-auto flex w-full items-center justify-between gap-3 px-4 py-3 text-sm text-muted sm:px-6 ${width}`}>
          <span className="inline-flex items-center gap-1.5">
            <Lock className="size-3.5" aria-hidden />
            Private instance
          </span>
          {signedIn ? <SignOutButton /> : null}
        </div>
      </footer>
    </div>
  );
}
