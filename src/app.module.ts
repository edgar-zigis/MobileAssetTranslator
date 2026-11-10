import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { join } from 'node:path';
import { TranslateCommand } from './cli/translate.command.js';
import { validateEnv } from './config/env.validation.js';
import { FormatsService } from './formats/formats.service.js';
import { OutputService } from './output/output.service.js';
import { GeminiClient } from './translation/gemini.client.js';
import { LlmClient } from './translation/llm-client.js';
import { TranslatePipeline } from './translation/translate.pipeline.js';
import { TranslationService } from './translation/translation.service.js';

/** The tool's own folder (one level above dist/), so `.env` is found even after `npm link`. */
const TOOL_ROOT = join(import.meta.dirname, '..');

@Module({
  providers: [FormatsService, OutputService],
  exports: [FormatsService, OutputService],
})
export class FormatsModule {}

@Module({
  imports: [FormatsModule],
  providers: [{ provide: LlmClient, useClass: GeminiClient }, TranslationService, TranslatePipeline],
  exports: [TranslatePipeline],
})
export class TranslationModule {}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // The first file that defines a variable wins: the current folder, then the tool's folder.
      envFilePath: [join(process.cwd(), '.env'), join(TOOL_ROOT, '.env')],
      validate: validateEnv,
    }),
    TranslationModule,
  ],
  providers: [TranslateCommand],
})
export class AppModule {}
