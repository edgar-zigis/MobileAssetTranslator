import type { Glossary } from '../config/glossary.js';
import { termsFor } from '../config/glossary.js';
import type { PluralCategory } from '../core/entry.model.js';
import { PLURAL_CATEGORIES } from '../core/entry.model.js';
import { languageName } from '../core/locale.js';
import type { WorkItem } from './work-item.js';

export interface PromptContext {
  source: string;
  target: string;
  targetPlurals: PluralCategory[];
  appContext?: string;
  glossary?: Glossary;
}

export function systemInstruction(ctx: PromptContext): string {
  const from = `${languageName(ctx.source)} (${ctx.source})`;
  const to = `${languageName(ctx.target)} (${ctx.target})`;
  const fromName = languageName(ctx.source);
  const toName = languageName(ctx.target);
  const lines = [
    `You are an expert language translator. You are localizing the user interface of a mobile app from ${from} to ${to}.`,
    '',
    `This is not a literal translation. Rewrite each string so it sounds fluent, natural and persuasive to native ${toName} speakers, while accurately reflecting the tone, intent and meaning of the original.`,
    '',
    'Style guidelines:',
    '- Always translate the full sentence or phrase as a single unit.',
    `- Avoid literal translations and grammar structures carried over from ${fromName}.`,
    '- Avoid exaggeration, euphemisms or embellishments that are not in the original.',
    `- Use idiomatic, culturally appropriate expressions typical of native ${toName} content.`,
    `- Follow ${toName} capitalization rules. Do not capitalize every word in titles, headings or buttons unless ${toName} grammar requires it.`,
    '- Prioritize clarity, natural flow and faithfulness to the meaning.',
    `- Do not use AI-like dashes: no em dashes (—) or spaced dashes to join clauses. Use the punctuation a native writer would use, such as a comma, colon or period, unless ${toName} grammar requires a dash.`,
    `- Use ${toName} punctuation, quotation marks and typographic conventions.`,
    '- Keep the text concise enough for mobile UI: buttons, labels, titles, alerts.',
    '',
    'The input is a JSON array. Each item has an "id" and exactly one of:',
    '- "text": one string,',
    '- "forms": the plural forms of one string, keyed by CLDR plural category,',
    '- "items": a list of strings.',
    'An item may also have "key" (the developer\'s identifier) and "note" (a developer comment). Use them only as context; never translate them.',
    '',
    'Rules that must always hold:',
    '1. Return every id exactly once, in the same shape: "text" for text, "forms" for forms, and "items" with the same number of strings for items.',
    `2. Tokens such as {{0}} stand for placeholders or markup. Keep every token exactly as written and the same number of times. You may move a token to fit ${toName} grammar. Never add, drop, translate or renumber tokens.`,
    `3. For "forms", return exactly these ${toName} categories: ${ctx.targetPlurals.join(', ')}. Every form must contain all the tokens of the source "other" form, because a category such as "one" can also cover numbers other than 1.`,
    '4. Keep line breaks (\\n) and any leading or trailing spaces.',
    '5. Keep brand names, product names, URLs, e-mail addresses and code-like strings unchanged.',
    '6. Translate empty strings as empty strings.',
  ];
  let rule = 7;
  const doNotTranslate = ctx.glossary?.doNotTranslate ?? [];
  if (doNotTranslate.length) lines.push(`${rule++}. Never translate these terms: ${doNotTranslate.map((t) => JSON.stringify(t)).join(', ')}.`);
  const terms = Object.entries(termsFor(ctx.glossary, ctx.target));
  if (terms.length) {
    lines.push(`${rule++}. Always translate these terms this way:`);
    for (const [term, translation] of terms) lines.push(`   ${JSON.stringify(term)} → ${JSON.stringify(translation)}`);
  }
  if (ctx.appContext?.trim()) lines.push('', `About the app: ${ctx.appContext.trim()}`);
  return lines.join('\n');
}

/** The user message: the chunk as JSON, with short ids `"1"`, `"2"`, … */
export function userPrompt(items: WorkItem[]): string {
  return JSON.stringify(items.map((item, i) => ({ id: String(i + 1), ...item.payload })), null, 1);
}

const formProperties = Object.fromEntries(PLURAL_CATEGORIES.map((c) => [c, { type: 'string' }]));

export const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          forms: { type: 'object', properties: formProperties },
          items: { type: 'array', items: { type: 'string' } },
        },
        required: ['id'],
      },
    },
  },
  required: ['translations'],
};
