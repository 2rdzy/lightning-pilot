// Settings overview (route map /settings, both views): one card per settings screen, with the figures that need
// attention first (unresolved spends, nodes that still need limits).
import { useQueries, useQuery } from '@tanstack/react-query';
import { Card, StatusPill } from '@lightning-pilot/ui';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { nodesQuery } from '../../app/queries.ts';
import { unresolvedQuery } from './queries.ts';
import { SettingsPage } from './parts.tsx';

function Entry({ to, title, body, badge }: { to: string; title: string; body: string; badge?: ReactNode }) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <Link to={to} className="text-lg font-semibold text-brand-strong underline">
            {title}
          </Link>
          <p className="text-sm text-muted">{body}</p>
        </div>
        {badge}
      </div>
    </Card>
  );
}

export function SettingsScreen() {
  const api = useApi(),
    tr = useT();
  const nodes = useQuery(nodesQuery(api));
  const items = nodes.data?.items ?? [];
  const unresolved = useQueries({ queries: items.map((n) => unresolvedQuery(api, n.id)) });
  const open = unresolved.reduce((sum, q) => sum + (q.data?.items.length ?? 0), 0);
  const needLimits = items.filter((n) => n.limitsRequired && n.canSpend).length;
  return (
    <SettingsPage title={tr.t('settings.title')} intro={tr.t('settings.intro')} back={false}>
      <div className="grid gap-4 md:grid-cols-2">
        <Entry
          to="/settings/security"
          title={tr.t('settings.security.title')}
          body={tr.t('settings.security.summary')}
        />
        <Entry
          to="/settings/sessions"
          title={tr.t('settings.sessions.title')}
          body={tr.t('settings.sessions.summary')}
        />
        <Entry
          to="/settings/nodes"
          title={tr.t('settings.nodes.title')}
          body={tr.plural('settings.nodes.summary', items.length)}
          badge={
            needLimits > 0 ? (
              <StatusPill tone="warning" label={tr.plural('settings.nodes.needLimits', needLimits)} />
            ) : null
          }
        />
        <Entry
          to="/settings/spends"
          title={tr.t('settings.spends.title')}
          body={tr.t('settings.spends.summary')}
          badge={
            <span data-testid="unresolved-count">
              <StatusPill tone={open > 0 ? 'warning' : 'muted'} label={tr.plural('settings.spends.count', open)} />
            </span>
          }
        />
        <Entry to="/settings/display" title={tr.t('settings.display.title')} body={tr.t('settings.display.summary')} />
        <Entry to="/settings/export" title={tr.t('export.title')} body={tr.t('settings.export.summary')} />
      </div>
    </SettingsPage>
  );
}
