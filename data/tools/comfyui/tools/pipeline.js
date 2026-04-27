const fs = require('fs');
const path = require('path');

let ACTIVE_SESSION_DIR = process.cwd();

// Node.js 내장 fetch(undici)용 커넥션 풀 — 소켓 재사용으로 Windows TIME_WAIT 포트 고갈 방지
let keepAliveDispatcher;
try {
  const { Agent } = require('undici');
  keepAliveDispatcher = new Agent({
    keepAliveTimeout: 30000,
    keepAliveMaxTimeout: 60000,
    connections: 4,
    pipelining: 1,
  });
} catch {
  // undici 없으면 기본 fetch dispatcher 사용 (Node 18+ 내장)
  keepAliveDispatcher = undefined;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sessionDir() {
  return ACTIVE_SESSION_DIR;
}

function sessionId() {
  return path.basename(sessionDir());
}

function mcpConfig() {
  const cfg = readJson(path.join(sessionDir(), '.mcp.json'));
  const server = cfg?.mcpServers?.claude_play;
  const env = server?.env || {};
  return {
    apiBase: String(env.CLAUDE_PLAY_API_BASE || 'http://127.0.0.1:3340').replace(/\/+$/, ''),
    token: String(env.CLAUDE_PLAY_AUTH_TOKEN || ''),
  };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(method, route, payload, options = {}) {
  const cfg = mcpConfig();
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.token) headers['x-bridge-token'] = cfg.token;

  const maxRetries = options.retries ?? 3;
  const timeoutMs = options.timeout ?? 300000; // 5분 기본 (이미지 생성 대기용)

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(`${cfg.apiBase}${route}`, {
        method,
        headers,
        ...(keepAliveDispatcher ? { dispatcher: keepAliveDispatcher } : {}),
        signal: controller.signal,
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });

      clearTimeout(timer);

      const text = await response.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }

      if (!response.ok) {
        const detail = data && typeof data === 'object' && data.error ? data.error : JSON.stringify(data);
        throw new Error(`${method} ${route} failed (${response.status}): ${detail}`);
      }

      return data;
    } catch (error) {
      lastError = error;
      const isRetryable =
        error?.cause?.code === 'EADDRINUSE' ||
        error?.cause?.code === 'ECONNREFUSED' ||
        error?.cause?.code === 'ECONNRESET' ||
        error?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
        error?.name === 'AbortError';

      if (!isRetryable || attempt >= maxRetries) throw error;

      const delayMs = Math.min(1000 * Math.pow(2, attempt), 8000) + Math.random() * 500;
      console.log(`[pipeline] ${method} ${route} retry ${attempt + 1}/${maxRetries} in ${Math.round(delayMs)}ms: ${error.message}`);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

async function runTool(tool, args) {
  // engine 호출은 짧은 작업이므로 timeout 30초, retry 3회
  return requestJson('POST', `/api/sessions/${encodeURIComponent(sessionId())}/tools/${encodeURIComponent(tool)}`, { args }, { timeout: 30000, retries: 3 });
}

function generateImage(route, payload) {
  // 이미지 생성은 오래 걸리므로 timeout 5분, retry 2회
  return requestJson('POST', route, payload, { timeout: 300000, retries: 2 });
}

function normalizeGeneratedPath(generatedPath, fallbackPath) {
  const raw = typeof generatedPath === 'string' && generatedPath.trim() ? generatedPath.trim() : fallbackPath;
  if (typeof raw !== 'string') return fallbackPath;
  return raw.replace(/^images[\\/]+images[\\/]+/i, 'images/').replace(/\\/g, '/');
}

function teacherPromptFromItem(item, pipelineMeta) {
  const meta = item.meta || {};
  // 1. 명시적 teacher_prompt가 있으면 그대로 사용
  if (typeof meta.teacher_prompt === 'string' && meta.teacher_prompt.trim()) {
    return meta.teacher_prompt.trim();
  }
  // 2. teacher_tags 우선, 없으면 subject_tags fallback — scene_prompt(자연어)는 사용하지 않음
  const triggerTags = Array.isArray(pipelineMeta.teacher_triggers) ? pipelineMeta.teacher_triggers.filter(Boolean) : [];
  const teacherTags = typeof meta.teacher_tags === 'string' && meta.teacher_tags.trim() ? meta.teacher_tags.trim() : '';
  const subjectTags = typeof meta.subject_tags === 'string' && meta.subject_tags.trim() ? meta.subject_tags.trim() : '';
  const tags = teacherTags || subjectTags;
  return [...triggerTags, tags].filter(Boolean).join(', ');
}

function sourceParamsFromItem(item, pipelineMeta) {
  const meta = item.meta || {};
  return {
    workflow: pipelineMeta.source_workflow || 'anima-mixed-scene',
    params: {
      subject_tags: typeof meta.subject_tags === 'string' && meta.subject_tags.trim() ? meta.subject_tags.trim() : '1girl',
      scene_prompt: item.prompt,
      meta_tags: typeof meta.meta_tags === 'string' ? meta.meta_tags : '',
      negative_prompt: typeof meta.negative_prompt === 'string' && meta.negative_prompt.trim() ? meta.negative_prompt : (typeof pipelineMeta.source_default_negative === 'string' ? pipelineMeta.source_default_negative : ''),
      width: Number(meta.width || 832),
      height: Number(meta.height || 1216),
      steps: Number(meta.steps || 30),
      cfg: Number(meta.cfg || 4.5),
      seed: Number.isFinite(Number(meta.seed)) ? Number(meta.seed) : Math.floor(Math.random() * 2147483647),
      sampler_name: typeof meta.sampler_name === 'string' ? meta.sampler_name : 'euler',
      scheduler: typeof meta.scheduler === 'string' ? meta.scheduler : 'simple',
      quality_preset: typeof meta.quality_preset === 'string' ? meta.quality_preset : 'standard',
      model_profile: typeof meta.model_profile === 'string' ? meta.model_profile : 'official_preview3',
      system_prefix: typeof meta.system_prefix === 'string' ? meta.system_prefix : '',
      detailer_face: meta.detailer_face !== false,
      detailer_hand: meta.detailer_hand === true,
      detailer_pussy: meta.detailer_pussy === true,
      detailer_anus: meta.detailer_anus === true,
    },
  };
}

function teacherParamsFromItem(item, pipelineMeta) {
  const meta = item.meta || {};
  const exposure = item.exposure || 'clothed';
  const isNude = exposure === 'nude';
  const isPartialNude = exposure === 'partial' && /nipples|pussy|bare_breasts|topless/.test(meta.subject_tags || '');
  return {
    workflow: pipelineMeta.teacher_workflow || 'boleromix-img2img-smoke',
    params: {
      prompt: teacherPromptFromItem(item, pipelineMeta),
      negative_prompt: typeof meta.teacher_negative_prompt === 'string' && meta.teacher_negative_prompt.trim() ? meta.teacher_negative_prompt : (typeof pipelineMeta.teacher_default_negative === 'string' ? pipelineMeta.teacher_default_negative : ''),
      input_image: normalizeGeneratedPath(item.source_image, item.source_image),
      steps: Number(meta.teacher_steps || 28),
      cfg: Number(meta.teacher_cfg || 5.5),
      denoise: Number(meta.teacher_denoise || pipelineMeta.teacher_denoise || 0.55),
      seed: Number.isFinite(Number(meta.teacher_seed)) ? Number(meta.teacher_seed) : Math.floor(Math.random() * 2147483647),
      detailer_face: meta.detailer_face !== false,
      detailer_hand: meta.detailer_hand === true,
      detailer_pussy: meta.detailer_pussy === true || isNude || isPartialNude,
      detailer_anus: meta.detailer_anus === true,
    },
    loras: Array.isArray(pipelineMeta.teacher_loras) ? pipelineMeta.teacher_loras : [],
  };
}

function currentMeta() {
  return readJson(path.join(sessionDir(), 'pipeline_meta.json'));
}

function readRuns(fileName) {
  return readJson(path.join(sessionDir(), fileName));
}

function findOpenBatch(fileName, prefix) {
  const runs = readRuns(fileName);
  return (runs.items || []).find((item) => item.id.startsWith(prefix) && (item.status === 'queued' || item.status === 'running')) || null;
}

async function createBatchIfNeeded(createAction, batchId) {
  if (batchId) return { batch_id: batchId };
  if (createAction === 'create_source_batch') {
    const open = findOpenBatch('source_runs.json', 'src');
    if (open) return { batch_id: open.id, export_items: open.export_items || [] };
  }
  if (createAction === 'create_teacher_batch') {
    const open = findOpenBatch('teacher_runs.json', 'tch');
    if (open) return { batch_id: open.id, export_items: open.export_items || [] };
  }
  const created = await runTool('engine', { action: createAction });
  if (!created?.ok || !created?.result?.success) {
    throw new Error(created?.error || created?.result?.message || `${createAction} failed`);
  }
  return created.result;
}

function remainingBatchItems(batchId, mode) {
  const pipelineState = readJson(path.join(sessionDir(), 'pipeline_state.json'));
  return (pipelineState.items || []).filter((item) => {
    if (mode === 'source') {
      return item.source_batch_id === batchId && (item.source_status === 'queued' || item.source_status === 'running');
    }
    return item.teacher_batch_id === batchId && (item.teacher_status === 'queued' || item.teacher_status === 'running');
  }).map((item) => item.id);
}

async function runSourceBatch(args = {}) {
  const pipelineMeta = readJson(path.join(sessionDir(), 'pipeline_meta.json'));
  if (args.clear_stop !== false) {
    await runTool('engine', { action: 'clear_source_stop' });
  }
  const created = await createBatchIfNeeded('create_source_batch', args.batch_id);
  const batchId = created.batch_id;

  const started = await runTool('engine', { action: 'start_source_batch', batch_id: batchId });
  if (!started?.ok || !started?.result?.success) {
    throw new Error(started?.error || started?.result?.message || 'start_source_batch failed');
  }

  const exportItems = created.export_items || [];
  const maxItems = Number.isFinite(Number(args.max_items)) ? Math.max(1, Number(args.max_items)) : exportItems.length;
  const results = [];
  let processed = 0;

  for (const item of exportItems) {
    const liveMeta = currentMeta();
    if (liveMeta.source_stop_requested === true) {
      return {
        success: true,
        mode: 'source',
        batch_id: batchId,
        stopped: true,
        results,
      };
    }

    if (!remainingBatchItems(batchId, 'source').includes(item.id)) {
      continue;
    }

    if (processed >= maxItems) {
      break;
    }

    const filename = `source/${item.id}.png`;
    try {
      const sourceSpec = sourceParamsFromItem(item, pipelineMeta);
      const generated = await generateImage('/api/tools/comfyui/generate', {
        sessionId: sessionId(),
        workflow: sourceSpec.workflow,
        params: sourceSpec.params,
        filename,
      });

      const imagePath = normalizeGeneratedPath(generated.path, filename);
      const marked = await runTool('engine', {
        action: 'mark_source_done',
        id: item.id,
        source_image: imagePath,
      });

      if (!marked?.ok || !marked?.result?.success) {
        throw new Error(marked?.error || marked?.result?.message || 'mark_source_done failed');
      }

      results.push({ id: item.id, success: true, path: imagePath });
    } catch (error) {
      await runTool('engine', {
        action: 'mark_source_error',
        id: item.id,
        error: error instanceof Error ? error.message : String(error),
      });
      results.push({ id: item.id, success: false, error: error instanceof Error ? error.message : String(error) });
    }
    processed += 1;
  }

  return {
    success: true,
    mode: 'source',
    batch_id: batchId,
    results,
  };
}

async function runTeacherBatch(args = {}) {
  const pipelineMeta = readJson(path.join(sessionDir(), 'pipeline_meta.json'));
  if (args.clear_stop !== false) {
    await runTool('engine', { action: 'clear_teacher_stop' });
  }
  const created = await createBatchIfNeeded('create_teacher_batch', args.batch_id);
  const batchId = created.batch_id;

  const started = await runTool('engine', { action: 'start_teacher_batch', batch_id: batchId });
  if (!started?.ok || !started?.result?.success) {
    throw new Error(started?.error || started?.result?.message || 'start_teacher_batch failed');
  }

  const exportItems = created.export_items || [];
  const maxItems = Number.isFinite(Number(args.max_items)) ? Math.max(1, Number(args.max_items)) : exportItems.length;
  const results = [];
  let processed = 0;

  for (const item of exportItems) {
    const liveMeta = currentMeta();
    if (liveMeta.teacher_stop_requested === true) {
      await runTool('engine', { action: 'rebuild_review_queue' });
      return {
        success: true,
        mode: 'teacher',
        batch_id: batchId,
        stopped: true,
        results,
      };
    }

    if (!remainingBatchItems(batchId, 'teacher').includes(item.id)) {
      continue;
    }

    if (processed >= maxItems) {
      break;
    }

    const filename = `teacher/${item.id}.png`;
    try {
      const teacherSpec = teacherParamsFromItem(item, pipelineMeta);
      const generated = await generateImage('/api/tools/comfyui/generate', {
        sessionId: sessionId(),
        workflow: teacherSpec.workflow,
        params: teacherSpec.params,
        filename,
        loras: teacherSpec.loras,
      });

      const imagePath = normalizeGeneratedPath(generated.path, filename);
      const marked = await runTool('engine', {
        action: 'mark_teacher_done',
        id: item.id,
        teacher_image: imagePath,
      });

      if (!marked?.ok || !marked?.result?.success) {
        throw new Error(marked?.error || marked?.result?.message || 'mark_teacher_done failed');
      }

      results.push({ id: item.id, success: true, path: imagePath });
    } catch (error) {
      await runTool('engine', {
        action: 'mark_teacher_error',
        id: item.id,
        error: error instanceof Error ? error.message : String(error),
      });
      results.push({ id: item.id, success: false, error: error instanceof Error ? error.message : String(error) });
    }
    processed += 1;
  }

  const rebuilt = await runTool('engine', { action: 'rebuild_review_queue' });
  if (!rebuilt?.ok || !rebuilt?.result?.success) {
    throw new Error(rebuilt?.error || rebuilt?.result?.message || 'rebuild_review_queue failed');
  }

  return {
    success: true,
    mode: 'teacher',
    batch_id: batchId,
    results,
    review_queue: rebuilt.result.summary,
  };
}

async function runFullCycle() {
  const source = await runSourceBatch({});
  const teacher = await runTeacherBatch({});
  return {
    success: true,
    source,
    teacher,
  };
}

function summarizeBatchErrors(results, phase) {
  const failures = (results || []).filter((r) => r && r.success === false && typeof r.error === 'string' && r.error.trim());
  if (failures.length === 0) return { message: null, signature: null };
  const counts = new Map();
  for (const f of failures) {
    const key = f.error.trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const sortedEntries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const lines = sortedEntries.map(([msg, n]) => `  - (${n}건) ${msg}`);
  const signature = `${phase}:${sortedEntries.map(([msg]) => msg).join('|')}`;
  const message = `[SCHEDULER_ERROR] ${phase} 배치에서 ${failures.length}건 실패. 원인 요약:\n${lines.join('\n')}`;
  return { message, signature };
}

function readErrorDedupMarker() {
  const p = path.join(sessionDir(), '.scheduler_error_signature');
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

function writeErrorDedupMarker(signature) {
  const p = path.join(sessionDir(), '.scheduler_error_signature');
  try {
    if (signature) fs.writeFileSync(p, signature, 'utf8');
    else if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // ignore
  }
}

async function schedulerTick(args = {}) {
  const meta = currentMeta();
  const chunkSize = Number.isFinite(Number(args.chunk_size))
    ? Math.max(1, Number(args.chunk_size))
    : Math.max(1, Number(meta.scheduler_chunk_size || 1));

  if (meta.scheduler_stop_requested === true) {
    await runTool('engine', { action: 'finish_scheduler' });
    return {
      success: true,
      stopped: true,
      reason: 'stop_requested',
      did_work: false,
    };
  }

  const state = readJson(path.join(sessionDir(), 'pipeline_state.json'));
  const sourcePending = (state.items || []).some((item) => item.source_status === 'pending' || item.source_status === 'error' || item.source_status === 'queued' || item.source_status === 'running');
  const teacherPending = (state.items || []).some((item) => {
    return item.source_status === 'done' && item.source_image && (
      item.teacher_status === 'pending' ||
      item.teacher_status === 'error' ||
      item.teacher_status === 'queued' ||
      item.teacher_status === 'running'
    );
  });

  // 진행 상황 집계 (알림용)
  const total = (state.items || []).length;
  const sourceDone = (state.items || []).filter((i) => i.source_status === 'done').length;
  const teacherDone = (state.items || []).filter((i) => i.teacher_status === 'done').length;

  if (sourcePending) {
    const result = await runSourceBatch({ max_items: chunkSize, clear_stop: false });
    const newSourceDone = sourceDone + (result.results || []).filter((r) => r.success).length;
    const notifications = [
      {
        target: 'client',
        event: 'scheduler:progress',
        payload: { phase: 'source', done: newSourceDone, total, step: `source ${newSourceDone}/${total}` },
      },
    ];
    const { message: errorMessage, signature: errorSignature } = summarizeBatchErrors(result.results, 'source');
    const lastSignature = readErrorDedupMarker();
    if (errorMessage && errorSignature !== lastSignature) {
      notifications.push({ target: 'ai', mode: 'send', message: errorMessage });
      writeErrorDedupMarker(errorSignature);
    } else if (!errorMessage && lastSignature) {
      writeErrorDedupMarker('');
    }
    return {
      success: true,
      did_work: true,
      phase: 'source',
      ...result,
      notifications,
    };
  }

  if (teacherPending) {
    const result = await runTeacherBatch({ max_items: chunkSize, clear_stop: false });
    const newTeacherDone = teacherDone + (result.results || []).filter((r) => r.success).length;
    const allTeacherDone = newTeacherDone >= total;
    const notifications = [
      {
        target: 'client',
        event: 'scheduler:progress',
        payload: { phase: 'teacher', done: newTeacherDone, total, step: `teacher ${newTeacherDone}/${total}` },
      },
    ];
    const { message: errorMessage, signature: errorSignature } = summarizeBatchErrors(result.results, 'teacher');
    const lastSignature = readErrorDedupMarker();
    if (errorMessage && errorSignature !== lastSignature) {
      notifications.push({ target: 'ai', mode: 'send', message: errorMessage });
      writeErrorDedupMarker(errorSignature);
    } else if (!errorMessage && lastSignature) {
      writeErrorDedupMarker('');
    }
    // teacher 완료 AI 알림은 idle 틱에서 통합 발송 — 여기서는 client progress + 에러 요약만
    return {
      success: true,
      did_work: true,
      phase: 'teacher',
      ...result,
      notifications,
    };
  }

  const rebuilt = await runTool('engine', { action: 'rebuild_review_queue' });
  if (!rebuilt?.ok || !rebuilt?.result?.success) {
    throw new Error(rebuilt?.error || rebuilt?.result?.message || 'rebuild_review_queue failed');
  }
  await runTool('engine', { action: 'finish_scheduler' });

  return {
    success: true,
    did_work: false,
    completed: true,
    phase: 'idle',
    review_queue: rebuilt.result.summary,
    notifications: [
      {
        target: 'client',
        event: 'scheduler:complete',
        payload: { phase: 'idle', review_queue: rebuilt.result.summary },
      },
      {
        target: 'ai',
        mode: 'send',
        message: `[SCHEDULER_COMPLETE] 파이프라인 완료. source ${sourceDone}건, teacher ${teacherDone}건 처리됨. 리뷰 큐 상태: ${JSON.stringify(rebuilt.result.summary)}`,
      },
    ],
  };
}

module.exports = async function pipeline(context, args) {
  ACTIVE_SESSION_DIR = (context && typeof context.sessionDir === 'string' && context.sessionDir.trim()) ? context.sessionDir : process.cwd();
  const action = args?.action;

  if (action === 'run_source_batch') {
    return { result: await runSourceBatch(args) };
  }

  if (action === 'run_teacher_batch') {
    return { result: await runTeacherBatch(args) };
  }

  if (action === 'run_full_cycle') {
    return { result: await runFullCycle() };
  }

  if (action === 'scheduler_tick') {
    return { result: await schedulerTick(args) };
  }

  return {
    result: {
      success: false,
      message: `unsupported action: ${action}`,
    },
  };
};
