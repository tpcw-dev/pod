export type DecisionScope =
  | { kind: "global" }
  | { kind: "project"; ref: string }
  | { kind: "story"; ref: string };

export interface Decision {
  id: string;
  scope: DecisionScope;
  question: string;
  outcome: string;
  decided_at: Date;
  in_force_until: Date | null;
  standing: boolean;
}
