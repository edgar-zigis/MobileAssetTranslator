# Mobile Asset Translator

A local command-line tool, built with Nest.js, that translates mobile app strings with Gemini.

You give it one iOS `.strings` file or one Android `strings.xml` file and its language. It writes **both** iOS and Android files for every target language you ask for.

```
mobile-translate en.lproj/Localizable.strings --from en --to de,fr,lt
```

```
Source  Localizable.strings (iOS, en) · 1,248 strings · 36 plurals
Model   gemini-3.8-flash · thinking low · concurrency 3
Output  /path/to/output

de ██████████████████░░░░░░  912/1284  chunk 19/27 · ETA 0:41
fr ████████░░░░░░░░░░░░░░░░  410/1284  chunk 9/27 · ETA 1:52
lt ░░░░░░░░░░░░░░░░░░░░░░░░    0/1284  queued
```

## Setup

You need Node.js 22.12 or newer and a Gemini API key.

```bash
npm install
```

```bash
cp .env.example .env
```

Put your key in `.env`:

```
GEMINI_API_KEY=your-key
GEMINI_MODEL=gemini-3.8-flash      # optional
GEMINI_THINKING_LEVEL=low          # optional: low | medium | high
```

Build the tool, then optionally link it so `mobile-translate` works from any folder:

```bash
npm run build
```

```bash
npm link
```

`.env` is read from the folder you run the command in first, then from the tool's own folder.

## Usage

```bash
mobile-translate <file> --from <code> --to <codes> [options]
```

Without `npm link`, use `npm run translate -- <file> --from en --to de`. This rebuilds the tool first.

| Option | Description |
|---|---|
| `-f, --from <code>` | Language of the input file, e.g. `en` (required) |
| `-t, --to <codes>` | Comma-separated target languages, e.g. `de,fr,pt-BR,zh-Hans` (required) |
| `-o, --out <dir>` | Output folder (default `./output`) |
| `-c, --context <text>` | What the app is about, its tone or audience; added to every request |
| `-g, --glossary <file>` | Terms to keep or to translate a fixed way (see below) |
| `--force` | Translate everything again, ignoring existing output |
| `--dry-run` | Parse and plan only: shows how many entries and chunks each language needs. Makes no API calls, writes nothing and needs no key |
| `--concurrency <n>` | Requests in flight at once (default 3) |
| `--chunk-size <n>` | Most entries per request (default 60) |
| `--chunk-chars <n>` | Most source characters per request (default 6000) |

The input type comes from the file extension: `.strings` means iOS and `.xml` means Android. For an iOS input, a `.stringsdict` with the same name next to it (for example `Localizable.stringsdict`) is read too, for plurals.

### Output

```
output/
  ios/de.lproj/Localizable.strings
  ios/de.lproj/Localizable.stringsdict      (only when there are plurals)
  android/values-de/strings.xml
  android/values-pt-rBR/strings.xml
  android/values-b+zh+Hans/strings.xml
  android/values/strings.xml                (source language, when the input was iOS)
  ios/en.lproj/Localizable.strings          (source language, when the input was Android)
  .translation-state.json
```

Copy the folders into your Xcode and Android projects as they are.

### Glossary

```json
{
  "doNotTranslate": ["Acme", "Pro"],
  "terms": {
    "de": { "workout": "Training" },
    "lt": { "workout": "treniruotė" }
  }
}
```

Terms listed under a language (`pt`) also apply to its regional variants (`pt-BR`).

## How it works

**One model for both platforms.** Both parsers turn their file into the same list of entries: strings, plurals and arrays. Both writers render from that list. So either input produces both outputs.

- Comments and section markers (`// MARK: - Settings`, `<!-- Settings -->`) are kept.
- Android `translatable="false"` entries are left out of translated Android files (Android falls back to `values/`) and copied unchanged into iOS files.
- Android `<string-array>` becomes `key_0`, `key_1`, … on iOS.
- iOS keys become valid Android resource names: `login.button` becomes `login_button`.

**Placeholders and markup.** Before text is sent, placeholders and inline markup are replaced with tokens such as `{{0}}`, and they are put back afterwards. This covers `%@`, `%1$s`, `%ld`, `%.2f` and `%%`, and tags such as `<b>` and `<xliff:g>`.
- The model never sees platform syntax.
- Each translation is checked to still contain exactly the same tokens.
- Strings with two or more placeholders get positions (`%1$@`, `%2$d`) so a translation can reorder them.
- Spelling is converted per platform: `%@` ↔ `%s`, and `%ld` becomes `%d` on Android.

**Chunking.** Large files are split into requests of at most 60 entries or about 6,000 characters.
- A whole entry is always the unit, so a string, a plural with all its forms, or an array with all its items is never split.
- Chunks follow file order.
- Once a chunk is at least 75% full, it ends early where a new section starts.
- Every chunk gets the same instructions, app context and glossary, so terms stay consistent across chunks.

**Plurals.** The model is asked for exactly the plural categories the target language uses. For example, Lithuanian needs `one`, `few`, `many` and `other`. The tool writes them as Android `<plurals>` and as an iOS `.stringsdict`.

**Checks and retries.**
- Failed calls are retried with backoff: rate limits (429), server errors (5xx) and timeouts.
- Entries whose translation is missing or lost a placeholder are sent again on their own, up to two more times.
- Entries that still fail are reported and left out. The next run picks them up.
- A bad API key or unknown model stops the run straight away.

**Re-runs.** `.translation-state.json` remembers which source text each translation was made from.
- A re-run only sends keys that are new or whose source text changed.
- Translations you edited by hand in the output files are kept. If the iOS and Android files disagree, the more recently modified one wins.
- Progress is saved after every chunk. If you press Ctrl+C (or the run fails), finished work is written to the output files, and the next run continues from there.

**Exit codes:** `0` everything worked, `2` some entries failed, `130` stopped with Ctrl+C, `1` error.

## Development

```bash
npm test
```

```bash
npm run typecheck
```

- The tests cover the parsers and writers (with round trips, and `plutil`/`xmllint` checks when those tools are installed), placeholders, chunking, the translation service, and the whole pipeline with a fake model.
- The project is ESM because Nest 12 is ESM-only. Tests use vitest.

## Not supported yet

- Xcode String Catalogs (`.xcstrings`).
- `.stringsdict` keys with more than one plural variable. These are skipped with a warning.
- Android resources other than `<string>`, `<plurals>` and `<string-array>`. These are skipped with a warning.
