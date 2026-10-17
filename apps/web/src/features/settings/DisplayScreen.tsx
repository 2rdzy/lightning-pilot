// Settings › Display (route map /settings/display, both views; style guide §6a): the view, the theme and the region
// whose number and date format the app uses. All three are kept per device in the browser. Units, fiat and the
// interface language are not settings in release 0.1 (amounts in sats, English only).
import { Card, Field, SegmentedControl } from '@lightning-pilot/ui';
import { useId } from 'react';
import { useT } from '../../app/i18n.tsx';
import { browserLocale, formatDateTime } from '../../i18n/format.ts';
import { usePreferences } from '../../shell/preferences-context.tsx';
import { REGIONS, THEME_CHOICES, VIEWS, type ThemeChoice, type View } from '../../shell/preferences.ts';
import { regionName, regionSample } from './data.ts';
import { SettingsPage } from './parts.tsx';

const SAMPLE_TIME = '2026-10-12T14:30:00.000Z';

export function DisplayScreen() {
  const tr = useT();
  const id = useId();
  const { view, setView, theme, setTheme, region, setRegion } = usePreferences();
  const detected = browserLocale(globalThis.navigator?.languages);
  const sample = regionSample(tr.locale);
  return (
    <SettingsPage title={tr.t('settings.display.title')} intro={tr.t('settings.display.intro')}>
      <Card title={tr.t('settings.display.viewTitle')}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{tr.t('settings.display.viewNote')}</p>
          <SegmentedControl<View>
            label={tr.t('view.label')}
            value={view}
            onChange={setView}
            options={VIEWS.map((v) => ({ value: v, label: tr.t(`view.${v}`) }))}
            testId="display-view"
          />
          <SegmentedControl<ThemeChoice>
            label={tr.t('theme.label')}
            value={theme}
            onChange={setTheme}
            options={THEME_CHOICES.map((t) => ({ value: t, label: tr.t(`theme.${t}`) }))}
            testId="display-theme"
          />
        </div>
      </Card>
      <Card title={tr.t('settings.display.formatTitle')}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{tr.t('settings.display.formatNote')}</p>
          <Field label={tr.t('settings.display.region')} htmlFor={`${id}-region`}>
            <select
              id={`${id}-region`}
              className="input"
              value={region ?? ''}
              onChange={(e) => setRegion(e.target.value === '' ? undefined : e.target.value)}
              data-testid="display-region"
            >
              <option value="">{tr.t('settings.display.browserRegion', { region: regionName(detected) })}</option>
              {REGIONS.map((r) => (
                <option key={r} value={r}>
                  {regionName(r)}
                </option>
              ))}
            </select>
          </Field>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid="display-sample">
            <dt className="text-muted">{tr.t('settings.display.sampleSats')}</dt>
            <dd className="tabular-nums">{tr.t('amount.sat', { amount: sample.sats })}</dd>
            <dt className="text-muted">{tr.t('settings.display.sampleCoins')}</dt>
            <dd className="tabular-nums">{sample.coins}</dd>
            <dt className="text-muted">{tr.t('settings.display.sampleDate')}</dt>
            <dd>{formatDateTime(SAMPLE_TIME, tr.locale)}</dd>
          </dl>
          <p className="text-sm text-muted">{tr.t('settings.display.notSettings')}</p>
        </div>
      </Card>
    </SettingsPage>
  );
}
