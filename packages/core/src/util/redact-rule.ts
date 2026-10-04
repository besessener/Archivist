export interface RedactionRule {
  kind: string;
  pattern: RegExp;
  /** Replacement; $1.. may be referenced. Returning the match itself leaves the text as it is (and counts nothing). */
  replace: (match: string, ...groups: string[]) => string;
}

export interface RuleRun {
  text: string;
  count: number;
  kinds: string[];
}

/** Applies the rules one after the other; every spot a rule actually changed counts once. */
export function applyRules(input: string, rules: RedactionRule[]): RuleRun {
  let text = input;
  let count = 0;
  const kinds = new Set<string>();
  for (const rule of rules) {
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      const [match, ...rest] = args.slice(0, -2).map(String) as [string, ...string[]];
      const replacement = rule.replace(match, ...rest);
      if (replacement === match) return match;
      count += 1;
      kinds.add(rule.kind);
      return replacement;
    });
  }
  return { text, count, kinds: [...kinds] };
}
