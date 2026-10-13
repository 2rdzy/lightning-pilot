// Message helper (architecture §13, style guide §1.5): every visible text is a key in a per-feature message file
// (`features/<feature>/messages.en.json`); placeholders are `{name}`; plurals are separate keys ending in `.one`,
// `.other` (and the other Intl.PluralRules categories when a language needs them). No sentence is ever built by
// joining strings. Written here rather than taken from a library: it is about 50 lines and needs nothing but Intl.

export type Messages = Readonly<Record<string, string>>;
export type Params = Readonly<Record<string, string | number>>;

// Merges message files; two files defining the same key is a mistake, found at start-up and by the tests.
export function mergeMessages(...files: Messages[]): Messages {
  const all: Record<string, string> = {};
  for (const file of files) {
    for (const [key, text] of Object.entries(file)) {
      if (key in all) throw new Error(`message key defined twice: ${key}`);
      all[key] = text;
    }
  }
  return all;
}

// Fills `{name}` placeholders. A placeholder without a value stays visible, so a missing value is noticed instead
// of silently producing a broken sentence.
export function fill(text: string, params: Params = {}): string {
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

export interface Translator {
  readonly locale: string;
  t(key: string, params?: Params): string;
  // Plural form for `count`: looks up `<key>.<category>`, falling back to `<key>.other`.
  plural(key: string, count: number, params?: Params): string;
  has(key: string): boolean;
}

export function createTranslator(messages: Messages, locale: string): Translator {
  const rules = new Intl.PluralRules(locale);
  const lookup = (key: string) => messages[key];
  return {
    locale,
    t: (key, params) => {
      const text = lookup(key);
      // The key itself is shown when a message is missing: visible in development, and never a crash.
      return text === undefined ? key : fill(text, params);
    },
    plural: (key, count, params) => {
      const text = lookup(`${key}.${rules.select(count)}`) ?? lookup(`${key}.other`);
      return text === undefined ? key : fill(text, { count, ...params });
    },
    has: (key) => lookup(key) !== undefined,
  };
}
