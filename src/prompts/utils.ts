export interface PromptLines {
  system: string[];
  user: string[];
}

export interface PromptOverrides {
  system?: string[];
  user?: string[];
}

const sanitize = (lines: Array<string | undefined>): string[] =>
  lines.filter((line): line is string => typeof line === 'string');

const sanitizeOverrides = (lines?: string[]): string[] =>
  Array.isArray(lines) ? sanitize(lines) : [];

export function mergePromptSections(base: PromptLines, overrides?: PromptOverrides): PromptLines {
  const system = sanitize([
    ...sanitizeOverrides(overrides?.system),
    ...base.system
  ]);
  const user = sanitize([
    ...sanitizeOverrides(overrides?.user),
    ...base.user
  ]);
  return { system, user };
}

export function finalizePromptSections(lines: PromptLines): { system: string; user: string } {
  return {
    system: lines.system.join('\n'),
    user: lines.user.join('\n\n')
  };
}
