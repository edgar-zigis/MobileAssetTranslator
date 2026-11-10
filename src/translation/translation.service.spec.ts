import { describe, expect, it } from 'vitest';
import type { Entry } from '../core/entry.model.js';
import { FatalLlmError, LlmClient, type LlmRequest, type LlmResponse } from './llm-client.js';
import type { PromptContext } from './prompt.builder.js';
import { TranslationService } from './translation.service.js';
import { buildWorkItem } from './work-item.js';

type Item = { id: string; text?: string; forms?: Record<string, string>; items?: string[] };

/** Fake model: answers with a function of the request items, one call at a time. */
class FakeLlm extends LlmClient {
  readonly description = 'fake';
  calls: Item[][] = [];
  constructor(private readonly answer: (items: Item[], call: number) => string) {
    super();
  }
  ensureReady(): void {}
  async generate(request: LlmRequest): Promise<LlmResponse> {
    const items = JSON.parse(request.prompt) as Item[];
    this.calls.push(items);
    return { text: this.answer(items, this.calls.length), usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

const shout = (s: string) => s.replace(/[a-z]+/g, (w) => w.toUpperCase());
const translateAll = (items: Item[]) =>
  JSON.stringify({
    translations: items.map((i) => ({
      id: i.id,
      ...(i.text !== undefined ? { text: shout(i.text) } : {}),
      ...(i.forms ? { forms: { one: shout(i.forms.other!), few: shout(i.forms.other!), many: shout(i.forms.other!), other: shout(i.forms.other!) } } : {}),
      ...(i.items ? { items: i.items.map(shout) } : {}),
    })),
  });

const ctx: PromptContext = { source: 'en', target: 'lt', targetPlurals: ['one', 'few', 'many', 'other'] };
const str = (key: string, value: string): Entry => ({ kind: 'string', key, value, translatable: true });

describe('TranslationService', () => {
  it('translates strings, plurals and arrays and restores placeholders', async () => {
    const llm = new FakeLlm(translateAll);
    const entries: Entry[] = [
      str('greet', '%@ sent %d photos'),
      { kind: 'plural', key: 'files', translatable: true, forms: { one: '%d file', other: '%d files' } },
      { kind: 'array', key: 'days', translatable: true, items: ['mon', 'tue'] },
    ];
    const result = await new TranslationService(llm).translateChunk(entries.map(buildWorkItem), ctx);
    expect(result.failed.size).toBe(0);
    expect(result.translated.get('greet')).toEqual({ kind: 'string', value: '%1$@ SENT %2$d PHOTOS' });
    expect(result.translated.get('files')).toEqual({
      kind: 'plural',
      forms: { one: '%d FILES', few: '%d FILES', many: '%d FILES', other: '%d FILES' },
    });
    expect(result.translated.get('days')).toEqual({ kind: 'array', items: ['MON', 'TUE'] });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('asks again only for entries that were missing or broke a placeholder', async () => {
    const llm = new FakeLlm((items, call) => {
      if (call > 1) return translateAll(items);
      const all = JSON.parse(translateAll(items)) as { translations: Item[] };
      all.translations = all.translations.filter((t) => t.id !== '2'); // drop "b"
      all.translations[1]!.text = 'NO TOKEN'; // break "c"
      return JSON.stringify(all);
    });
    const notices: string[] = [];
    const result = await new TranslationService(llm).translateChunk(
      [str('a', 'one'), str('b', 'two'), str('c', 'hi %@')].map(buildWorkItem),
      ctx,
      { onNotice: (m) => notices.push(m) },
    );
    expect(result.failed.size).toBe(0);
    expect(llm.calls[1]!.map((i) => i.text)).toEqual(['two', 'hi {{0}}']);
    expect(result.translated.get('c')).toEqual({ kind: 'string', value: 'HI %@' });
    expect(notices[0]).toMatch(/2 entries rejected/);
  });

  it('splits the retry when a whole response is unusable', async () => {
    const llm = new FakeLlm((items, call) => (call === 1 ? 'not json' : translateAll(items)));
    const result = await new TranslationService(llm).translateChunk(['a', 'b', 'c', 'd'].map((k) => buildWorkItem(str(k, k))), ctx);
    expect(result.failed.size).toBe(0);
    expect(llm.calls.map((c) => c.length)).toEqual([4, 2, 2]);
  });

  it('reports entries that keep failing', async () => {
    const llm = new FakeLlm((items) => JSON.stringify({ translations: items.map((i) => ({ id: i.id, text: 'lost' })) }));
    const result = await new TranslationService(llm).translateChunk([buildWorkItem(str('a', 'Hi %@'))], ctx);
    expect(result.translated.size).toBe(0);
    expect(result.failed.get('a')).toMatch(/placeholders/);
    expect(llm.calls).toHaveLength(3);
  });

  it('rejects plural answers that miss a category of the target language', async () => {
    const llm = new FakeLlm((items) =>
      JSON.stringify({ translations: items.map((i) => ({ id: i.id, forms: { one: '{{0}} x', other: '{{0}} y' } })) }),
    );
    const entry: Entry = { kind: 'plural', key: 'p', translatable: true, forms: { one: '%d a', other: '%d b' } };
    const result = await new TranslationService(llm).translateChunk([buildWorkItem(entry)], ctx);
    expect(result.failed.get('p')).toMatch(/"few" missing/);
  });

  it('lets fatal errors stop the run', async () => {
    const llm = new FakeLlm(() => {
      throw new FatalLlmError('bad key');
    });
    await expect(new TranslationService(llm).translateChunk([buildWorkItem(str('a', 'x'))], ctx)).rejects.toThrow('bad key');
  });
});
