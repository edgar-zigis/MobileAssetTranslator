import { Injectable } from '@nestjs/common';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { Platform, ResourceDocument } from '../core/entry.model.js';
import { readAndroidDocument } from './android/android.format.js';
import { readIosDocument } from './ios/ios.format.js';

export class UnsupportedFileError extends Error {}

/** `.strings` → iOS, `.xml` → Android. */
export function detectPlatform(path: string): Platform {
  const ext = extname(path).toLowerCase();
  if (ext === '.strings') return 'ios';
  if (ext === '.xml') return 'android';
  throw new UnsupportedFileError(
    `Unsupported file "${basename(path)}": expected an iOS .strings file or an Android .xml file.`,
  );
}

@Injectable()
export class FormatsService {
  /** Reads the source file. For iOS, a sibling `.stringsdict` with the same name is read too. */
  async readSource(path: string): Promise<ResourceDocument> {
    const platform = detectPlatform(path);
    const base = basename(path, extname(path));
    if (platform === 'android') return readAndroidDocument(await readFile(path, 'utf8'), base);
    const stringsdictPath = join(dirname(path), `${base}.stringsdict`);
    const stringsdict = (await exists(stringsdictPath)) ? await readFile(stringsdictPath) : undefined;
    return readIosDocument(await readFile(path), stringsdict, base);
  }

  /** Reads an existing iOS output (`.strings` and/or `.stringsdict`); undefined if neither exists. */
  async readIos(stringsPath: string, stringsdictPath: string): Promise<ResourceDocument | undefined> {
    const [strings, dict] = await Promise.all([readIfExists(stringsPath), readIfExists(stringsdictPath)]);
    if (!strings && !dict) return undefined;
    return readIosDocument(strings ?? Buffer.alloc(0), dict, basename(stringsPath, '.strings'));
  }

  async readAndroid(xmlPath: string): Promise<ResourceDocument | undefined> {
    const xml = await readIfExists(xmlPath);
    return xml ? readAndroidDocument(xml.toString('utf8'), basename(xmlPath, '.xml')) : undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readIfExists(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}
