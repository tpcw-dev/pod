export interface Hit {
  path: string;
  line: number;
  text: string;
}

export type CheckState = "passes" | "fails" | "missing" | "writes" | "timeout";

export interface CheckRun {
  command: string;
  state: CheckState;
  exit: number | null;
}

export type GrepPattern = { word: string } | { fixed: string };

export interface RepoReader {
  resolve(repo: string, ref: string): Promise<string | null>;
  grep(
    repo: string,
    sha: string,
    under: readonly string[],
    pattern: GrepPattern,
  ): Promise<Hit[]>;
  show(repo: string, sha: string, path: string): Promise<string | null>;
  exists(repo: string, sha: string, path: string): Promise<boolean>;
  runCheck(
    repo: string,
    sha: string,
    command: string,
    timeoutMs: number,
  ): Promise<CheckRun>;
}
