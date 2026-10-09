'use client';

import { Activity, Cpu, Loader2, Plug } from 'lucide-react';
import { JobsList } from '@/components/common/jobs-list';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useApp } from '@/lib/app-context';
import { cn } from '@/lib/utils';

function Dot({ tone }: { tone: 'ok' | 'warn' | 'error' | 'unknown' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-2 rounded-full',
        tone === 'ok' && 'bg-success',
        tone === 'warn' && 'bg-warning',
        tone === 'error' && 'bg-destructive',
        tone === 'unknown' && 'bg-muted-foreground/50',
      )}
    />
  );
}

/** Processing status with jobs popover. */
export function JobsIndicator() {
  const { status } = useApp();
  const running = (status?.jobs.running ?? 0) + (status?.jobs.pending ?? 0);
  const failed = status?.jobs.failed ?? 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-testid="jobs-indicator"
          aria-label={`Verarbeitung: ${running} aktiv, ${failed} fehlgeschlagen`}
          className="gap-1.5"
        >
          {running > 0 ? <Loader2 className="animate-spin" aria-hidden /> : <Activity aria-hidden />}
          <span className="hidden lg:inline">{running > 0 ? `${running} in Arbeit` : 'Verarbeitung'}</span>
          {failed > 0 && <span className="rounded-full bg-destructive px-1.5 text-[10px] font-semibold text-destructive-foreground">{failed}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[26rem]" data-testid="jobs-popover">
        <p className="mb-2 text-sm font-semibold">Verarbeitung</p>
        <div className="max-h-96 overflow-y-auto">
          <JobsList compact limit={20} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

type AppStatus = NonNullable<ReturnType<typeof useApp>['status']>;
type Tone = Parameters<typeof Dot>[0]['tone'];

function servicesTone(services: AppStatus['services']): Tone {
  if (services.length === 0) return 'unknown';
  if (services.some((service) => service.status === 'error')) return 'error';
  return services.some((service) => service.status === 'degraded') ? 'warn' : 'ok';
}

function llmState(llm: AppStatus['llm']): { tone: Tone; text: string } {
  if (llm.localOnly) return { tone: 'unknown', text: 'Nur lokal' };
  if (!llm.configured) return { tone: 'unknown', text: 'Nicht eingerichtet' };
  if (llm.status === 'ok') return { tone: 'ok', text: 'Verbunden' };
  return llm.status === 'error' ? { tone: 'error', text: 'Fehler' } : { tone: 'warn', text: 'Ungeprüft' };
}

/** Status of the local services and the LLM connection. */
export function ServiceStatus() {
  const { status } = useApp();
  if (!status) return null;
  return (
    <div className="flex items-center gap-1">
      <ServicesPopover status={status} />
      <LlmPopover llm={status.llm} />
    </div>
  );
}

function ServicesPopover({ status }: { status: AppStatus }) {
  const services = status.services;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5" data-testid="services-status" aria-label="Status der lokalen Dienste">
          <Cpu aria-hidden />
          <Dot tone={servicesTone(services)} />
          <span className="hidden xl:inline">Lokale Dienste</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <p className="mb-2 text-sm font-semibold">Lokale Dienste</p>
        {services.length === 0 && <p className="text-sm text-muted-foreground">Keine Angaben verfügbar.</p>}
        <ul className="flex flex-col gap-2 text-sm">
          {services.map((service) => (
            <li key={service.name} className="flex items-start gap-2">
              <span className="mt-1.5">
                <Dot tone={service.status === 'ok' ? 'ok' : service.status === 'degraded' ? 'warn' : 'error'} />
              </span>
              <span>
                <span className="font-medium">{service.name}</span>
                {service.detail && <span className="block text-xs text-muted-foreground">{service.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          Geheimnisspeicher:{' '}
          {status.secretStorage.available
            ? `verfügbar (${status.secretStorage.backend})`
            : 'nicht verfügbar – der API-Schlüssel kann nicht sicher gespeichert werden'}
        </p>
      </PopoverContent>
    </Popover>
  );
}

function LlmPopover({ llm }: { llm: AppStatus['llm'] }) {
  const { tone, text } = llmState(llm);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5" data-testid="llm-status" aria-label={`Verbindung zur KI: ${text}`}>
          <Plug aria-hidden />
          <Dot tone={tone} />
          <span className="hidden xl:inline">KI: {text}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <p className="mb-1 text-sm font-semibold">Verbindung zur KI</p>
        <p className="text-sm text-muted-foreground">{text}</p>
        {llm.lastError && <p className="mt-2 break-words text-xs text-destructive">{llm.lastError}</p>}
        {!llm.hasApiKey && llm.configured && <p className="mt-2 text-xs text-warning">Es ist noch kein API-Schlüssel hinterlegt.</p>}
        <p className="mt-2 text-xs text-muted-foreground">
          {llm.localOnly
            ? 'Der Datenschutzmodus „nur lokal“ ist aktiv: Es wird nichts an die KI gesendet.'
            : 'Ohne Verbindung arbeitet Archivist nur mit lokalen Funktionen.'}
        </p>
      </PopoverContent>
    </Popover>
  );
}
