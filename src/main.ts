#!/usr/bin/env node
import 'reflect-metadata';
import { CommandFactory } from 'nest-commander';
import pc from 'picocolors';

try {
  // Imported here so configuration errors (e.g. a bad .env value) are reported cleanly.
  const { AppModule } = await import('./app.module.js');
  await CommandFactory.run(AppModule, {
    cliName: 'mobile-translate',
    // Errors are printed below instead of through Nest's logger, without stack traces.
    logger: false,
    abortOnError: false,
    errorHandler: (err) => {
      // Commander already printed usage errors such as a missing --from.
      if (!/^commander\./.test((err as { code?: string }).code ?? '')) console.error(pc.red(`✖ ${err.message}`));
      process.exitCode = 1;
    },
  });
} catch (e) {
  console.error(pc.red(`✖ ${(e as Error).message}`));
  process.exitCode = 1;
}
