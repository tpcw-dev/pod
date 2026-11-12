import { z } from "zod";

export function pathSegment(value: string): boolean {
  return (
    value !== "" && value !== "." && value !== ".." && !/[/\\\0]/.test(value)
  );
}

const TranscriptLocator = z.object({
  harness: z.string().min(1),
  session_id: z.string(),
});
export type TranscriptLocator = z.infer<typeof TranscriptLocator>;

const Receipt = z.looseObject({
  agent: z.string().min(1),
  sessionId: z.string().refine(pathSegment),
});

export function withTranscript(effective: unknown): unknown {
  const parsed = Receipt.safeParse(effective);
  if (!parsed.success) return effective;
  const { agent, sessionId } = parsed.data;
  return {
    ...parsed.data,
    transcript: { harness: agent, session_id: sessionId },
  };
}

const Stored = z.looseObject({ transcript: TranscriptLocator });

export function storedLocator(
  effectiveLaunch: unknown,
): TranscriptLocator | null {
  return Stored.safeParse(effectiveLaunch).data?.transcript ?? null;
}

export const sessionToken = "{session_id}";

export function transcriptPath(
  templates: Readonly<Record<string, string>>,
  locator: TranscriptLocator,
): string | null {
  if (!Object.hasOwn(templates, locator.harness)) return null;
  const template = templates[locator.harness];
  if (template === undefined || !pathSegment(locator.session_id)) return null;
  return template.replaceAll(sessionToken, locator.session_id);
}
