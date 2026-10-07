'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/lib/toast';
import { useUpdateStatus } from '@/lib/use-update-status';

/** Points out a newer version once; the download itself is started in Einstellungen → Updates. */
export function UpdateAnnouncer() {
  const status = useUpdateStatus();
  const { toast } = useToast();
  const router = useRouter();
  const announced = useRef('');
  useEffect(() => {
    if (status?.state !== 'available' || announced.current === status.version) return;
    announced.current = status.version;
    toast({
      title: `Version ${status.version} ist verfügbar`,
      description: 'Du entscheidest, ob und wann sie heruntergeladen und installiert wird.',
      actionLabel: 'Zu den Updates',
      onAction: () => router.push('/settings/?tab=updates'),
      durationMs: 12000,
    });
  }, [status, toast, router]);
  return null;
}
