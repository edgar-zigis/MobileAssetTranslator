import { describe, expect, it } from 'vitest';
import { systemInstruction } from './prompt.builder.js';

describe('systemInstruction', () => {
  const prompt = systemInstruction({
    source: 'en',
    target: 'lt',
    targetPlurals: ['one', 'few', 'many', 'other'],
    appContext: 'Photo sharing app',
    glossary: { doNotTranslate: ['Acme'], terms: { lt: { photo: 'nuotrauka' } } },
  });

  it('asks for a fluent, non-literal rewrite in the target language', () => {
    expect(prompt).toContain('This is not a literal translation.');
    expect(prompt).toContain('native Lithuanian speakers');
    expect(prompt).toContain('grammar structures carried over from English');
    expect(prompt).toContain('Follow Lithuanian capitalization rules.');
    expect(prompt).toContain('no em dashes (—)');
    expect(prompt).not.toContain('capitalization style of the source');
  });

  it('keeps the structural rules, plural categories, glossary and context', () => {
    expect(prompt).toContain('categories: one, few, many, other.');
    expect(prompt).toContain('Keep every token exactly as written');
    expect(prompt).toContain('7. Never translate these terms: "Acme".');
    expect(prompt).toContain('8. Always translate these terms this way:');
    expect(prompt).toContain('"photo" → "nuotrauka"');
    expect(prompt).toContain('About the app: Photo sharing app');
  });
});
