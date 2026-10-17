// Settings › Sessions (route map /settings/sessions, both views; story U10; sessions §3, §11): the sessions with
// revoke and "log out everywhere" (no step-up), the known devices and the session timeouts (both behind a security
// step-up, the lists too). Ending this session goes through the shell, which closes the live stream first.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, DestructiveConfirm, Field, StatusPill, SuccessNote } from '@lightning-pilot/ui';
import type { DeviceListResponse, SessionListResponse } from '@lightning-pilot/core';
import { useId, useState } from 'react';
import type { z } from 'zod';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';
import { formatDateTime } from '../../i18n/format.ts';
import { ErrorNote } from '../../shell/parts.tsx';
import { useShellSession } from '../../shell/Shell.tsx';
import {
  DURATION_UNITS,
  fromSeconds,
  sessionPolicyOf,
  type Duration,
  type DurationUnit,
  type SessionTimeouts,
} from './data.ts';
import { LockedCard, SettingsPage } from './parts.tsx';
import { sessionsQuery } from './queries.ts';
import { useSecurityGuard } from './step-up.tsx';

type SessionRow = z.infer<typeof SessionListResponse>['items'][number];
type DeviceRow = z.infer<typeof DeviceListResponse>['items'][number];

function When({ label, iso }: { label: string; iso: string }) {
  const tr = useT();
  return (
    <span>
      <span className="text-muted">{label} </span>
      <time dateTime={iso} title={iso}>
        {formatDateTime(iso, tr.locale)}
      </time>
    </span>
  );
}

function SessionsCard() {
  const api = useApi(),
    tr = useT(),
    queries = useQueryClient();
  const { endSession } = useShellSession();
  const sessions = useQuery(sessionsQuery(api));
  const [ending, setEnding] = useState<SessionRow | 'everywhere'>();
  const [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false);
  const live = (sessions.data?.items ?? []).filter((s) => s.endedAt === null);
  const ended = (sessions.data?.items ?? []).filter((s) => s.endedAt !== null);
  const end = async () => {
    const target = ending;
    setEnding(undefined);
    setError(undefined);
    setPending(true);
    try {
      if (target === 'everywhere') await endSession(() => api.call('logoutEverywhere', { userActivity: true }));
      else if (target?.current)
        await endSession(() => api.call('revokeSession', { params: { sessionId: target.id }, userActivity: true }));
      else if (target) {
        await api.call('revokeSession', { params: { sessionId: target.id }, userActivity: true });
        await queries.invalidateQueries({ queryKey: ['sessions'] });
      }
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };
  return (
    <Card
      title={tr.t('settings.sessions.liveTitle')}
      actions={
        <Button variant="danger" onClick={() => setEnding('everywhere')} disabled={pending}>
          {tr.t('settings.sessions.everywhere')}
        </Button>
      }
    >
      {sessions.isError ? <ErrorNote error={sessions.error} onRetry={() => void sessions.refetch()} /> : null}
      <ul className="flex flex-col divide-y divide-border" data-testid="sessions">
        {live.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-3" data-testid="session-row">
            <div className="flex flex-col gap-1 text-sm">
              <span className="flex flex-wrap items-center gap-2 font-medium">
                {s.source === 'unknown' ? tr.t('settings.sessions.sourceUnknown') : s.source}
                {s.current ? <StatusPill tone="success" label={tr.t('settings.sessions.current')} /> : null}
              </span>
              <When label={tr.t('settings.sessions.created')} iso={s.createdAt} />
              <When label={tr.t('settings.sessions.lastUsed')} iso={s.lastUsedAt} />
              <When label={tr.t('settings.sessions.expires')} iso={s.expiresAt} />
            </div>
            <Button onClick={() => setEnding(s)} disabled={pending}>
              {tr.t(s.current ? 'settings.sessions.revokeCurrent' : 'settings.sessions.revoke')}
            </Button>
          </li>
        ))}
      </ul>
      {ended.length > 0 ? (
        <details className="mt-3 text-sm">
          <summary className="min-h-11 cursor-pointer py-2">
            {tr.plural('settings.sessions.ended', ended.length)}
          </summary>
          <ul className="flex flex-col gap-2">
            {ended.map((s) => (
              <li key={s.id} className="flex flex-wrap gap-x-4 text-muted">
                <span>{s.source}</span>
                <When label={tr.t('settings.sessions.endedAt')} iso={s.endedAt ?? s.lastUsedAt} />
                <span>{tr.t(`settings.sessions.reason.${s.endReason ?? 'unknown'}`)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {error ? <ErrorNote error={error} /> : null}
      <DestructiveConfirm
        open={ending !== undefined}
        onOpenChange={(open) => {
          if (!open) setEnding(undefined);
        }}
        title={tr.t(ending === 'everywhere' ? 'settings.sessions.everywhere' : 'settings.sessions.revoke')}
        consequences={tr.t(
          ending === 'everywhere'
            ? 'settings.sessions.everywhereConsequences'
            : ending !== undefined && ending.current
              ? 'settings.sessions.revokeCurrentConsequences'
              : 'settings.sessions.revokeConsequences',
        )}
        confirmLabel={tr.t(ending === 'everywhere' ? 'settings.sessions.everywhere' : 'settings.sessions.revoke')}
        cancelLabel={tr.t('common.cancel')}
        onConfirm={() => void end()}
        pending={pending}
      />
    </Card>
  );
}

function DevicesCard() {
  const api = useApi(),
    tr = useT();
  const guard = useSecurityGuard(tr.t('settings.sessions.devicesReason'));
  const [devices, setDevices] = useState<DeviceRow[]>();
  const [revoking, setRevoking] = useState<DeviceRow>();
  const [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false);
  const act = async (fn: () => Promise<void>) => {
    setError(undefined);
    setPending(true);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };
  const load = () =>
    act(async () => {
      const result = await guard.run(() => api.call('devices', { userActivity: true }));
      if (result) setDevices(result.items);
    });
  const revoke = () =>
    act(async () => {
      const target = revoking;
      setRevoking(undefined);
      if (!target) return;
      const result = await guard.run(async () => {
        await api.call('revokeDevice', { params: { deviceId: target.id }, userActivity: true });
        return api.call('devices', { userActivity: true });
      });
      if (result) setDevices(result.items);
    });
  if (devices === undefined)
    return (
      <>
        <LockedCard
          title={tr.t('settings.sessions.devicesTitle')}
          body={tr.t('settings.sessions.devicesLocked')}
          onUnlock={() => void load()}
        />
        {error ? <ErrorNote error={error} /> : null}
        {guard.dialog}
      </>
    );
  return (
    <Card title={tr.t('settings.sessions.devicesTitle')}>
      <p className="mb-3 text-sm text-muted">{tr.t('settings.sessions.devicesIntro')}</p>
      {devices.length === 0 ? (
        <p className="text-sm" data-testid="devices-empty">
          {tr.t('settings.sessions.devicesEmpty')}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border" data-testid="devices">
          {devices.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-3" data-testid="device-row">
              <div className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{d.source}</span>
                <When label={tr.t('settings.sessions.created')} iso={d.createdAt} />
                <When label={tr.t('settings.sessions.lastUsed')} iso={d.lastUsedAt} />
                <When label={tr.t('settings.sessions.expires')} iso={d.expiresAt} />
              </div>
              <Button onClick={() => setRevoking(d)} disabled={pending}>
                {tr.t('settings.sessions.revokeDevice')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error ? <ErrorNote error={error} /> : null}
      <DestructiveConfirm
        open={revoking !== undefined}
        onOpenChange={(open) => {
          if (!open) setRevoking(undefined);
        }}
        title={tr.t('settings.sessions.revokeDevice')}
        consequences={tr.t('settings.sessions.revokeDeviceConsequences')}
        confirmLabel={tr.t('settings.sessions.revokeDevice')}
        cancelLabel={tr.t('common.cancel')}
        onConfirm={() => void revoke()}
        pending={pending}
      />
      {guard.dialog}
    </Card>
  );
}

function DurationField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: Duration;
  onChange: (value: Duration) => void;
}) {
  const tr = useT(),
    id = useId();
  return (
    <Field label={label} htmlFor={`${id}-value`} hint={hint}>
      <div className="flex gap-2">
        <input
          id={`${id}-value`}
          className="input w-28"
          inputMode="numeric"
          value={value.value}
          onChange={(e) => onChange({ ...value, value: e.target.value })}
        />
        <select
          aria-label={tr.t('settings.sessions.unit', { field: label })}
          className="input w-36"
          value={value.unit}
          onChange={(e) => onChange({ ...value, unit: e.target.value as DurationUnit })}
        >
          {DURATION_UNITS.map((u) => (
            <option key={u} value={u}>
              {tr.t(`settings.sessions.units.${u}`)}
            </option>
          ))}
        </select>
      </div>
    </Field>
  );
}

function PolicyCard() {
  const api = useApi(),
    tr = useT();
  const guard = useSecurityGuard(tr.t('settings.sessions.policyReason'));
  const [policy, setPolicy] = useState<{ idle: Duration; absolute: Duration }>();
  const [note, setNote] = useState<string>(),
    [error, setError] = useState<unknown>(),
    [saved, setSaved] = useState(false),
    [pending, setPending] = useState(false);
  const show = (p: SessionTimeouts) =>
    setPolicy({ idle: fromSeconds(p.idleSeconds), absolute: fromSeconds(p.absoluteSeconds) });
  const act = async (fn: () => Promise<void>) => {
    setError(undefined);
    setNote(undefined);
    setPending(true);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  };
  const load = () =>
    act(async () => {
      const result = await guard.run(() => api.call('sessionPolicy', { userActivity: true }));
      if (result) show(result);
    });
  const save = () =>
    act(async () => {
      setSaved(false);
      if (!policy) return;
      const checked = sessionPolicyOf(policy.idle, policy.absolute);
      if (!checked.ok) {
        setNote(tr.t(checked.reason === 'order' ? 'settings.sessions.policyOrder' : 'settings.sessions.policyRange'));
        return;
      }
      const ok = await guard.run(() =>
        api.call('changeSessionPolicy', { body: checked.policy, userActivity: true }).then(() => true),
      );
      if (ok) {
        show(checked.policy);
        setSaved(true);
      }
    });
  if (!policy)
    return (
      <>
        <LockedCard
          title={tr.t('settings.sessions.policyTitle')}
          body={tr.t('settings.sessions.policyLocked')}
          onUnlock={() => void load()}
        />
        {error ? <ErrorNote error={error} /> : null}
        {guard.dialog}
      </>
    );
  return (
    <Card title={tr.t('settings.sessions.policyTitle')}>
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <DurationField
          label={tr.t('settings.sessions.idle')}
          hint={tr.t('settings.sessions.idleHint')}
          value={policy.idle}
          onChange={(idle) => setPolicy({ ...policy, idle })}
        />
        <DurationField
          label={tr.t('settings.sessions.absolute')}
          hint={tr.t('settings.sessions.absoluteHint')}
          value={policy.absolute}
          onChange={(absolute) => setPolicy({ ...policy, absolute })}
        />
        {note ? (
          <p role="alert" className="text-sm text-danger">
            {note}
          </p>
        ) : null}
        {error ? <ErrorNote error={error} /> : null}
        {saved ? <SuccessNote>{tr.t('settings.sessions.policySaved')}</SuccessNote> : null}
        <Button type="submit" variant="primary" disabled={pending} className="self-start">
          {tr.t('settings.sessions.policySave')}
        </Button>
      </form>
      {guard.dialog}
    </Card>
  );
}

export function SessionsScreen() {
  const tr = useT();
  return (
    <SettingsPage title={tr.t('settings.sessions.title')} intro={tr.t('settings.sessions.intro')}>
      <SessionsCard />
      <DevicesCard />
      <PolicyCard />
    </SettingsPage>
  );
}
