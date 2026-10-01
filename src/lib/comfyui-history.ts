// ComfyUI history/outputs 파싱 순수 헬퍼. ComfyUIClient에서 추출(Wave 9). this/fs/network 무의존.

/** Extract audio output filenames from history entry */
export function extractAudioFilenames(
  historyEntry: Record<string, unknown>
): Array<{ filename: string; prefix: string }> {
  const outputs = historyEntry.outputs as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!outputs) return [];

  const results: Array<{ filename: string; prefix: string }> = [];
  for (const nodeOutput of Object.values(outputs)) {
    const audios = nodeOutput.audio as
      | Array<{ filename: string; subfolder?: string; type?: string }>
      | undefined;
    if (audios && audios.length > 0) {
      for (const a of audios) {
        const prefix = a.filename.replace(/_\d+_?\.\w+$/, "");
        results.push({ filename: a.filename, prefix });
      }
    }
  }
  return results;
}

/** Extract all output filenames grouped by their prefix */
export function extractOutputFilenames(
  historyEntry: Record<string, unknown>
): Array<{ filename: string; prefix: string; subfolder?: string; type?: string }> {
  const outputs = historyEntry.outputs as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!outputs) return [];

  const results: Array<{ filename: string; prefix: string; subfolder?: string; type?: string }> = [];
  // 이미지·영상(SaveVideo도 images로 보고)을 먼저, 음악 생성 워크플로(SaveAudio*)의 audio 출력을 그 뒤에 모은다.
  // 이미지 워크플로의 메인 출력 순서는 그대로 유지된다.
  for (const key of ["images", "audio"] as const) {
    for (const nodeOutput of Object.values(outputs)) {
      const files = nodeOutput[key] as
        | Array<{ filename: string; subfolder?: string; type?: string }>
        | undefined;
      if (!files || files.length === 0) continue;
      for (const f of files) {
        // ComfyUI filenames are like "profile_00001_.png" — extract prefix before first underscore+digits
        const prefix = f.filename.replace(/_\d+_?\.\w+$/, "");
        results.push({
          filename: f.filename,
          prefix,
          subfolder: f.subfolder,
          type: f.type,
        });
      }
    }
  }
  return results;
}

/** Extract text outputs from ComfyUI history entry */
export function extractTextOutputs(historyEntry: Record<string, unknown>): string[] {
  const outputs = historyEntry.outputs as Record<string, Record<string, unknown>> | undefined;
  if (!outputs) return [];
  const texts: string[] = [];
  for (const nodeOutput of Object.values(outputs)) {
    // ShowTextForGPT stores text in { text: [...] }
    const textArr = nodeOutput.text as string[] | undefined;
    if (textArr && Array.isArray(textArr)) {
      texts.push(...textArr);
    }
    // Some nodes use string directly
    if (typeof nodeOutput.string === "string") {
      texts.push(nodeOutput.string);
    }
  }
  return texts;
}
