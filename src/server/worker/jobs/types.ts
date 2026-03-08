export enum JobType {
  CONTENT_PUBLISH = "content-publish",
  CONTENT_SCHEDULE = "content-schedule",
  SCRAPER_RUN = "scraper-run",
  MEDIA_PROCESS = "media-process",
  AGENT_EXECUTE = "agent-execute",
  ANALYTICS_SYNC = "analytics-sync",
  WEBHOOK_DISPATCH = "webhook-dispatch",
}

export interface BaseJobData {
  organizationId: string;
  triggeredBy?: string;
  createdAt: string;
}

export interface ContentPublishJob extends BaseJobData {
  type: JobType.CONTENT_PUBLISH;
  contentId: string;
  platformIds: string[];
}

export interface ContentScheduleJob extends BaseJobData {
  type: JobType.CONTENT_SCHEDULE;
  contentId: string;
  scheduledAt: string;
}

export interface ScraperRunJob extends BaseJobData {
  type: JobType.SCRAPER_RUN;
  targetUrl: string;
  profileId: string;
}

export interface MediaProcessJob extends BaseJobData {
  type: JobType.MEDIA_PROCESS;
  sourceUrl: string;
  outputFormat: string;
}

export interface AgentExecuteJob extends BaseJobData {
  type: JobType.AGENT_EXECUTE;
  agentId: string;
  input: Record<string, unknown>;
}

export interface AnalyticsSyncJob extends BaseJobData {
  type: JobType.ANALYTICS_SYNC;
  platformId: string;
  dateRange: { from: string; to: string };
}

export interface WebhookDispatchJob extends BaseJobData {
  type: JobType.WEBHOOK_DISPATCH;
  webhookUrl: string;
  payload: Record<string, unknown>;
}

export type JobData =
  | ContentPublishJob
  | ContentScheduleJob
  | ScraperRunJob
  | MediaProcessJob
  | AgentExecuteJob
  | AnalyticsSyncJob
  | WebhookDispatchJob;
