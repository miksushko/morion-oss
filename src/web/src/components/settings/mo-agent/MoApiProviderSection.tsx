import { MoProviderKeySection } from '../../MoProviderKeySection';
import { PipelineModelsSection } from './PipelineModelsSection';

export function MoApiProviderSection() {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          API &amp; Provider
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          The backend / model / API key Mo uses for chat, gather, and tool
          calls. Today every user supplies their own key.
        </p>
      </div>
      <MoProviderKeySection compact />
      <PipelineModelsSection />
    </section>
  );
}
