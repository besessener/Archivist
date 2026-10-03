import type { IpcOutput } from '@archivist/shared';

export type ChatMessage = IpcOutput<'chat:history'>[number];
export type DocRecord = IpcOutput<'documents:get'>;
export type DecisionRecord = IpcOutput<'decisions:get'>;
export type ActionRecord = IpcOutput<'actions:resolve'>;
export type OpenItemRecord = IpcOutput<'openItems:create'>;
export type InsightRecord = IpcOutput<'insights:list'>[number];
export type JobRecord = IpcOutput<'jobs:list'>[number];
export type NotificationRecord = IpcOutput<'notifications:list'>[number];
export type ScanRootRecord = IpcOutput<'scanner:listDirectories'>[number];
export type ScanFileRecord = IpcOutput<'scanner:getResults'>['files'][number];
export type ArchivePlanRecord = IpcOutput<'documents:previewArchive'>;
export type ArchiveResultRecord = IpcOutput<'documents:archive'>;
export type ImportResult = IpcOutput<'documents:import'>;
export type SourceRef = ChatMessage['sources'][number];
