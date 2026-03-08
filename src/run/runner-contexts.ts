import type { CacheState } from "../cache.js";
import type { MediaCache } from "../content/index.js";
import type { AssetSummaryContext, SummarizeAssetArgs } from "./flows/asset/summary.js";
import { summarizeAsset as summarizeAssetFlow } from "./flows/asset/summary.js";
import type { UrlFlowContext } from "./flows/url/types.js";

type SummarizeMediaFile = typeof import("./flows/asset/media.js").summarizeMediaFile;

export function createRunnerFlowContexts(options: {
  assetSummaryContext: AssetSummaryContext;
  summarizeMediaFileImpl: SummarizeMediaFile;
  cacheState: CacheState;
  mediaCache: MediaCache | null;
  io: UrlFlowContext["io"];
  flags: UrlFlowContext["flags"];
  model: UrlFlowContext["model"];
  setTranscriptionCost: UrlFlowContext["hooks"]["setTranscriptionCost"];
  writeViaFooter: UrlFlowContext["hooks"]["writeViaFooter"];
  clearProgressForStdout: UrlFlowContext["hooks"]["clearProgressForStdout"];
  restoreProgressAfterStdout: UrlFlowContext["hooks"]["restoreProgressAfterStdout"];
  setClearProgressBeforeStdout: UrlFlowContext["hooks"]["setClearProgressBeforeStdout"];
  clearProgressIfCurrent: UrlFlowContext["hooks"]["clearProgressIfCurrent"];
  buildReport: UrlFlowContext["hooks"]["buildReport"];
  estimateCostUsd: UrlFlowContext["hooks"]["estimateCostUsd"];
}) {
  const {
    assetSummaryContext,
    summarizeMediaFileImpl,
    cacheState,
    mediaCache,
    io,
    flags,
    model,
    setTranscriptionCost,
    writeViaFooter,
    clearProgressForStdout,
    restoreProgressAfterStdout,
    setClearProgressBeforeStdout,
    clearProgressIfCurrent,
    buildReport,
    estimateCostUsd,
  } = options;

  const summarizeAsset = (args: SummarizeAssetArgs) =>
    summarizeAssetFlow(assetSummaryContext, args);
  const summarizeMediaFile = (args: Parameters<SummarizeMediaFile>[1]) =>
    summarizeMediaFileImpl(assetSummaryContext, args);

  return {
    summarizeAsset,
    assetInputContext: {
      env: assetSummaryContext.env,
      envForRun: assetSummaryContext.envForRun,
      stderr: assetSummaryContext.stderr,
      progressEnabled: flags.progressEnabled,
      timeoutMs: flags.timeoutMs,
      trackedFetch: io.fetch,
      summarizeAsset,
      summarizeMediaFile,
      setClearProgressBeforeStdout,
      clearProgressIfCurrent,
    },
    urlFlowContext: {
      io,
      flags,
      model,
      cache: cacheState,
      mediaCache,
      hooks: {
        onModelChosen: null,
        onExtracted: null,
        onSlidesExtracted: null,
        onSlidesProgress: null,
        onLinkPreviewProgress: null,
        onSummaryCached: null,
        setTranscriptionCost,
        summarizeAsset,
        writeViaFooter,
        clearProgressForStdout,
        restoreProgressAfterStdout,
        setClearProgressBeforeStdout,
        clearProgressIfCurrent,
        buildReport,
        estimateCostUsd,
        onSlideChunk: undefined,
        onSlidesDone: null,
      },
    } satisfies UrlFlowContext,
  };
}
