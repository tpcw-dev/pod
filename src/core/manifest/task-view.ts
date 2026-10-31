export const WORD_BUDGET = 2000;

export interface TaskViewDecision {
  text: string;
  expired: boolean;
  routing: string;
}

export interface TaskViewMilestone {
  text: string;
  current: boolean;
  routing: string;
}

export interface TaskViewSource {
  title: string;
  body: string;
  routing: string;
}

export interface TaskViewInput {
  gitStatus?: string;
  policies: readonly string[];
  reserved: readonly string[];
  decisions: readonly TaskViewDecision[];
  roadmap: readonly TaskViewMilestone[];
  sources: readonly TaskViewSource[];
}

export interface TaskView {
  text: string;
  words: number;
  truncated: boolean;
  routing: string[];
}

interface Block {
  body: string;
  routing: string;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  return trimmed.split(/\s+/).length;
}

function section(title: string, lines: readonly string[]): string {
  if (lines.length === 0) return title;
  return `${title}\n${lines.join("\n")}`;
}

function sourceBlock(source: TaskViewSource): string {
  if (source.body === "") return source.title;
  return `${source.title}\n${source.body}`;
}

function joinBlocks(blocks: readonly string[]): string {
  return blocks.filter((block) => block !== "").join("\n");
}

const testInstruction = [
  "Tests",
  "Run `pnpm test`, then run `timeout 60 pnpm test`. Deliver both as tests.",
].join("\n");

export function renderTaskView(input: TaskViewInput): TaskView {
  const prefixParts: string[] = [];
  if (input.gitStatus !== undefined) prefixParts.push(input.gitStatus);
  prefixParts.push(testInstruction);
  prefixParts.push(section("Policies", input.policies));
  prefixParts.push(section("Reserved categories", input.reserved));
  prefixParts.push(
    section(
      "Decisions",
      input.decisions.filter((item) => !item.expired).map((item) => item.text),
    ),
  );
  for (const item of input.roadmap) {
    if (item.current) prefixParts.push(item.text);
  }
  const prefix = joinBlocks(prefixParts);
  const trimmable: Block[] = [
    ...input.sources.map((source) => ({
      body: sourceBlock(source),
      routing: source.routing,
    })),
    ...input.roadmap
      .filter((item) => !item.current)
      .map((item) => ({ body: item.text, routing: item.routing })),
    ...input.decisions
      .filter((item) => item.expired)
      .map((item) => ({ body: item.text, routing: item.routing })),
  ];
  const kept = [...trimmable];
  const dropped: Block[] = [];
  const render = (): string =>
    joinBlocks([
      prefix,
      ...kept.map((item) => item.body),
      ...dropped.map((item) => item.routing),
    ]);
  let text = render();
  while (countWords(text) > WORD_BUDGET && kept.length > 0) {
    const last = kept.pop();
    if (last !== undefined) dropped.push(last);
    text = render();
  }
  return {
    text,
    words: countWords(text),
    truncated: dropped.length > 0,
    routing: dropped.map((item) => item.routing),
  };
}
