import { z } from 'zod';

const EnvSchema = z.object({
  GEMINI_API_KEY: z.string().trim().optional(),
  GEMINI_MODEL: z.string().trim().min(1).default('gemini-3.8-flash'),
  GEMINI_THINKING_LEVEL: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(
      z.enum(['low', 'medium', 'high'], {
        error: 'must be low, medium or high (gemini-3.8-flash does not support minimal)',
      }),
    )
    .default('low'),
});

export type Env = z.infer<typeof EnvSchema>;

/** Used by ConfigModule. The API key is checked later, so `--dry-run` works without one. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const cleaned = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid .env: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}
