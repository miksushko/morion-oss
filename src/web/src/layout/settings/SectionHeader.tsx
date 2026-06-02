
export function SectionHeader({ title, blurb }: { title: string; blurb: string }) {
  return (
    <header className="mb-3">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="text-xs text-muted-foreground">{blurb}</p>
    </header>
  );
}
