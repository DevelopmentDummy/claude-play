function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function padPromptId(nextId) {
  return `p${String(nextId).padStart(6, '0')}`;
}

function padBatchId(prefix, nextId) {
  return `${prefix}${String(nextId).padStart(4, '0')}`;
}

function buildPromptItem(id, raw, timestamp) {
  if (typeof raw === 'string') {
    return {
      id,
      prompt: raw.trim(),
      source_key: null,
      category: [],
      notes: '',
      enabled: true,
      meta: {},
      created_at: timestamp,
      updated_at: timestamp,
    };
  }

  const prompt = typeof raw?.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt) {
    throw new Error('prompt is empty');
  }

  return {
    id,
    prompt,
    source_key: typeof raw.source_key === 'string' && raw.source_key.trim() ? raw.source_key.trim() : null,
    category: normalizeArray(raw.category),
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    enabled: raw.enabled !== false,
    meta: raw.meta && typeof raw.meta === 'object' ? clone(raw.meta) : {},
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function buildPipelineItem(id, timestamp) {
  return {
    id,
    source_status: 'pending',
    teacher_status: 'pending',
    review_status: 'pending',
    source_batch_id: null,
    teacher_batch_id: null,
    source_image: null,
    teacher_image: null,
    review_decision: null,
    review_note: '',
    retry_count: 0,
    last_error: null,
    updated_at: timestamp,
  };
}

function recalcPipelineSummary(items) {
  const summary = {
    total: items.length,
    source_done: 0,
    teacher_done: 0,
    error: 0,
  };

  for (const item of items) {
    if (item.source_status === 'done') summary.source_done += 1;
    if (item.teacher_status === 'done') summary.teacher_done += 1;
    if (
      item.source_status === 'error' ||
      item.teacher_status === 'error' ||
      item.review_status === 'error'
    ) {
      summary.error += 1;
    }
  }

  return summary;
}

function recalcBatchSummary(items) {
  const summary = {
    queued_batches: 0,
    running_batches: 0,
    done_batches: 0,
    error_batches: 0,
    last_batch_id: items.length ? items[items.length - 1].id : null,
  };

  for (const item of items) {
    if (item.status === 'queued') summary.queued_batches += 1;
    if (item.status === 'running') summary.running_batches += 1;
    if (item.status === 'done') summary.done_batches += 1;
    if (item.status === 'error') summary.error_batches += 1;
  }

  return summary;
}

function recalcReviewQueueSummary(items) {
  return {
    total: items.length,
    pending: items.filter((item) => item.status === 'pending').length,
    hold: items.filter((item) => item.status === 'hold').length,
  };
}

function recalcReviewLogSummary(items) {
  return {
    yes: items.filter((item) => item.decision === 'yes').length,
    no: items.filter((item) => item.decision === 'no').length,
    hold: items.filter((item) => item.decision === 'hold').length,
  };
}

function ensureCollections(context) {
  const pipelineMeta = clone(context.data.pipeline_meta || {});
  const promptBank = clone(context.data.prompt_bank || { items: [] });
  const pipelineState = clone(context.data.pipeline_state || { summary: {}, items: [] });
  const sourceRuns = clone(context.data.source_runs || { summary: {}, items: [] });
  const teacherRuns = clone(context.data.teacher_runs || { summary: {}, items: [] });
  const reviewQueue = clone(context.data.review_queue || { summary: {}, items: [] });
  const reviewLog = clone(context.data.review_log || { summary: {}, items: [] });

  if (!Array.isArray(promptBank.items)) promptBank.items = [];
  if (!Array.isArray(pipelineState.items)) pipelineState.items = [];
  if (!Array.isArray(sourceRuns.items)) sourceRuns.items = [];
  if (!Array.isArray(teacherRuns.items)) teacherRuns.items = [];
  if (!Array.isArray(reviewQueue.items)) reviewQueue.items = [];
  if (!Array.isArray(reviewLog.items)) reviewLog.items = [];

  if (typeof pipelineMeta.next_prompt_id !== 'number' || !Number.isFinite(pipelineMeta.next_prompt_id) || pipelineMeta.next_prompt_id < 1) {
    pipelineMeta.next_prompt_id = 1;
  }
  if (typeof pipelineMeta.next_source_batch_id !== 'number' || !Number.isFinite(pipelineMeta.next_source_batch_id) || pipelineMeta.next_source_batch_id < 1) {
    pipelineMeta.next_source_batch_id = 1;
  }
  if (typeof pipelineMeta.next_teacher_batch_id !== 'number' || !Number.isFinite(pipelineMeta.next_teacher_batch_id) || pipelineMeta.next_teacher_batch_id < 1) {
    pipelineMeta.next_teacher_batch_id = 1;
  }
  if (typeof pipelineMeta.source_batch_size !== 'number' || !Number.isFinite(pipelineMeta.source_batch_size) || pipelineMeta.source_batch_size < 1) {
    pipelineMeta.source_batch_size = pipelineMeta.pilot_batch_size || 30;
  }
  if (typeof pipelineMeta.teacher_batch_size !== 'number' || !Number.isFinite(pipelineMeta.teacher_batch_size) || pipelineMeta.teacher_batch_size < 1) {
    pipelineMeta.teacher_batch_size = pipelineMeta.pilot_batch_size || 30;
  }
  if (typeof pipelineMeta.source_workflow !== 'string' || !pipelineMeta.source_workflow.trim()) {
    pipelineMeta.source_workflow = 'anima-mixed-scene';
  }
  if (typeof pipelineMeta.teacher_workflow !== 'string' || !pipelineMeta.teacher_workflow.trim()) {
    pipelineMeta.teacher_workflow = 'boleromix-img2img-smoke';
  }

  return { pipelineMeta, promptBank, pipelineState, sourceRuns, teacherRuns, reviewQueue, reviewLog };
}

function appendPromptItems(context, rawItems) {
  const { pipelineMeta, promptBank, pipelineState } = ensureCollections(context);
  const timestamp = nowIso();
  const normalized = Array.isArray(rawItems) ? rawItems : [rawItems];
  const appended = [];
  const skipped = [];

  for (const raw of normalized) {
    const promptCandidate = typeof raw === 'string'
      ? raw.trim()
      : typeof raw?.prompt === 'string'
        ? raw.prompt.trim()
        : '';

    if (!promptCandidate) {
      skipped.push({ reason: 'empty_prompt' });
      continue;
    }

    const sourceKey = typeof raw?.source_key === 'string' && raw.source_key.trim() ? raw.source_key.trim() : null;
    if (sourceKey) {
      const duplicated = promptBank.items.find((item) => item.source_key === sourceKey);
      if (duplicated) {
        skipped.push({ reason: 'duplicate_source_key', source_key: sourceKey, id: duplicated.id });
        continue;
      }
    }

    const id = padPromptId(pipelineMeta.next_prompt_id);
    pipelineMeta.next_prompt_id += 1;

    const promptItem = buildPromptItem(id, raw, timestamp);
    const stateItem = buildPipelineItem(id, timestamp);

    promptBank.items.push(promptItem);
    pipelineState.items.push(stateItem);
    appended.push({ id, prompt: promptItem.prompt });
  }

  pipelineState.summary = recalcPipelineSummary(pipelineState.items);

  return {
    data: {
      'pipeline_meta.json': pipelineMeta,
      'prompt_bank.json': promptBank,
      'pipeline_state.json': pipelineState,
    },
    result: {
      success: true,
      appended,
      skipped,
      next_prompt_id: pipelineMeta.next_prompt_id,
      summary: pipelineState.summary,
    },
  };
}

function createBatch(context, params, mode) {
  const {
    pipelineMeta,
    promptBank,
    pipelineState,
    sourceRuns,
    teacherRuns,
  } = ensureCollections(context);

  const timestamp = nowIso();
  const promptMap = new Map(promptBank.items.map((item) => [item.id, item]));
  const isSource = mode === 'source';
  const batchSize = Math.max(1, Number(
    params?.batch_size ||
    (isSource ? pipelineMeta.source_batch_size : pipelineMeta.teacher_batch_size) ||
    pipelineMeta.pilot_batch_size ||
    30
  ));
  const includeRetry = params?.include_retry !== false;

  const candidates = pipelineState.items.filter((item) => {
    if (isSource) {
      if (item.source_status === 'pending') return true;
      if (includeRetry && item.source_status === 'error') return true;
      return false;
    }

    if (item.source_status !== 'done' || !item.source_image) return false;
    if (item.teacher_status === 'pending') return true;
    if (includeRetry && item.teacher_status === 'error') return true;
    return false;
  }).slice(0, batchSize);

  if (!candidates.length) {
    return {
      result: {
        success: false,
        message: `No ${mode} candidates available`,
      },
    };
  }

  const batchId = isSource
    ? padBatchId('src', pipelineMeta.next_source_batch_id++)
    : padBatchId('tch', pipelineMeta.next_teacher_batch_id++);

  const itemIds = [];
  const exportItems = [];

  for (const stateItem of pipelineState.items) {
    const selected = candidates.find((candidate) => candidate.id === stateItem.id);
    if (!selected) continue;

    const promptItem = promptMap.get(stateItem.id);
    if (!promptItem || promptItem.enabled === false) continue;

    if (isSource) {
      stateItem.source_status = 'queued';
      stateItem.source_batch_id = batchId;
      stateItem.last_error = null;
    } else {
      stateItem.teacher_status = 'queued';
      stateItem.teacher_batch_id = batchId;
      stateItem.last_error = null;
    }
    stateItem.updated_at = timestamp;

    itemIds.push(stateItem.id);
    exportItems.push({
      id: stateItem.id,
      prompt: promptItem.prompt,
      source_key: promptItem.source_key,
      category: promptItem.category || [],
      notes: promptItem.notes || '',
      meta: promptItem.meta || {},
      source_image: stateItem.source_image || null,
    });
  }

  if (!itemIds.length) {
    return {
      result: {
        success: false,
        message: `No enabled ${mode} candidates available`,
      },
    };
  }

  const targetRuns = isSource ? sourceRuns : teacherRuns;
  targetRuns.items.push({
    id: batchId,
    kind: mode,
    status: 'queued',
    item_ids: itemIds,
    requested_size: batchSize,
    created_at: timestamp,
    started_at: null,
    finished_at: null,
    completed_count: 0,
    error_count: 0,
    export_items: exportItems,
  });

  pipelineState.summary = recalcPipelineSummary(pipelineState.items);
  sourceRuns.summary = recalcBatchSummary(sourceRuns.items);
  teacherRuns.summary = recalcBatchSummary(teacherRuns.items);

  return {
    data: {
      'pipeline_meta.json': pipelineMeta,
      'pipeline_state.json': pipelineState,
      'source_runs.json': sourceRuns,
      'teacher_runs.json': teacherRuns,
    },
    result: {
      success: true,
      mode,
      batch_id: batchId,
      item_ids: itemIds,
      export_items: exportItems,
      count: itemIds.length,
      summary: isSource ? sourceRuns.summary : teacherRuns.summary,
    },
  };
}

function startBatch(context, params, mode) {
  const { pipelineState, sourceRuns, teacherRuns } = ensureCollections(context);
  const timestamp = nowIso();
  const batchId = typeof params?.batch_id === 'string' ? params.batch_id : null;
  if (!batchId) {
    return { result: { success: false, message: 'batch_id is required' } };
  }

  const targetRuns = mode === 'source' ? sourceRuns : teacherRuns;
  const batch = targetRuns.items.find((item) => item.id === batchId && item.kind === mode);
  if (!batch) {
    return { result: { success: false, message: 'batch not found' } };
  }

  batch.status = 'running';
  batch.started_at = batch.started_at || timestamp;

  for (const item of pipelineState.items) {
    if (!batch.item_ids.includes(item.id)) continue;
    if (mode === 'source' && item.source_status === 'queued') {
      item.source_status = 'running';
      item.updated_at = timestamp;
    }
    if (mode === 'teacher' && item.teacher_status === 'queued') {
      item.teacher_status = 'running';
      item.updated_at = timestamp;
    }
  }

  pipelineState.summary = recalcPipelineSummary(pipelineState.items);
  sourceRuns.summary = recalcBatchSummary(sourceRuns.items);
  teacherRuns.summary = recalcBatchSummary(teacherRuns.items);

  return {
    data: {
      'pipeline_state.json': pipelineState,
      'source_runs.json': sourceRuns,
      'teacher_runs.json': teacherRuns,
    },
    result: {
      success: true,
      batch_id: batchId,
      summary: targetRuns.summary,
    },
  };
}

function updateBatchItem(context, params, mode, outcome) {
  const { pipelineState, sourceRuns, teacherRuns } = ensureCollections(context);
  const timestamp = nowIso();
  const id = typeof params?.id === 'string' ? params.id : null;
  if (!id) {
    return { result: { success: false, message: 'id is required' } };
  }

  const item = pipelineState.items.find((entry) => entry.id === id);
  if (!item) {
    return { result: { success: false, message: 'pipeline item not found' } };
  }

  const batchId = mode === 'source' ? item.source_batch_id : item.teacher_batch_id;
  const targetRuns = mode === 'source' ? sourceRuns : teacherRuns;
  const batch = batchId ? targetRuns.items.find((entry) => entry.id === batchId && entry.kind === mode) : null;

  if (mode === 'source') {
    if (outcome === 'done') {
      item.source_status = 'done';
      item.source_image = typeof params?.source_image === 'string' ? params.source_image : item.source_image;
      item.last_error = null;
    } else {
      item.source_status = 'error';
      item.last_error = typeof params?.error === 'string' && params.error.trim() ? params.error.trim() : 'source generation failed';
      item.retry_count = Number(item.retry_count || 0) + 1;
    }
  } else {
    if (outcome === 'done') {
      item.teacher_status = 'done';
      item.teacher_image = typeof params?.teacher_image === 'string' ? params.teacher_image : item.teacher_image;
      item.last_error = null;
    } else {
      item.teacher_status = 'error';
      item.last_error = typeof params?.error === 'string' && params.error.trim() ? params.error.trim() : 'teacher generation failed';
      item.retry_count = Number(item.retry_count || 0) + 1;
    }
  }

  item.updated_at = timestamp;

  if (batch) {
    const relatedItems = pipelineState.items.filter((entry) => {
      return mode === 'source'
        ? entry.source_batch_id === batch.id
        : entry.teacher_batch_id === batch.id;
    });

    batch.completed_count = relatedItems.filter((entry) => {
      return mode === 'source' ? entry.source_status === 'done' : entry.teacher_status === 'done';
    }).length;

    batch.error_count = relatedItems.filter((entry) => {
      return mode === 'source' ? entry.source_status === 'error' : entry.teacher_status === 'error';
    }).length;

    const unresolved = relatedItems.filter((entry) => {
      const status = mode === 'source' ? entry.source_status : entry.teacher_status;
      return ['queued', 'running', 'pending'].includes(status);
    });

    if (!unresolved.length) {
      batch.finished_at = timestamp;
      batch.status = batch.error_count > 0 ? 'error' : 'done';
    } else if (batch.status === 'queued') {
      batch.status = 'running';
      batch.started_at = batch.started_at || timestamp;
    }
  }

  pipelineState.summary = recalcPipelineSummary(pipelineState.items);
  sourceRuns.summary = recalcBatchSummary(sourceRuns.items);
  teacherRuns.summary = recalcBatchSummary(teacherRuns.items);

  return {
    data: {
      'pipeline_state.json': pipelineState,
      'source_runs.json': sourceRuns,
      'teacher_runs.json': teacherRuns,
    },
    result: {
      success: true,
      id,
      batch_id: batchId,
      status: mode === 'source' ? item.source_status : item.teacher_status,
      summary: pipelineState.summary,
    },
  };
}

function requeueItems(context, params, mode) {
  const { pipelineState, sourceRuns, teacherRuns } = ensureCollections(context);
  const timestamp = nowIso();
  const targetBatchId = typeof params?.batch_id === 'string' ? params.batch_id : null;
  const targetStatuses = normalizeArray(params?.statuses);
  const statuses = targetStatuses.length ? targetStatuses : ['queued', 'running', 'error'];

  let count = 0;

  for (const item of pipelineState.items) {
    const status = mode === 'source' ? item.source_status : item.teacher_status;
    const batchId = mode === 'source' ? item.source_batch_id : item.teacher_batch_id;

    if (targetBatchId && batchId !== targetBatchId) continue;
    if (!statuses.includes(status)) continue;

    if (mode === 'source') {
      item.source_status = 'pending';
      item.source_batch_id = null;
      item.source_image = null;
    } else {
      item.teacher_status = 'pending';
      item.teacher_batch_id = null;
      item.teacher_image = null;
      item.review_status = 'pending';
      item.review_decision = null;
    }

    item.last_error = null;
    item.updated_at = timestamp;
    count += 1;
  }

  const targetRuns = mode === 'source' ? sourceRuns : teacherRuns;
  for (const batch of targetRuns.items) {
    if (batch.kind !== mode) continue;
    if (targetBatchId && batch.id !== targetBatchId) continue;
    if (!['queued', 'running', 'error'].includes(batch.status)) continue;
    batch.status = 'reset';
    batch.finished_at = batch.finished_at || timestamp;
  }

  pipelineState.summary = recalcPipelineSummary(pipelineState.items);
  sourceRuns.summary = recalcBatchSummary(sourceRuns.items);
  teacherRuns.summary = recalcBatchSummary(teacherRuns.items);

  return {
    data: {
      'pipeline_state.json': pipelineState,
      'source_runs.json': sourceRuns,
      'teacher_runs.json': teacherRuns,
    },
    result: {
      success: true,
      reset_count: count,
      summary: mode === 'source' ? sourceRuns.summary : teacherRuns.summary,
    },
  };
}

function rebuildReviewQueue(context) {
  const { promptBank, pipelineState, reviewQueue } = ensureCollections(context);
  const promptMap = new Map(promptBank.items.map((item) => [item.id, item]));
  const existingStatus = new Map(reviewQueue.items.map((item) => [item.id, item.status]));
  const timestamp = nowIso();

  const items = pipelineState.items
    .filter((item) => item.teacher_status === 'done' && item.teacher_image && item.review_decision !== 'yes' && item.review_decision !== 'no')
    .map((item) => {
      const promptItem = promptMap.get(item.id);
      const status = item.review_decision === 'hold' ? 'hold' : (existingStatus.get(item.id) || 'pending');
      return {
        id: item.id,
        status,
        teacher_image: item.teacher_image,
        source_image: item.source_image,
        prompt: promptItem?.prompt || '',
        subject_tags: promptItem?.meta?.subject_tags || '',
        scene_prompt: promptItem?.meta?.scene_prompt || promptItem?.prompt || '',
        category: promptItem?.category || [],
        notes: promptItem?.notes || '',
        updated_at: timestamp,
      };
    });

  reviewQueue.items = items;
  reviewQueue.summary = recalcReviewQueueSummary(items);

  return {
    data: {
      'review_queue.json': reviewQueue,
    },
    result: {
      success: true,
      count: items.length,
      summary: reviewQueue.summary,
    },
  };
}

function markReviewDecision(context, params) {
  const { pipelineState, reviewQueue, reviewLog } = ensureCollections(context);
  const id = typeof params?.id === 'string' ? params.id : null;
  const decision = typeof params?.decision === 'string' ? params.decision : null;
  const note = typeof params?.note === 'string' ? params.note : '';
  const timestamp = nowIso();

  if (!id || !['yes', 'no', 'hold'].includes(decision || '')) {
    return {
      result: {
        success: false,
        message: 'id and valid decision are required',
      },
    };
  }

  const item = pipelineState.items.find((entry) => entry.id === id);
  if (!item) {
    return {
      result: {
        success: false,
        message: 'pipeline item not found',
      },
    };
  }

  item.review_decision = decision;
  item.review_note = note;
  item.review_status = decision === 'hold' ? 'hold' : 'done';
  item.updated_at = timestamp;

  reviewQueue.items = reviewQueue.items
    .map((entry) => entry.id === id ? { ...entry, status: decision === 'hold' ? 'hold' : 'done', updated_at: timestamp } : entry)
    .filter((entry) => entry.status === 'pending' || entry.status === 'hold');

  const existing = reviewLog.items.find((entry) => entry.id === id);
  if (existing) {
    existing.decision = decision;
    existing.note = note;
    existing.updated_at = timestamp;
  } else {
    reviewLog.items.push({
      id,
      decision,
      note,
      updated_at: timestamp,
    });
  }

  reviewQueue.summary = recalcReviewQueueSummary(reviewQueue.items);
  reviewLog.summary = recalcReviewLogSummary(reviewLog.items);

  return {
    data: {
      'pipeline_state.json': pipelineState,
      'review_queue.json': reviewQueue,
      'review_log.json': reviewLog,
    },
    result: {
      success: true,
      id,
      decision,
      queue_summary: reviewQueue.summary,
      log_summary: reviewLog.summary,
    },
  };
}

const ACTIONS = {
  append_prompt(context, params) {
    return appendPromptItems(context, params);
  },

  append_prompts_bulk(context, params) {
    const items = Array.isArray(params?.items) ? params.items : [];
    if (!items.length) {
      return {
        result: {
          success: false,
          message: 'append items are empty',
        },
      };
    }
    return appendPromptItems(context, items);
  },

  rebuild_pipeline_state(context) {
    const { pipelineState, sourceRuns, teacherRuns, reviewQueue, reviewLog } = ensureCollections(context);
    pipelineState.summary = recalcPipelineSummary(pipelineState.items);
    sourceRuns.summary = recalcBatchSummary(sourceRuns.items);
    teacherRuns.summary = recalcBatchSummary(teacherRuns.items);
    reviewQueue.summary = recalcReviewQueueSummary(reviewQueue.items);
    reviewLog.summary = recalcReviewLogSummary(reviewLog.items);

    return {
      data: {
        'pipeline_state.json': pipelineState,
        'source_runs.json': sourceRuns,
        'teacher_runs.json': teacherRuns,
        'review_queue.json': reviewQueue,
        'review_log.json': reviewLog,
      },
      result: {
        success: true,
        summary: pipelineState.summary,
      },
    };
  },

  create_source_batch(context, params) {
    return createBatch(context, params, 'source');
  },

  start_source_batch(context, params) {
    return startBatch(context, params, 'source');
  },

  mark_source_done(context, params) {
    return updateBatchItem(context, params, 'source', 'done');
  },

  mark_source_error(context, params) {
    return updateBatchItem(context, params, 'source', 'error');
  },

  requeue_source_items(context, params) {
    return requeueItems(context, params, 'source');
  },

  create_teacher_batch(context, params) {
    return createBatch(context, params, 'teacher');
  },

  start_teacher_batch(context, params) {
    return startBatch(context, params, 'teacher');
  },

  mark_teacher_done(context, params) {
    return updateBatchItem(context, params, 'teacher', 'done');
  },

  mark_teacher_error(context, params) {
    return updateBatchItem(context, params, 'teacher', 'error');
  },

  requeue_teacher_items(context, params) {
    return requeueItems(context, params, 'teacher');
  },

  rebuild_review_queue(context) {
    return rebuildReviewQueue(context);
  },

  mark_review_decision(context, params) {
    return markReviewDecision(context, params);
  },

  request_source_stop(context) {
    const { pipelineMeta } = ensureCollections(context);
    pipelineMeta.source_stop_requested = true;
    return {
      data: {
        'pipeline_meta.json': pipelineMeta,
      },
      result: {
        success: true,
        stop_requested: true,
        target: 'source',
      },
    };
  },

  clear_source_stop(context) {
    const { pipelineMeta } = ensureCollections(context);
    pipelineMeta.source_stop_requested = false;
    return {
      data: {
        'pipeline_meta.json': pipelineMeta,
      },
      result: {
        success: true,
        stop_requested: false,
        target: 'source',
      },
    };
  },

  request_teacher_stop(context) {
    const { pipelineMeta } = ensureCollections(context);
    pipelineMeta.teacher_stop_requested = true;
    return {
      data: {
        'pipeline_meta.json': pipelineMeta,
      },
      result: {
        success: true,
        stop_requested: true,
        target: 'teacher',
      },
    };
  },

  clear_teacher_stop(context) {
    const { pipelineMeta } = ensureCollections(context);
    pipelineMeta.teacher_stop_requested = false;
    return {
      data: {
        'pipeline_meta.json': pipelineMeta,
      },
      result: {
        success: true,
        stop_requested: false,
        target: 'teacher',
      },
    };
  },

  start_scheduler(context) {
    const { pipelineMeta } = ensureCollections(context);
    pipelineMeta.scheduler_enabled = true;
    pipelineMeta.scheduler_stop_requested = false;
    pipelineMeta.source_stop_requested = false;
    pipelineMeta.teacher_stop_requested = false;
    return {
      data: {
        'pipeline_meta.json': pipelineMeta,
      },
      result: {
        success: true,
        scheduler_enabled: true,
      },
    };
  },

  stop_scheduler(context) {
    const { pipelineMeta } = ensureCollections(context);
    pipelineMeta.scheduler_stop_requested = true;
    pipelineMeta.source_stop_requested = true;
    pipelineMeta.teacher_stop_requested = true;
    return {
      data: {
        'pipeline_meta.json': pipelineMeta,
      },
      result: {
        success: true,
        scheduler_enabled: true,
        stop_requested: true,
      },
    };
  },

  finish_scheduler(context) {
    const { pipelineMeta } = ensureCollections(context);
    pipelineMeta.scheduler_enabled = false;
    pipelineMeta.scheduler_stop_requested = false;
    pipelineMeta.source_stop_requested = false;
    pipelineMeta.teacher_stop_requested = false;
    return {
      data: {
        'pipeline_meta.json': pipelineMeta,
      },
      result: {
        success: true,
        scheduler_enabled: false,
      },
    };
  },
};

module.exports = async function engine(context, args) {
  const { action, params: wrappedParams, ...rest } = args || {};
  const params = wrappedParams && typeof wrappedParams === 'object' ? wrappedParams : rest;
  const handler = ACTIONS[action];

  if (!handler) {
    return {
      result: {
        success: false,
        message: `unsupported action: ${action}`,
      },
    };
  }

  try {
    return handler(context, params);
  } catch (error) {
    return {
      result: {
        success: false,
        message: error instanceof Error ? error.message : 'unknown error',
      },
    };
  }
};
