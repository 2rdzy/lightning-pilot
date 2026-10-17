// Pages outside the node shell: the frame of the setup, login and recovery screens (the mark above a centred
// column), "not found" with a way back, and the screen shown while no node exists.
import { Link } from '@tanstack/react-router';
import { Logo } from '@lightning-pilot/ui';
import type { ReactNode } from 'react';
import { useT } from '../app/i18n.tsx';

export function AuthFrame({ children }: { children: ReactNode }) {
  const tr = useT();
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-8 md:py-16">
      <div className="mb-6 flex items-center gap-3">
        <Logo size={40} />
        <span className="text-xl font-semibold">{tr.t('app.name')}</span>
      </div>
      <main className="flex w-full max-w-[640px] flex-col gap-6">{children}</main>
    </div>
  );
}

export function NotFound() {
  const tr = useT();
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
      <Logo size={40} />
      <h1 className="text-2xl font-semibold">{tr.t('app.notFound.title')}</h1>
      <p className="text-muted">{tr.t('app.notFound.body')}</p>
      <Link to="/" className="text-brand-strong underline">
        {tr.t('app.notFound.back')}
      </Link>
    </main>
  );
}

export function NoNodes() {
  const tr = useT();
  return (
    <AuthFrame>
      <h1 className="text-2xl font-semibold">{tr.t('app.noNodes.title')}</h1>
      <p className="text-muted">{tr.t('app.noNodes.body')}</p>
      <Link to="/settings/nodes" search={{ add: true }} className="text-brand-strong underline">
        {tr.t('app.noNodes.add')}
      </Link>
      <Link to="/settings/export" className="text-brand-strong underline">
        {tr.t('export.title')}
      </Link>
    </AuthFrame>
  );
}
