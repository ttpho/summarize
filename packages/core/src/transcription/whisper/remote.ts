import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WhisperProgressEvent, WhisperTranscriptionResult } from "./types.js";
import { DEFAULT_SEGMENT_SECONDS, MAX_OPENAI_UPLOAD_BYTES } from "./constants.js";
import { transcribeWithFal } from "./fal.js";
import { isFfmpegAvailable, transcodeBytesToMp3 } from "./ffmpeg.js";
import { transcribeFileWithGemini, transcribeWithGemini } from "./gemini.js";
import { shouldRetryOpenAiViaFfmpeg, transcribeWithOpenAi } from "./openai.js";
import { buildMissingTranscriptionProviderMessage } from "./provider-setup.js";
import { formatBytes, readFirstBytes, wrapError } from "./utils.js";

type Env = Record<string, string | undefined>;

type CloudArgs = {
  groqApiKey: string | null;
  groqError?: Error | null;
  geminiApiKey: string | null;
  openaiApiKey: string | null;
  falApiKey: string | null;
  env: Env;
};

function withMergedNotes(
  result: WhisperTranscriptionResult,
  notes: string[],
): WhisperTranscriptionResult {
  if (result.notes.length === 0) return { ...result, notes };
  return { ...result, notes: [...notes, ...result.notes] };
}

export async function transcribeBytesWithRemoteFallbacks({
  bytes,
  mediaType,
  filename,
  notes,
  groqApiKey,
  groqError = null,
  geminiApiKey,
  openaiApiKey,
  falApiKey,
  env,
  onProgress,
  transcribeOversizedBytesWithChunking,
}: {
  bytes: Uint8Array;
  mediaType: string;
  filename: string | null;
  notes: string[];
  groqApiKey: string | null;
  groqError?: Error | null;
  geminiApiKey: string | null;
  openaiApiKey: string | null;
  falApiKey: string | null;
  env: Env;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
  transcribeOversizedBytesWithChunking: (args: {
    bytes: Uint8Array;
    mediaType: string;
    filename: string | null;
    onProgress?: ((event: WhisperProgressEvent) => void) | null;
  }) => Promise<WhisperTranscriptionResult>;
}): Promise<WhisperTranscriptionResult> {
  if (!geminiApiKey && !openaiApiKey && !falApiKey) {
    if (groqApiKey) {
      return {
        text: null,
        provider: "groq",
        error: groqError ?? new Error("No transcription providers available"),
        notes,
      };
    }
    return {
      text: null,
      provider: null,
      error: new Error(buildMissingTranscriptionProviderMessage()),
      notes,
    };
  }

  let geminiError: Error | null = null;
  if (geminiApiKey) {
    try {
      const text = await transcribeWithGemini(bytes, mediaType, filename, geminiApiKey, { env });
      if (text) return { text, provider: "gemini", error: null, notes };
      geminiError = new Error("Gemini transcription returned empty text");
    } catch (error) {
      geminiError = wrapError("Gemini transcription failed", error);
    }
  }

  if (geminiError) {
    notes.push(`Gemini transcription failed; falling back to OpenAI/FAL: ${geminiError.message}`);
  }

  if (openaiApiKey && bytes.byteLength > MAX_OPENAI_UPLOAD_BYTES) {
    const canChunk = await isFfmpegAvailable();
    if (canChunk) {
      return withMergedNotes(
        await transcribeOversizedBytesWithChunking({
          bytes,
          mediaType,
          filename,
          onProgress,
        }),
        notes,
      );
    }

    notes.push(
      `Media too large for Whisper upload (${formatBytes(bytes.byteLength)}); transcribing first ${formatBytes(MAX_OPENAI_UPLOAD_BYTES)} only (install ffmpeg for full transcription)`,
    );
    bytes = bytes.slice(0, MAX_OPENAI_UPLOAD_BYTES);
  }

  let openaiError: Error | null = null;
  if (openaiApiKey) {
    try {
      const text = await transcribeWithOpenAi(bytes, mediaType, filename, openaiApiKey, { env });
      if (text) return { text, provider: "openai", error: null, notes };
      openaiError = new Error("OpenAI transcription returned empty text");
    } catch (error) {
      openaiError = wrapError("OpenAI transcription failed", error);
    }
  }

  if (openaiApiKey && openaiError && shouldRetryOpenAiViaFfmpeg(openaiError)) {
    const canTranscode = await isFfmpegAvailable();
    if (canTranscode) {
      try {
        notes.push("OpenAI could not decode media; transcoding via ffmpeg and retrying");
        const mp3Bytes = await transcodeBytesToMp3(bytes);
        const retried = await transcribeWithOpenAi(
          mp3Bytes,
          "audio/mpeg",
          "audio.mp3",
          openaiApiKey,
          { env },
        );
        if (retried) return { text: retried, provider: "openai", error: null, notes };
        openaiError = new Error("OpenAI transcription returned empty text after ffmpeg transcode");
        bytes = mp3Bytes;
        mediaType = "audio/mpeg";
      } catch (error) {
        notes.push(
          `ffmpeg transcode failed; cannot retry OpenAI decode error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } else {
      notes.push("OpenAI could not decode media; install ffmpeg to enable transcoding retry");
    }
  }

  const canUseFal = Boolean(falApiKey) && mediaType.toLowerCase().startsWith("audio/");
  if (openaiError && canUseFal) {
    notes.push(`OpenAI transcription failed; falling back to FAL: ${openaiError.message}`);
  }
  if (falApiKey && !canUseFal) {
    notes.push(`Skipping FAL transcription: unsupported mediaType ${mediaType}`);
  }

  if (falApiKey && canUseFal) {
    try {
      const text = await transcribeWithFal(bytes, mediaType, falApiKey);
      if (text) return { text, provider: "fal", error: null, notes };
      return {
        text: null,
        provider: "fal",
        error: new Error("FAL transcription returned empty text"),
        notes,
      };
    } catch (error) {
      return {
        text: null,
        provider: "fal",
        error: wrapError("FAL transcription failed", error),
        notes,
      };
    }
  }

  return {
    text: null,
    provider: openaiError
      ? "openai"
      : geminiError
        ? "gemini"
        : groqError
          ? "groq"
          : openaiApiKey
            ? "openai"
            : geminiApiKey
              ? "gemini"
              : groqApiKey
                ? "groq"
                : null,
    error:
      openaiError ?? geminiError ?? groqError ?? new Error("No transcription providers available"),
    notes,
  };
}

export async function transcribeFileWithRemoteFallbacks({
  filePath,
  mediaType,
  filename,
  notes,
  groqApiKey,
  groqError = null,
  geminiApiKey,
  openaiApiKey,
  falApiKey,
  env,
  totalDurationSeconds,
  onProgress,
  transcribeChunkedFile,
  transcribePartialFileHead,
  transcribeFullFileBytes,
}: {
  filePath: string;
  mediaType: string;
  filename: string | null;
  notes: string[];
  totalDurationSeconds: number | null;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
  transcribeChunkedFile: (args: {
    filePath: string;
    segmentSeconds: number;
    totalDurationSeconds: number | null;
    onProgress?: ((event: WhisperProgressEvent) => void) | null;
  }) => Promise<WhisperTranscriptionResult>;
  transcribePartialFileHead: (args: {
    bytes: Uint8Array;
    mediaType: string;
    filename: string | null;
  }) => Promise<WhisperTranscriptionResult>;
  transcribeFullFileBytes: (args: {
    bytes: Uint8Array;
    mediaType: string;
    filename: string | null;
  }) => Promise<WhisperTranscriptionResult>;
} & CloudArgs): Promise<WhisperTranscriptionResult> {
  let geminiError: Error | null = null;
  if (geminiApiKey) {
    try {
      const text = await transcribeFileWithGemini({
        filePath,
        mediaType,
        filename,
        apiKey: geminiApiKey,
        env,
      });
      if (text) return { text, provider: "gemini", error: null, notes };
      geminiError = new Error("Gemini transcription returned empty text");
    } catch (error) {
      geminiError = wrapError("Gemini transcription failed", error);
      notes.push(`Gemini transcription failed; falling back to OpenAI/FAL: ${geminiError.message}`);
    }
  }

  if (!geminiApiKey && !openaiApiKey && !falApiKey) {
    return groqApiKey
      ? {
          text: null,
          provider: "groq",
          error: groqError ?? new Error("No transcription providers available"),
          notes,
        }
      : {
          text: null,
          provider: null,
          error: new Error(buildMissingTranscriptionProviderMessage()),
          notes,
        };
  }

  const stat = await fs.stat(filePath);
  if (openaiApiKey && stat.size > MAX_OPENAI_UPLOAD_BYTES) {
    const canChunk = await isFfmpegAvailable();
    if (!canChunk) {
      notes.push(
        `Media too large for Whisper upload (${formatBytes(stat.size)}); install ffmpeg to enable chunked transcription`,
      );
      const head = await readFirstBytes(filePath, MAX_OPENAI_UPLOAD_BYTES);
      return withMergedNotes(
        await transcribePartialFileHead({ bytes: head, mediaType, filename }),
        notes,
      );
    }

    return withMergedNotes(
      await transcribeChunkedFile({
        filePath,
        segmentSeconds: DEFAULT_SEGMENT_SECONDS,
        totalDurationSeconds,
        onProgress,
      }),
      notes,
    );
  }

  const bytes = new Uint8Array(await fs.readFile(filePath));
  return withMergedNotes(await transcribeFullFileBytes({ bytes, mediaType, filename }), notes);
}

export async function transcribeOversizedBytesViaTempFile({
  bytes,
  mediaType,
  filename,
  onProgress,
  transcribeFile,
}: {
  bytes: Uint8Array;
  mediaType: string;
  filename: string | null;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
  transcribeFile: (args: {
    filePath: string;
    mediaType: string;
    filename: string | null;
    onProgress?: ((event: WhisperProgressEvent) => void) | null;
  }) => Promise<WhisperTranscriptionResult>;
}): Promise<WhisperTranscriptionResult> {
  const tempFile = join(tmpdir(), `summarize-whisper-${randomUUID()}`);
  try {
    await fs.writeFile(tempFile, bytes);
    return await transcribeFile({
      filePath: tempFile,
      mediaType,
      filename,
      onProgress,
    });
  } finally {
    await fs.unlink(tempFile).catch(() => {});
  }
}
