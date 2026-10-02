'use client';

import { Check, X } from 'lucide-react';
import type { AgentCapability } from '@archivist/shared';
import { Button } from '@/components/ui/button';

const ADAPTER_LABEL: Record<AgentCapability['adapter'], string> = { anthropic: 'Claude (Anthropic)', openai: 'OpenAI-kompatibel' };

export function adapterLabel(adapter: AgentCapability['adapter']): string {
  return ADAPTER_LABEL[adapter];
}

function YesNo({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      {ok ? <Check className="size-3.5 text-success" aria-hidden /> : <X className="size-3.5 text-destructive" aria-hidden />}
      <span className="sr-only">{ok ? 'ja' : 'nein'}</span>
    </span>
  );
}

/** Agent capability of a connection test (#296): adapter, tool calling, streaming, hint and the suggested endpoint. */
export function AgentCapabilityNote({
  capability,
  onApplyBaseUrl,
  applyLabel = 'Anthropic-Endpunkt übernehmen',
  testId = 'agent-capability',
}: {
  capability: AgentCapability;
  onApplyBaseUrl?: (url: string) => void;
  applyLabel?: string;
  testId?: string;
}) {
  return (
    <div className="mt-2 flex flex-col gap-1 text-xs" data-testid={testId}>
      <p className="flex flex-wrap items-center gap-x-2">
        <span>Agentenmodus: {adapterLabel(capability.adapter)} –</span>
        <YesNo ok={capability.toolCalling} label="Werkzeuge" />
        <span aria-hidden>,</span>
        <YesNo ok={capability.streaming} label="Streaming" />
      </p>
      {capability.message && <p>{capability.message}</p>}
      {capability.suggestedBaseUrl && (
        <div className="flex flex-wrap items-center gap-2">
          <code className="break-all rounded bg-muted px-1 py-0.5">{capability.suggestedBaseUrl}</code>
          {onApplyBaseUrl && (
            <Button size="sm" variant="outline" onClick={() => onApplyBaseUrl(capability.suggestedBaseUrl!)} data-testid={`${testId}-apply`}>
              {applyLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
