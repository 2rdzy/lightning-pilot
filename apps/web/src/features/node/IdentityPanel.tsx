import type { ChainIdentityResponse } from '@lightning-pilot/core';
import { StatusPill } from '@lightning-pilot/ui';
import type { z } from 'zod';
import { useT } from '../../app/i18n.tsx';
import { formatDateTime } from '../../i18n/format.ts';

export function IdentityPanel({ identity }: { identity: z.infer<typeof ChainIdentityResponse> }) {
  const tr = useT();
  return (
    <div className="flex flex-col gap-2" data-testid="node-identity" data-state={identity.state}>
      <div>
        <StatusPill
          tone={identity.state === 'confirmed' ? 'success' : identity.state === 'refused' ? 'danger' : 'warning'}
          label={tr.t(`node.identity.${identity.state}`)}
        />
      </div>
      <p className="text-sm">{tr.t(`node.identityBody.${identity.state}`)}</p>
      <p className="text-sm">
        <span className="text-muted">{tr.t('node.profile')}: </span>
        {tr.t(`node.profile.${identity.profile}`)}
      </p>
      <p className="text-xs text-muted">
        {tr.t('node.checkedAt')}:{' '}
        <time dateTime={identity.checkedAt} title={identity.checkedAt}>
          {formatDateTime(identity.checkedAt, tr.locale)}
        </time>
      </p>
      {identity.failedCheck ? (
        <p className="text-sm">
          {tr.t('node.failedCheck')}: {tr.t(`node.check.${identity.failedCheck}`)}
        </p>
      ) : null}
      {identity.detail ? <p className="break-words text-sm text-muted">{identity.detail}</p> : null}
    </div>
  );
}
