export * from './types.js';
export { ConciergeFolderSettingsRepository, defaultSettings } from './folder-settings-repository.js';
export type { FolderSettingsPatch } from './folder-settings-repository.js';
export { NoteMoMetadataRepository } from './mo-metadata-repository.js';
export type {
  NoteMoMetadata,
  UpsertMoMetadataInput,
  MoComputedBy,
} from './mo-metadata-repository.js';
export {
  MoMetadataVecRepository,
  buildMoMetadataEmbedText,
  listMoMetadataVecBackfillCandidates,
} from './mo-metadata-vec.js';
export type { MetadataVecHit } from './mo-metadata-vec.js';
export { NoteMoClustersRepository } from './mo-clusters-repository.js';
export type {
  NoteCluster,
  UpsertClusterInput,
  MoClusterSource,
} from './mo-clusters-repository.js';
export {
  MoMetadataQueueRepository,
  MoClusterQueueRepository,
} from './mo-queue-repository.js';
export type {
  MoMetadataQueueRow,
  MoClusterQueueRow,
  MoQueueTier,
} from './mo-queue-repository.js';
export {
  runTier0Checks,
  findStuckTickets,
  findUntaggedNotes,
  findShortBodies,
  findBrokenTitles,
} from './mo-tier0.js';
export type {
  Tier0Finding,
  Tier0FindingKind,
  Tier0Options,
  FindingSeverity,
} from './mo-tier0.js';
export {
  ensurePatrolLogNote,
  findPatrolLogNote,
  appendFindings,
  renderFindingsSection,
} from './mo-patrol-log.js';
export type { AppendFindingsOptions } from './mo-patrol-log.js';
export { MoPatrolFindingsRepository } from './mo-patrol-findings-repository.js';
export type {
  PatrolFindingRecord,
  PatrolFindingState,
  PatrolFindingAction,
} from './mo-patrol-findings-repository.js';
export {
  hashBody,
  buildTier1Messages,
  parseTier1Response,
  runTier1ForNote,
} from './mo-tier1.js';
export type {
  Tier1Output,
  Tier1ClusterCandidate,
  Tier1RunDeps,
  Tier1RunOptions,
  Tier1RunResult,
} from './mo-tier1.js';
export { drainTier1Queue } from './mo-tier1-worker.js';
export type {
  Tier1WorkerDeps,
  Tier1WorkerOptions,
  Tier1WorkerSummary,
} from './mo-tier1-worker.js';
export {
  runMoIndexingTick,
  MO_INDEXING_AUDIT_CHECKPOINT_KEY,
  MO_INDEXING_TIER1_MODEL,
  MO_INDEXING_TIER1_FALLBACK,
  MO_INDEXING_TIER2_MODEL,
  MO_INDEXING_TIER2_FALLBACK,
  MO_INDEXING_REQUIRED_BACKEND,
  MO_INDEXING_TOPIC_HYGIENE_RECOMMENDED,
} from './mo-indexing-tick.js';
export type {
  MoIndexingTickDeps,
  MoIndexingTickSummary,
  MoIndexingTickStatus,
  MoIndexingProvider,
} from './mo-indexing-tick.js';
export {
  CLUSTER_DOC_SECTIONS,
  clusterDocSkeleton,
  parseClusterDoc,
  renderClusterDoc,
  mergeClusterDoc,
  clusterDocHasContent,
  startMarker as clusterStartMarker,
  endMarker as clusterEndMarker,
  renderSection as renderClusterSection,
} from './mo-cluster-doc.js';
export type {
  ClusterDocSectionId,
  ClusterDocSectionMap,
  ParsedClusterDoc,
  RenderClusterDocInput,
} from './mo-cluster-doc.js';
export {
  runTier2ForCluster,
  buildTier2Messages,
  ensureClusterNote,
  findClusterNoteId,
} from './mo-tier2.js';
export type {
  Tier2RunDeps,
  Tier2RunOptions,
  Tier2RunResult,
} from './mo-tier2.js';
export { drainTier2Queue } from './mo-tier2-worker.js';
export type {
  Tier2WorkerDeps,
  Tier2WorkerOptions,
  Tier2WorkerSummary,
} from './mo-tier2-worker.js';
export {
  CATALOG_DOC_SECTIONS,
  catalogDocSkeleton,
  parseCatalogDoc,
  renderCatalogDoc,
  mergeCatalogDoc,
  catalogDocHasContent,
  startMarker as catalogStartMarker,
  endMarker as catalogEndMarker,
  renderSection as renderCatalogSection,
} from './mo-catalog-doc.js';
export type {
  CatalogDocSectionId,
  CatalogDocSectionMap,
  ParsedCatalogDoc,
  RenderCatalogDocInput,
} from './mo-catalog-doc.js';
export {
  runTier25ForFolder,
  buildTier25Messages,
  ensureCatalogNote,
  findCatalogNoteId,
  snapshotFolderClusters,
} from './mo-tier25.js';
export type {
  Tier25RunDeps,
  Tier25RunOptions,
  Tier25RunResult,
} from './mo-tier25.js';
export { ConciergeSessionsRepository } from './sessions-repository.js';
export type { CreateSessionInput } from './sessions-repository.js';
export {
  ConciergeMessagesRepository,
  startOfUtcDay,
  startOfNextUtcDay,
} from './messages-repository.js';
export type { CreateMessageInput } from './messages-repository.js';
export {
  BudgetTracker,
  BudgetExceededError,
  MONTHLY_CAP_USD,
  MO_BUDGET_SETTING_KEY,
  moBudgetExceededDenial,
  readMoMonthlyCap,
} from './budget.js';
export {
  MoSpendLedgerRepository,
  spendInputFromLLMResponse,
  startOfUtcMonth,
  startOfNextUtcMonth,
} from './mo-spend-ledger.js';
export type {
  MoSpendAuthMode,
  MoSpendKind,
  MoSpendRow,
  RecordSpendInput,
  UsageAggregate,
  UsageAggregateDaily,
  UsageAggregatePerKind,
  UsageAggregatePerModel,
  UsageAggregatePerProvider,
} from './mo-spend-ledger.js';
export {
  spawnSubMo,
  spawnSubMoBatch,
  requireBudget,
} from './mo-orchestrator.js';
export { MoMemoryRepository } from './mo-memory.js';
export type {
  MoOrchestratorDeps,
  SpawnSubMoInput,
  SubMoResult,
  SpawnBatchOptions,
} from './mo-orchestrator.js';
export type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMMessage,
  LLMToolCall,
  LLMToolDefinition,
} from './provider.js';
export {
  NoopLLMProvider,
  completeWithFallback,
  describeProviderError,
} from './provider.js';
export { OpenRouterProvider } from './openrouter.js';
export type { OpenRouterOptions } from './openrouter.js';
export { GroqProvider, DEFAULT_PRICING as GROQ_DEFAULT_PRICING } from './groq.js';
export type { GroqOptions, GroqPricing } from './groq.js';
export { OllamaProvider, DEFAULT_OLLAMA_BASE_URL } from './ollama.js';
export type { OllamaOptions } from './ollama.js';
export {
  OpenAIProvider,
  OPENAI_DEFAULT_PRICING,
  isOpenAIReasoningModel,
} from './openai.js';
export type { OpenAIOptions, OpenAIPricing } from './openai.js';
export {
  AnthropicProvider,
  ANTHROPIC_DEFAULT_PRICING,
  transformMessagesToAnthropic,
} from './anthropic.js';
export type { AnthropicOptions, AnthropicPricing } from './anthropic.js';
export {
  folderActivityDelta,
  folderTaskSummary,
  agentClaims,
  staleTasks,
} from './activity.js';
export type {
  FolderActivityDelta,
  FolderTaskSummary,
  AgentClaim,
  StaleTaskEntry,
  StatusTransitionEntry,
  NewCommentEntry,
  NewNoteEntry,
} from './activity.js';
export { buildChatSystemPrompt } from './prompt.js';
export type {
  CleanupEscalationContext,
  CleanupEscalationDecision,
} from './prompt.js';
export { CHAT_TOOLS, dispatchChatTool } from './chat-tools.js';
export type { ChatToolDeps } from './chat-tools.js';
export {
  buildMoToolDefinitions,
  dispatchMoTool,
  serializeMoToolResultForChat,
} from './mo-tools.js';
export type { MoToolInvocation, SerializedMoToolResult } from './mo-tools.js';
export {
  PENDING_TOOL_MARKER,
  formatPendingToolMessage,
  isPendingToolMessage,
  parsePendingToolMessage,
  isMoApprovalRequired,
  deniedToolResult,
} from './chat-approvals.js';
export type { PendingToolCall, PendingToolPayload } from './chat-approvals.js';
export {
  CHAT_QUERY_MARKER,
  reconstructLLMHistory,
} from './chat-history.js';
// CONCIERGE_ACTOR is the canonical name (lives in types.js, already
// re-exported via the wildcard at the top). MO_ACTOR is an alias for
// brevity at call sites that read like sentences.
export { CONCIERGE_ACTOR as MO_ACTOR } from './types.js';
export { toMoInternalCtx } from './mo-elevate.js';
export {
  MoContextCacheRepository,
  buildExactCacheKey,
  cosineSimilarity,
  SEMANTIC_MATCH_THRESHOLD,
  EXACT_MATCH_TTL_MS,
  SEMANTIC_WINDOW_MS,
} from './mo-context-cache.js';
export type {
  MoContextCacheRow,
  CacheInsertInput,
} from './mo-context-cache.js';
export {
  buildSubMoSystemPrompt,
  runSubMoTask,
  runSubMoBatch,
} from './sub-mo-template.js';
export type {
  SubMoRole,
  SubMoTaskOk,
  SubMoTaskErr,
  SubMoTaskResult,
  SubMoBatchOptions,
  SubMoBatchSummary,
} from './sub-mo-template.js';
export {
  keywordGeneratorRole,
  bodyExtractorRole,
  taskClusterAnalystRole,
  gatherSynthesizerRole,
  KeywordGeneratorOutput,
  BodyExtractorOutput,
  TaskClusterAnalystOutput,
  GatherSynthesizerOutput,
} from './sub-mo-roles.js';
export { gatherContext } from './context/gather.js';
export { chatProgressBus, ChatProgressBus } from './chat-progress-bus.js';
export type { ChatProgressEnvelope } from './chat-progress-bus.js';
export type {
  GatherInput,
  GatherDeps,
  GatherCaps,
  WorkContextPacket,
  GatherProgressEvent,
} from './context/types.js';
export { DEFAULT_GATHER_CAPS } from './context/types.js';
export { ConciergeScheduler } from './scheduler.js';
export type { ConciergeSchedulerOptions } from './scheduler.js';
export { MoTopicDecisionsRepository } from './mo-topic-decisions-repository.js';
export type {
  TopicDecision,
  TopicDecisionAuthor,
  TopicDecisionRow,
} from './mo-topic-decisions-repository.js';
export {
  mergeClusters,
  demoteClusterToTag,
  applyCleanupQuickAction,
} from './mo-topic-cleanup.js';
export type {
  MergeClustersDeps,
  MergeClustersOptions,
  MergeClustersResult,
  CleanupDecisionReceipt,
} from './mo-topic-cleanup.js';
export {
  runTopicHygiene,
  pollTopicHygieneAcrossFolders,
  gatherClusterPanorama,
  buildHygieneMessages,
  parseHygieneResponse,
  filterAgainstDecisions,
  bundleMergeProposals,
  TOPIC_HYGIENE_AUTO_THRESHOLD,
  TOPIC_HYGIENE_MIN_CLUSTERS,
  TOPIC_HYGIENE_MAX_CLUSTERS,
  TOPIC_HYGIENE_LAST_RUN_AT,
} from './mo-topic-hygiene.js';
export type {
  ClusterPanoramaItem,
  HygieneMergeProposal,
  HygieneDemoteProposal,
  HygieneProposal,
  RunTopicHygieneDeps,
  RunTopicHygieneOptions,
  RunTopicHygieneResult,
  TopicHygienePollDeps,
  TopicHygienePollSummary,
  MergeBundle,
} from './mo-topic-hygiene.js';
