import { EXPORT_FILE_BYTES, ExportEnvelope } from '@lightning-pilot/core';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { useApi } from '../../app/api-context.tsx';
import { useT } from '../../app/i18n.tsx';

export function ExportScreen() {
  const api = useApi(),
    tr = useT(),
    queries = useQueryClient();
  const [password, setPassword] = useState(''),
    [totp, setTotp] = useState('');
  const [passphrase, setPassphrase] = useState(''),
    [confirmation, setConfirmation] = useState('');
  const [include, setInclude] = useState(false),
    [authorized, setAuthorized] = useState(false),
    [pending, setPending] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [message, setMessage] = useState(''),
    [failed, setFailed] = useState(false);
  const [file, setFile] = useState<File>();
  const dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null);
  const urls = useRef(new Set<string>()),
    abort = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      abort.current?.abort();
      for (const url of urls.current) URL.revokeObjectURL(url);
    },
    [],
  );
  const clear = () => {
    setPassphrase('');
    setConfirmation('');
    setFile(undefined);
    if (input.current) input.current.value = '';
  };
  const closeDialog = () => {
    setPassword('');
    setTotp('');
    setAuthOpen(false);
    dialog.current?.close();
  };
  const work = async (fn: (signal: AbortSignal) => Promise<void>) => {
    setPending(true);
    setMessage('');
    setFailed(false);
    const controller = new AbortController();
    abort.current = controller;
    try {
      await fn(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.code === 'step_up_required') setAuthorized(false);
      setFailed(true);
      setMessage(error instanceof ApiError ? error.message : tr.t('export.failed'));
    } finally {
      setPending(false);
      setPassword('');
      setTotp('');
      clear();
    }
  };
  return (
    <main className="mx-auto flex max-w-[640px] flex-col gap-4 p-4">
      <h1 className="text-2xl font-semibold">{tr.t('export.title')}</h1>
      <Link to="/" className="underline">
        {tr.t('export.back')}
      </Link>
      <p>{tr.t('export.notice')}</p>
      <p role="note">{tr.t('export.safety')}</p>
      <button
        type="button"
        className="btn-secondary"
        disabled={pending}
        onClick={() => {
          setMessage('');
          setFailed(false);
          setAuthOpen(true);
          dialog.current?.showModal();
        }}
      >
        {tr.t('export.authorize')}
      </button>
      {authorized ? <p>{tr.t('export.authorized')}</p> : null}
      <dialog
        ref={dialog}
        aria-labelledby="export-auth-title"
        onCancel={closeDialog}
        className="bg-surface text-text rounded p-4"
      >
        <h2 id="export-auth-title">{tr.t('export.authorize')}</h2>
        {authOpen && failed && message ? <p role="alert">{message}</p> : null}
        {authOpen && pending ? <p role="status">{tr.t('export.pending')}</p> : null}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void work(async (signal) => {
              const proof = password,
                code = totp;
              setPassword('');
              setTotp('');
              await api.call('stepUp', {
                body: { password: proof, strength: 'security', totpCode: code },
                userActivity: true,
                signal,
              });
              setAuthorized(true);
              closeDialog();
            });
          }}
          className="flex flex-col gap-3"
        >
          <label>
            {tr.t('export.password')}
            <input
              className="border-border rounded-control bg-surface text-text block w-full border px-3 py-2"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label>
            {tr.t('export.totp')}
            <input
              className="border-border rounded-control bg-surface text-text block w-full border px-3 py-2"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              required
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
            />
          </label>
          <button className="btn-primary" disabled={pending} type="submit">
            {tr.t('export.grant')}
          </button>
          <button className="btn-secondary" disabled={pending} type="button" onClick={closeDialog}>
            {tr.t('export.cancel')}
          </button>
        </form>
      </dialog>
      <label>
        {tr.t('export.passphrase')}
        <input
          className="border-border rounded-control bg-surface text-text block w-full border px-3 py-2"
          type="password"
          autoComplete="off"
          maxLength={256}
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          disabled={pending}
        />
      </label>
      <label>
        {tr.t('export.confirmation')}
        <input
          className="border-border rounded-control bg-surface text-text block w-full border px-3 py-2"
          type="password"
          autoComplete="off"
          maxLength={256}
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          disabled={pending}
        />
      </label>
      <label>
        <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} disabled={pending} />
        {tr.t('export.include')}
      </label>
      <button
        className="btn-primary"
        type="button"
        disabled={pending || !authorized}
        onClick={() => {
          void work(async (signal) => {
            const envelope = await api.call('exportData', {
              body: { passphrase, passphraseConfirmation: confirmation, includeViewCredentials: include },
              userActivity: true,
              signal,
            });
            const url = URL.createObjectURL(new Blob([JSON.stringify(envelope)], { type: 'application/json' }));
            urls.current.add(url);
            const a = document.createElement('a');
            a.href = url;
            a.download = `lightning-pilot-export-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            setTimeout(() => {
              URL.revokeObjectURL(url);
              urls.current.delete(url);
            }, 1000);
            setMessage(tr.t('export.ready'));
          });
        }}
      >
        {tr.t('export.download')}
      </button>
      <label>
        {tr.t('export.file')}
        <input
          className="border-border rounded-control bg-surface text-text block w-full border px-3 py-2"
          ref={input}
          type="file"
          accept=".json,application/json"
          disabled={pending}
          onChange={(e) => {
            const candidate = e.target.files?.[0];
            if (candidate && candidate.size > EXPORT_FILE_BYTES) {
              setFile(undefined);
              e.target.value = '';
              setFailed(true);
              setMessage(tr.t('export.invalidFile'));
            } else setFile(candidate);
          }}
        />
      </label>
      <button
        className="btn-primary"
        type="button"
        disabled={pending || !authorized || !file}
        onClick={() => {
          void work(async (signal) => {
            if (!file || file.size > EXPORT_FILE_BYTES) throw new Error('invalid file');
            let envelope: unknown;
            try {
              envelope = JSON.parse(await file.text());
            } catch {
              throw new Error('invalid file');
            }
            const validated = ExportEnvelope.safeParse(envelope);
            if (!validated.success) throw new Error('invalid file');
            const result = await api.call('importData', {
              body: { passphrase, envelope: validated.data },
              userActivity: true,
              signal,
            });
            await queries.invalidateQueries();
            setMessage(`${tr.t('export.success')} ${result.warnings.join(' ')}`);
          });
        }}
      >
        {tr.t('export.import')}
      </button>
      {pending && !authOpen ? <p role="status">{tr.t('export.pending')}</p> : null}
      {message && !authOpen ? <p role={failed ? 'alert' : 'status'}>{message}</p> : null}
    </main>
  );
}
