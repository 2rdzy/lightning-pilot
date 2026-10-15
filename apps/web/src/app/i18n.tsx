import exporting from '../features/export/messages.en.json' with { type: 'json' };
// The translator and the formatting region for the whole app, from React context.
import { createContext, useContext, type ReactNode } from 'react';
import { createTranslator, mergeMessages, type Translator } from '../i18n/messages.ts';
import app from './messages.en.json' with { type: 'json' };
import dashboard from '../features/dashboard/messages.en.json' with { type: 'json' };
import login from '../features/login/messages.en.json' with { type: 'json' };
import pay from '../features/pay/messages.en.json' with { type: 'json' };
import receive from '../features/receive/messages.en.json' with { type: 'json' };
import setup from '../features/setup/messages.en.json' with { type: 'json' };

// English only in release 0.1; every feature adds its own file here.
export const MESSAGES_EN = mergeMessages(app, setup, login, dashboard, receive, pay, exporting);

const TranslatorContext = createContext<Translator | undefined>(undefined);

export function TranslatorProvider({ translator, children }: { translator: Translator; children: ReactNode }) {
  return <TranslatorContext.Provider value={translator}>{children}</TranslatorContext.Provider>;
}

export function useT(): Translator {
  const translator = useContext(TranslatorContext);
  if (!translator) throw new Error('useT outside TranslatorProvider');
  return translator;
}

export { createTranslator };
