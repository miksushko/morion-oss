import type { HygieneMergeProposal, MergeBundle } from './types.js';

/**
 * Group merge-pair proposals into transitive bundles. If proposer
 * emits {A→C} and {B→C}, the user shouldn't be asked twice — the
 * bundle is {A, B, C} with `C` recommended as main (it's the most
 * frequent target). Single click "Use C as main" merges A and B
 * into C; "Use A as main" merges B and C into A; etc.
 *
 * Algorithm: build an undirected graph over (source, target) edges
 * via union-find, then for each connected component collect topics
 * + recommended main (target appearing most often as a `target` in
 * the component's edges, ties broken by alphabetical for
 * determinism).
 *
 * Pure function — exported for tests.
 */
export function bundleMergeProposals(
  merges: HygieneMergeProposal[],
): MergeBundle[] {
  if (merges.length === 0) return [];

  // Union-find over topic ids (both source and target sides).
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let cur = x;
    while (parent.get(cur) !== cur) {
      const p = parent.get(cur)!;
      parent.set(cur, parent.get(p)!);
      cur = parent.get(cur)!;
    }
    return cur;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const m of merges) {
    if (!parent.has(m.source)) parent.set(m.source, m.source);
    if (!parent.has(m.target)) parent.set(m.target, m.target);
    union(m.source, m.target);
  }

  const componentTopics = new Map<string, Set<string>>();
  const componentProposals = new Map<string, HygieneMergeProposal[]>();
  for (const m of merges) {
    const root = find(m.source);
    if (!componentTopics.has(root)) {
      componentTopics.set(root, new Set());
      componentProposals.set(root, []);
    }
    componentTopics.get(root)!.add(m.source);
    componentTopics.get(root)!.add(m.target);
    componentProposals.get(root)!.push(m);
  }

  const bundles: MergeBundle[] = [];
  for (const [root, topicSet] of componentTopics) {
    const props = componentProposals.get(root)!;
    // Recommended main = target appearing most as `target` in this
    // component's edges; ties broken by lexicographic order so the
    // pick is stable across runs.
    const targetCount = new Map<string, number>();
    for (const p of props) {
      targetCount.set(p.target, (targetCount.get(p.target) ?? 0) + 1);
    }
    const topics = Array.from(topicSet).sort();
    let recommendedMain = topics[0]!;
    let bestCount = -1;
    for (const t of topics) {
      const c = targetCount.get(t) ?? 0;
      if (c > bestCount || (c === bestCount && t < recommendedMain)) {
        bestCount = c;
        recommendedMain = t;
      }
    }
    const confidence =
      props.reduce((sum, p) => sum + p.confidence, 0) / props.length;
    const reasoning = Array.from(new Set(props.map((p) => p.reason).filter((r) => r.length > 0))).join(' · ');

    bundles.push({
      topics,
      recommendedMain,
      proposals: props,
      confidence,
      reasoning,
    });
  }

  // Sort bundles by topic count desc (biggest bundles first), then
  // by recommendedMain alpha for stability.
  bundles.sort((a, b) => {
    if (b.topics.length !== a.topics.length) return b.topics.length - a.topics.length;
    return a.recommendedMain.localeCompare(b.recommendedMain);
  });
  return bundles;
}
