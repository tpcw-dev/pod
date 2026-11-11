export interface Checkout {
  repo: string;
  branch: string | null;
  tip: string | null;
}

export type GitWrite = { ok: true } | { ok: false; reason: string };

export interface GitPort {
  checkout(path: string): Promise<Checkout | null>;
  integration(repo: string): Promise<string | null>;
  fetch(repo: string): Promise<boolean>;
  localTip(repo: string, branch: string): Promise<string | null>;
  remoteTip(repo: string, branch: string): Promise<string | null>;
  checkedOut(repo: string): Promise<Map<string, string> | null>;
  deleteLocal(repo: string, branch: string, sha: string): Promise<GitWrite>;
  deleteRemote(repo: string, branch: string, sha: string): Promise<GitWrite>;
}
