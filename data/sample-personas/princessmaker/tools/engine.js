/**
 * Princess Maker Engine — Data-Driven Game Engine
 *
 * All probabilities, thresholds, event pools, mood mappings, stance configs,
 * ending conditions, and competition rules are read from config data files:
 *   - system-config.json  (mood, stance, slot events, HP recovery, stress explosion, wish system)
 *   - events-config.json  (random events, encounter events, seasonal events, wish templates, competitions)
 *   - endings-config.json (ending conditions)
 *   - schedule-config.json (activities, categories, adventure zones)
 *
 * Action list:
 *   advance_slot      — Advance 1 schedule slot (activity processing only; no month advance)
 *   turn_transition   — Advance month (called separately after slot 3)
 *   check_unlocks     — Check activity unlock conditions
 *   adventure         — Auto-combat adventure (called when adventure activity is selected)
 *   buy_item          — Purchase item from shop
 *   use_item          — Use consumable item
 *   equip             — Equip gear/outfit
 *   add_activity      — Dynamically add a new activity
 *   check_ending      — Evaluate ending candidates
 *   generate_wish     — Generate Olive's wish for this month
 *   run_competition   — Run a seasonal competition
 *
 * Slot progression flow:
 *   turn_phase="setup", current_slot=0  -> User sets 3 schedule slots
 *   advance_slot -> slot 1 processed, turn_phase="executing", current_slot=1
 *   advance_slot -> slot 2 processed, current_slot=2
 *   advance_slot -> slot 3 processed, current_slot=3, pending_transition=true
 *   turn_transition -> month advance + unlock check, turn_phase="setup", current_slot=0
 *
 * advance_slot return structure:
 *   result: {
 *     success, slot_number, slot_label, activity_name, activity_category,
 *     activity_context: { total_count, last_period },
 *     stat_changes: { stat: delta },
 *     gold_change, pay_earned, cost_paid,
 *     events: [{ type, message, effects? }],
 *     wish_followed: bool | null,
 *     pending_transition: bool,
 *     adventure_result: { ... } | null
 *   }
 *
 * turn_transition return structure:
 *   result: {
 *     success, needs_narration: bool,
 *     month_summary: {
 *       month, year, age, season, new_unlocks, seasonal_event,
 *       birthday, stress_event, ending_notice, events,
 *       competitions_available, next_wish
 *     }
 *   }
 *
 * generate_wish return structure:
 *   result: { success, wish_category, wish_text }
 *
 * run_competition return structure:
 *   result: {
 *     success, competition_name, rank, rank_index, score,
 *     npc_scores: [{ name, score }], rewards: { stat: delta }
 *   }
 *
 * check_ending return structure:
 *   result: {
 *     success, candidates: [{ name, score, description }],
 *     note: string
 *   }
 */

// ============================================================
// === Utilities ===
// ============================================================

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randRange(arr) {
  if (!arr || arr.length < 2) return 0;
  return rand(arr[0], arr[1]);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// ── Stat Modifier System ──
// All stat gains/losses go through applyStat to apply growth multipliers.
// Modifiers are stored in variables.__stat_modifiers (default 1.0 per stat).
// Float internally, Math.floor() for display.

const MODIFIER_EXEMPT = new Set(['gold', 'hp', 'stress', 'weight', 'reputation']);
const MODIFIER_MIN = 0.1;

/**
 * Apply a stat change with modifier.
 * Returns display delta (floor(new) - floor(old)).
 */
function applyStat(v, stat, rawDelta, modifiers) {
  if (rawDelta === 0) return 0;
  const mod = MODIFIER_EXEMPT.has(stat) ? 1.0
    : Math.max(MODIFIER_MIN, (modifiers || {})[stat] || 1.0);
  const actualDelta = rawDelta * mod;
  const max = v[stat + '_max'] || (stat === 'stress' ? (v.stress_max || 100) : 999);
  const minVal = stat === 'stress' ? -999 : 0;
  const oldVal = v[stat] || 0;
  v[stat] = clamp(oldVal + actualDelta, minVal, max);
  return Math.floor(v[stat]) - Math.floor(oldVal);
}

/**
 * Apply multiple stat changes, returning display deltas.
 * Skips stats with 0 display change.
 */
function applyStatChanges(v, changes, modifiers) {
  const displayDeltas = {};
  for (const [stat, delta] of Object.entries(changes)) {
    const d = applyStat(v, stat, delta, modifiers);
    if (d !== 0) displayDeltas[stat] = d;
  }
  return displayDeltas;
}

/**
 * Get stat modifiers from variables (safe access).
 */
function getModifiers(v) {
  return v.__stat_modifiers || {};
}

function getSeason(month) {
  if (month >= 1 && month <= 3) return '봄';
  if (month >= 4 && month <= 6) return '여름';
  if (month >= 7 && month <= 9) return '가을';
  return '겨울';
}

/**
 * getMood — Read mood from system-config mood_map array.
 * Falls back to '보통' if no config found.
 */
function getMood(stress, sysConfig) {
  const moodMap = (sysConfig && sysConfig.mood_map) || [];
  for (const entry of moodMap) {
    if (stress <= entry.max_stress) return entry.mood;
  }
  // Fallback if stress exceeds all entries
  return moodMap.length > 0 ? moodMap[moodMap.length - 1].mood : '보통';
}

/**
 * calculateWeightChange — Homeostasis-based weight simulation per slot.
 *
 * Design principles:
 *   - Each activity category has a base tendency (martial burns, cooking gains)
 *   - Specific activities can override their category tendency
 *   - Homeostasis pulls weight toward age-appropriate ideal
 *     (stronger the further from ideal, preventing runaway drift)
 *   - Stress eating adds slight gain tendency when stressed
 *   - High stamina adds slight lean tendency
 *   - Hard clamps at ±35-40% of ideal weight prevent absurd extremes
 *   - Result is rounded to integer (weight measured in kg)
 */
function calculateWeightChange(activityId, category, variables, sysConfig) {
  const wc = (sysConfig && sysConfig.weight_system) || {};
  const idealByAge = wc.ideal_weight_by_age || {};
  const catTendency = wc.category_tendency || {};
  const actOverrides = wc.activity_overrides || {};

  const age = variables.age || 10;
  const currentWeight = variables.weight || 30;
  const stress = variables.stress || 0;
  const stamina = variables.stamina || 0;

  // Ideal weight for current age (interpolate if missing)
  const idealWeight = idealByAge[String(age)] || idealByAge['18'] || 55;

  // Deviation: positive = overweight, negative = underweight
  const deviation = (currentWeight - idealWeight) / idealWeight;

  // Base tendency: activity-specific override > category default
  const tendency = actOverrides[activityId] ?? catTendency[category] ?? 0;

  // Random variance
  const varianceAmp = wc.variance || 0.8;
  const variance = (Math.random() * 2 - 1) * varianceAmp;

  // Homeostasis: pulls toward ideal weight
  const homeStrength = wc.homeostasis_strength || 3.0;
  const homeostasis = -deviation * homeStrength;

  // Stress eating modifier
  const stressEating = wc.stress_eating || {};
  let stressMod = 0;
  if (stress >= (stressEating.threshold || 60)) {
    stressMod = stressEating.bonus || 0.4;
  }

  // High stamina lean bonus
  const staminaLean = wc.stamina_lean_bonus || {};
  let staminaMod = 0;
  if (stamina >= (staminaLean.threshold || 150)) {
    staminaMod = staminaLean.factor || -0.2;
  }

  // Combine all factors
  const raw = tendency + variance + homeostasis + stressMod + staminaMod;
  const delta = Math.round(raw);

  // Hard clamps based on age-appropriate range
  const minRatio = wc.min_weight_ratio || 0.65;
  const maxRatio = wc.max_weight_ratio || 1.6;
  const minWeight = Math.floor(idealWeight * minRatio);
  const maxWeight = Math.ceil(idealWeight * maxRatio);
  const newWeight = clamp(currentWeight + delta, minWeight, maxWeight);

  return newWeight - currentWeight;
}

/**
 * computeStance — Read stance groups and thresholds from system-config stance_config.
 */
function computeStance(vars, sysConfig, gameState) {
  const stanceConfig = (sysConfig && sysConfig.stance_config) || {};
  const stressOverride = stanceConfig.stress_override || {};
  const stress = vars.stress || 0;

  // Priority 1: Stress overrides (check in descending order)
  const overrides = Object.entries(stressOverride).sort((a, b) => b[1] - a[1]);
  for (const [stance, threshold] of overrides) {
    if (stress >= threshold) return stance;
  }

  // Priority 2: Dark path stances (preemptive over normal stances)
  const gs = gameState || {};
  if (gs.dark_path) {
    const darkStances = stanceConfig.dark_stances || [];
    const age = vars.age || 10;
    const morals = vars.morals || 0;
    // Direction: sensitivity > combat → sub path, otherwise → dom path
    const side = (vars.sensitivity || 0) > (vars.combat || 0) ? 'sub' : 'dom';

    for (const ds of darkStances) {
      if (age < (ds.age_min || 0)) continue;
      if (morals > (ds.morals_max ?? 999)) continue;
      if (ds.side && ds.side !== side) continue;
      if ((vars[ds.stat] || 0) < (ds.stat_min || 0)) continue;
      return ds.stance;
    }
  }

  // Priority 3: Compute dominant stat group (normal stances)
  const groups = stanceConfig.groups || {};
  const baseThreshold = stanceConfig.base_threshold || 40;
  const perYear = stanceConfig.threshold_per_year || 10;
  const threshold = baseThreshold + (vars.current_year || 1) * perYear;

  let best = 'default';
  let bestVal = threshold;

  for (const [stanceName, groupDef] of Object.entries(groups)) {
    const stats = groupDef.stats || [];
    const weights = groupDef.weight || [];
    let val = 0;
    for (let i = 0; i < stats.length; i++) {
      val += (vars[stats[i]] || 0) * (weights[i] || 0);
    }
    if (val > bestVal) {
      bestVal = val;
      best = stanceName;
    }
  }

  return best;
}

function meetsRequirements(reqs, vars) {
  for (const [key, val] of Object.entries(reqs)) {
    if (key === 'hp_min') {
      if ((vars.hp || 0) < val) return false;
    } else if (key === 'age') {
      if ((vars.age || 0) < val) return false;
    } else if (key.endsWith('_lt')) {
      // Less-than condition (e.g. morals_lt: 50 means morals < 50)
      const stat = key.replace('_lt', '');
      if ((vars[stat] || 0) >= val) return false;
    } else {
      if ((vars[key] || 0) < val) return false;
    }
  }
  return true;
}

function addLogEntry(eventLog, entry) {
  const log = eventLog.log ? [...eventLog.log] : [];
  log.unshift(entry);
  const max = eventLog.max_entries || 30;
  while (log.length > max) log.pop();
  return { ...eventLog, log };
}

const SLOT_LABELS = ['', '상순', '중순', '하순'];

/**
 * Pick one item from a weighted pool.
 * Each item must have a `weight` property.
 */
function pickWeighted(pool) {
  const totalWeight = pool.reduce((sum, e) => sum + (e.weight || 1), 0);
  let roll = Math.random() * totalWeight;
  for (const item of pool) {
    roll -= (item.weight || 1);
    if (roll <= 0) return item;
  }
  return pool[0];
}

/**
 * getMainStatForCategory — look up the primary stat for an activity category.
 * Uses the stance_config groups as a mapping heuristic, plus explicit fallbacks.
 */
function getMainStatForCategory(category, vars, sysConfig) {
  // Explicit category -> stat mapping for categories that don't map 1:1 to stance groups
  const explicitMap = {
    study: 'intelligence',
    martial: 'combat',
    arts: 'art',
    etiquette: 'etiquette',
    faith: 'faith',
    cooking: 'cooking',
    magic: 'magic_power',
    job: 'charm',
    adventure: 'combat',
    rest: 'stamina'
  };
  const statName = explicitMap[category];
  return statName ? (vars[statName] || 0) : 0;
}

function getEquipBonus(inv, stat) {
  const equipment = inv.equipment || {};
  const catalog = inv.shop_catalog || {};
  let bonus = 0;
  for (const item of Object.values(equipment)) {
    if (item && catalog[item]?.stats?.[stat]) bonus += catalog[item].stats[stat];
  }
  const outfit = (inv.outfits || []).find(o => o.id === inv.equipped_outfit);
  if (outfit?.stats?.[stat]) bonus += outfit.stats[stat];
  return bonus;
}


// ============================================================
// === Daily Simulation System ===
// ============================================================

/**
 * Categories that use day-by-day simulation.
 * rest, adventure, and free_time use the old single-roll behavior.
 */
const DAILY_SIM_CATEGORIES = new Set([
  'study', 'martial', 'arts', 'etiquette', 'faith', 'cooking', 'magic', 'job'
]);

/**
 * calcDailySuccessRate — Calculate success probability for one day.
 *
 * Factors: proficiency (sqrt of relevant stat), stance alignment,
 * stress penalty, HP condition, cumulative fatigue.
 *
 * Starting stats (~25): ~80%  |  Mid-game (~100): ~84%  |  High (~400): ~90%+
 * High stress (80): -24%  |  Low HP: -10%  |  Fatigue: -0.5% per day
 */
function calcDailySuccessRate(activity, currentVars, dayIndex, sysConfig, activityCount) {
  const cfg = ((sysConfig || {}).daily_simulation || {}).success_rate || {};
  const mainStat = getMainStatForCategory(activity.category, currentVars, sysConfig);

  let rate = cfg.base || 0.70;

  // Proficiency: sqrt scaling (diminishing returns at high stats)
  rate += Math.sqrt(mainStat) * (cfg.stat_factor || 0.02);

  // Repetition bonus: how many times this specific activity has been done before
  // log2 curve: 1회→0, 2회→+3%, 4회→+6%, 8회→+9%, 16회→+12%
  const repCount = activityCount || 0;
  if (repCount > 0) {
    rate += Math.log2(repCount + 1) * (cfg.repetition_factor || 0.04);
  }

  // Stance alignment bonus
  const stanceGroups = ((sysConfig.stance_config || {}).groups || {});
  const stanceData = stanceGroups[currentVars.stance || 'default'];
  if (stanceData) {
    const catStats = {
      study: 'intelligence', martial: 'combat', arts: 'art',
      etiquette: 'etiquette', faith: 'faith', cooking: 'cooking',
      magic: 'magic_power', job: 'charm'
    };
    if (stanceData.stats && stanceData.stats.includes(catStats[activity.category])) {
      rate += cfg.stance_bonus || 0.05;
    }
  }

  // Stress penalty
  rate -= (currentVars.stress || 0) * (cfg.stress_factor || 0.003);

  // Low HP penalty
  const hpRatio = (currentVars.hp || 1) / (currentVars.hp_max || 1);
  if (hpRatio < (cfg.low_hp_threshold || 0.3)) {
    rate -= cfg.low_hp_penalty || 0.10;
  }

  // Fatigue per day
  rate -= dayIndex * (cfg.fatigue_per_day || 0.005);

  return clamp(rate, cfg.min_rate || 0.15, cfg.max_rate || 0.95);
}

/**
 * simulateSlotDaily — Run day-by-day simulation for one slot.
 *
 * Each day: roll success → apply daily stat gain (full on success, reduced on fail)
 * → daily pay for job activities → stress accumulation + failure penalty
 *
 * Returns { steps[], successCount, workingDays, totalStatChanges, totalGoldChange, totalPayEarned }
 *
 * steps[]: { day, success, success_rate, day_changes, cumulative_vars }
 *   - cumulative_vars: absolute stat values after this day (for animation)
 */
function simulateSlotDaily(activity, vars, sysConfig, activityCount) {
  const cfg = (sysConfig || {}).daily_simulation || {};
  const workingDays = cfg.working_days || 8;
  const failCfg = cfg.on_failure || {};
  const statGainOnFail = failCfg.stat_gain_ratio || 0.3;
  const payOnFail = failCfg.pay_ratio || 0.0;
  const stressPerFail = failCfg.stress_per_fail || 1;

  // Pre-calculate daily base values from activity definition
  const dailyStats = {};  // non-stress stats from effects
  let dailyStressBase = 0;

  if (activity.effects) {
    for (const [stat, range] of Object.entries(activity.effects)) {
      const avg = (range[0] + range[1]) / 2;
      if (stat === 'stress') {
        dailyStressBase = avg / workingDays;
      } else {
        dailyStats[stat] = avg / workingDays;
      }
    }
  }

  // Side effects (always apply, no success variance)
  const dailySideEffects = {};
  if (activity.side_effects) {
    for (const [stat, range] of Object.entries(activity.side_effects)) {
      const avg = (range[0] + range[1]) / 2;
      dailySideEffects[stat] = avg / workingDays;
    }
  }

  // Job pay
  const dailyPay = activity.pay
    ? ((activity.pay[0] + activity.pay[1]) / 2) / workingDays
    : 0;

  // Job stat bonus
  const dailyBonus = {};
  if (activity.stat_bonus) {
    for (const [stat, range] of Object.entries(activity.stat_bonus)) {
      const avg = (range[0] + range[1]) / 2;
      dailyBonus[stat] = avg / workingDays;
    }
  }

  // Collect all tracked stats for cumulative snapshots
  const trackedStats = new Set(['gold', 'stress']);
  for (const s of Object.keys(dailyStats)) trackedStats.add(s);
  for (const s of Object.keys(dailySideEffects)) trackedStats.add(s);
  for (const s of Object.keys(dailyBonus)) trackedStats.add(s);

  // Initialize cumulative values from current vars
  const cum = {};
  for (const stat of trackedStats) {
    cum[stat] = vars[stat] || 0;
  }

  const steps = [];
  let successCount = 0;

  for (let day = 0; day < workingDays; day++) {
    // Build a virtual vars snapshot for success rate calc (stress evolves during sim)
    const simVars = { ...vars };
    for (const stat of trackedStats) {
      simVars[stat] = cum[stat];
    }

    const rate = calcDailySuccessRate(activity, simVars, day, sysConfig, activityCount);
    const success = Math.random() < rate;
    if (success) successCount++;

    const dayDeltas = {};

    // Main stat effects (success: full gain, failure: reduced)
    for (const [stat, dailyBase] of Object.entries(dailyStats)) {
      const variance = 0.7 + Math.random() * 0.6; // 0.7 ~ 1.3
      const gain = dailyBase * variance * (success ? 1.0 : statGainOnFail);
      cum[stat] = (cum[stat] || 0) + gain;
      dayDeltas[stat] = gain;
    }

    // Stress: base daily portion + extra penalty on failure
    const stressGain = dailyStressBase + (success ? 0 : stressPerFail);
    cum.stress = clamp((cum.stress || 0) + stressGain, 0, vars.stress_max || 100);
    dayDeltas.stress = stressGain;

    // Side effects (always apply, independent of success)
    for (const [stat, dailyBase] of Object.entries(dailySideEffects)) {
      const gain = dailyBase * (0.8 + Math.random() * 0.4);
      cum[stat] = Math.max(0, (cum[stat] || 0) + gain);
      dayDeltas[stat] = (dayDeltas[stat] || 0) + gain;
    }

    // Job pay
    if (dailyPay > 0) {
      const variance = 0.8 + Math.random() * 0.4;
      const earned = success ? Math.round(dailyPay * variance) : Math.round(dailyPay * payOnFail);
      cum.gold = (cum.gold || 0) + earned;
      dayDeltas.gold = earned;
    }

    // Job stat bonus
    for (const [stat, dailyBase] of Object.entries(dailyBonus)) {
      const variance = 0.7 + Math.random() * 0.6;
      const gain = dailyBase * variance * (success ? 1.0 : statGainOnFail);
      cum[stat] = (cum[stat] || 0) + gain;
      dayDeltas[stat] = (dayDeltas[stat] || 0) + gain;
    }

    // Build cumulative snapshot (rounded, clamped)
    const snapshot = {};
    for (const stat of trackedStats) {
      if (stat === 'gold') {
        snapshot.gold = Math.max(0, Math.round(cum.gold));
      } else if (stat === 'stress') {
        snapshot.stress = clamp(Math.round(cum.stress), 0, vars.stress_max || 100);
      } else {
        const max = vars[stat + '_max'] || 999;
        snapshot[stat] = clamp(Math.round(cum[stat]), 0, max);
      }
    }

    steps.push({
      day: day + 1,
      success,
      success_rate: Math.round(rate * 100),
      cumulative_vars: snapshot
    });
  }

  // Calculate total changes from simulation
  const totalStatChanges = {};
  let totalGoldChange = 0;
  let totalPayEarned = 0;

  for (const stat of trackedStats) {
    const finalVal = stat === 'stress'
      ? clamp(Math.round(cum[stat]), 0, vars.stress_max || 100)
      : stat === 'gold'
        ? Math.max(0, Math.round(cum[stat]))
        : clamp(Math.round(cum[stat]), 0, vars[stat + '_max'] || 999);
    const origVal = vars[stat] || 0;
    const delta = finalVal - origVal;
    if (stat === 'gold') {
      totalGoldChange = delta;
    } else if (delta !== 0) {
      totalStatChanges[stat] = delta;
    }
  }
  totalPayEarned = Math.max(0, totalGoldChange); // pay portion (cost was deducted before sim)

  return { steps, successCount, workingDays, totalStatChanges, totalGoldChange, totalPayEarned };
}


// ============================================================
// === Slot Event System (data-driven from system-config) ===
// ============================================================

/**
 * rollSlotEvents — Generate events for a single slot execution.
 * All probabilities and thresholds read from sysConfig.slot_events.
 */
function rollSlotEvents(act, vars, slotNum, sysConfig, eventsConfig, options) {
  const events = [];
  const stress = vars.stress || 0;
  const slotEvtCfg = (sysConfig && sysConfig.slot_events) || {};
  const skipCritFail = (options && options.skipCritFail) || false;
  const gameState = (options && options.gameState) || null;
  const actId = (options && options.actId) || null;

  if (!skipCritFail) {
    // --- Critical success ---
    const critCfg = slotEvtCfg.critical_success || {};
    const critBaseChance = critCfg.base_chance || 0.10;
    const critStatDivisor = critCfg.stat_bonus_divisor || 3000;
    const critMaxBonus = critCfg.max_stat_bonus || 0.15;
    const critMultiplier = critCfg.multiplier || 1.5;
    const mainStat = getMainStatForCategory(act.category, vars, sysConfig);
    const critChance = critBaseChance + Math.min(critMaxBonus, mainStat / critStatDivisor);
    if (Math.random() < critChance) {
      events.push({
        type: 'critical_success',
        message: '대성공! 평소보다 훨씬 집중해서 큰 성과를 올렸다!',
        multiplier: critMultiplier
      });
    }

    // --- Failure ---
    const failCfg = slotEvtCfg.failure || {};
    const failBaseChance = failCfg.base_chance || 0.05;
    const failStressDivisor = failCfg.stress_divisor || 400;
    const failMultiplier = failCfg.multiplier || 0.4;
    const failChance = failBaseChance + stress / failStressDivisor;
    if (events.length === 0 && Math.random() < failChance) {
      events.push({
        type: 'failure',
        message: '컨디션이 좋지 않아서 잘 되지 않았다...',
        multiplier: failMultiplier
      });
    }
  }

  // --- Exam event ---
  const examCfg = slotEvtCfg.exam || {};
  const examCategories = examCfg.categories || ['study', 'magic'];
  const examInterval = examCfg.interval_months || 3;
  const examSlotReq = examCfg.slot_required || 3;
  if (examCategories.includes(act.category) && (vars.current_month || 1) % examInterval === 0 && slotNum === examSlotReq) {
    const threshBase = (examCfg.threshold_base || {})[act.category] || 20;
    const threshYear = (examCfg.threshold_per_year || {})[act.category] || 30;
    const statKey = (examCfg.stat_key || {})[act.category] || 'intelligence';
    const threshold = threshBase + (vars.current_year || 1) * threshYear;
    const stat = vars[statKey] || 0;
    const passed = stat >= threshold;
    events.push({
      type: 'exam',
      passed,
      message: passed
        ? '학기말 시험에 합격했다! 선생님에게 칭찬을 받았다.'
        : '학기말 시험 결과가 좋지 않았다... 더 열심히 해야겠다.',
      effects: passed ? { ...(examCfg.pass_effects || {}) } : { ...(examCfg.fail_effects || {}) }
    });
  }

  // --- Sparring event ---
  const sparCfg = slotEvtCfg.sparring || {};
  const sparCategories = sparCfg.categories || ['martial'];
  if (sparCategories.includes(act.category) && Math.random() < (sparCfg.chance || 0.30)) {
    const sparStatKey = sparCfg.stat_key || 'combat';
    const sparVariance = sparCfg.roll_variance || 20;
    const sparOpponentBase = sparCfg.opponent_base || 30;
    const sparOpponentYear = sparCfg.opponent_per_year || 20;
    const won = (vars[sparStatKey] || 0) + rand(-sparVariance, sparVariance) > rand(sparOpponentBase, sparOpponentBase + (vars.current_year || 1) * sparOpponentYear);
    events.push({
      type: 'sparring',
      message: won
        ? '도장의 선배와 대련에서 이겼다! 사기가 올랐다.'
        : '도장의 선배에게 졌다. 아직 갈 길이 멀다.',
      effects: won ? { ...(sparCfg.win_effects || {}) } : { ...(sparCfg.lose_effects || {}) }
    });
  }

  // --- Taste test event ---
  const tasteCfg = slotEvtCfg.taste_test || {};
  const tasteCategories = tasteCfg.categories || ['cooking'];
  if (tasteCategories.includes(act.category) && Math.random() < (tasteCfg.chance || 0.25)) {
    const tasteStatKey = tasteCfg.stat_key || 'cooking';
    const tasteVariance = tasteCfg.roll_variance || 20;
    const tasteThreshold = tasteCfg.threshold || 40;
    const quality = (vars[tasteStatKey] || 0) + rand(-10, tasteVariance);
    const good = quality > tasteThreshold;
    events.push({
      type: 'taste_test',
      message: good
        ? '만든 요리가 호평을 받았다! "맛있어!" 소리를 들었다.'
        : '오늘 요리는 살짝 간이 세다... 다음엔 더 잘해보자.',
      effects: good ? { ...(tasteCfg.win_effects || {}) } : {}
    });
  }

  // --- Inspiration event ---
  const inspireCfg = slotEvtCfg.inspiration || {};
  const inspireCategories = inspireCfg.categories || ['arts'];
  if (inspireCategories.includes(act.category) && Math.random() < (inspireCfg.chance || 0.20)) {
    events.push({
      type: 'inspiration',
      message: '갑자기 영감이 떠올랐다! 멋진 작품이 탄생했다.',
      effects: { ...(inspireCfg.effects || {}) }
    });
  }

  // --- Tip event ---
  const tipCfg = slotEvtCfg.tip || {};
  const tipCategories = tipCfg.categories || ['job'];
  if (tipCategories.includes(act.category) && Math.random() < (tipCfg.chance || 0.20)) {
    const goldRange = tipCfg.gold_range || [5, 25];
    const tipAmount = randRange(goldRange);
    events.push({
      type: 'tip',
      message: `손님에게 팁 ${tipAmount}G을 받았다! 열심히 일한 보람이 있다.`,
      effects: { gold: tipAmount }
    });
  }

  // --- Random encounter event ---
  const encounterCfg = slotEvtCfg.encounter || {};
  const encounterChance = encounterCfg.chance || 0.12;
  const excludedCats = encounterCfg.excluded_categories || ['rest'];
  // dark_only activities bypass rest exclusion (e.g., dark_lounge)
  const isExcluded = excludedCats.includes(act.category) && !act.dark_only;
  if (Math.random() < encounterChance && !isExcluded) {
    events.push(generateEncounterEvent(vars, act, eventsConfig, actId, gameState));
  }

  return events;
}

/**
 * generateEncounterEvent — Pick from events-config encounter_events pool.
 * When dark_path is enabled, merges dark_encounter_events (filtered by activity).
 */
function generateEncounterEvent(vars, act, eventsConfig, actId, gameState) {
  const age = vars.age || 10;
  let pool = [...((eventsConfig && eventsConfig.encounter_events) || [])];
  if (gameState?.dark_path) {
    const darkPool = (eventsConfig.dark_encounter_events || [])
      .filter(e => !e.activities || e.activities.includes(actId));
    pool = [...pool, ...darkPool];
  }
  // Filter by age_min / age_max
  pool = pool.filter(e => {
    if (e.age_min && age < e.age_min) return false;
    if (e.age_max && age > e.age_max) return false;
    return true;
  });
  if (pool.length === 0) {
    return { type: 'encounter', message: '특별한 일은 없었다.', effects: {} };
  }
  const picked = pickWeighted(pool);
  const isDark = !!(picked.activities || (eventsConfig.dark_encounter_events || []).includes(picked));
  return { type: isDark ? 'dark_encounter' : 'encounter', message: picked.message, effects: { ...(picked.effects || {}) } };
}

/**
 * generateRandomEvent — Pick from events-config random_events pool.
 * When dark_path is enabled, merges dark_random_events.
 */
function generateRandomEvent(vars, eventsConfig, gameState) {
  const age = vars.age || 10;
  let pool = [...((eventsConfig && eventsConfig.random_events) || [])];
  if (gameState?.dark_path) {
    pool = [...pool, ...(eventsConfig.dark_random_events || [])];
  }
  // Filter by age_min / age_max
  pool = pool.filter(e => {
    if (e.age_min && age < e.age_min) return false;
    if (e.age_max && age > e.age_max) return false;
    return true;
  });
  if (pool.length === 0) {
    return { type: 'random', message: '평범한 하루였다.', effects: {} };
  }
  const picked = pickWeighted(pool);
  return { type: 'random', message: picked.message, effects: { ...(picked.effects || {}) } };
}


// ============================================================
// === Wish System ===
// ============================================================

/**
 * generateWishInternal — Compute what Olive wants to do this month.
 *
 * High stress -> wishes for rest.
 * Otherwise pick category based on:
 *   - highest/growing stats (preference_weights.high_stat)
 *   - recent success activities (preference_weights.recent_success)
 *   - low-stress activities (preference_weights.low_stress_activity)
 *   - randomness (preference_weights.random)
 *
 * Returns { wish_category, wish_text }
 */
function generateWishInternal(vars, sysConfig, eventsConfig, scheduleConfig, gameState) {
  const wishSys = (sysConfig && sysConfig.wish_system) || {};
  const prefWeights = wishSys.preference_weights || {
    recent_success: 0.3, high_stat: 0.25, low_stress_activity: 0.2, random: 0.25
  };
  const wishTemplates = (eventsConfig && eventsConfig.wish_templates) || {};
  const activities = (scheduleConfig && scheduleConfig.activities) || {};
  const categories = (scheduleConfig && scheduleConfig.categories) || {};
  const stress = vars.stress || 0;
  const name = vars.name || '올리브';
  const state = gameState || {};

  // High stress -> wish for rest
  if (stress >= 70) {
    const restTexts = wishTemplates['rest'] || ['{name}가 쉬고 싶어한다.'];
    const text = restTexts[rand(0, restTexts.length - 1)].replace(/\{name\}/g, name);
    return { wish_category: 'rest', wish_text: text };
  }

  // Build candidate categories with scores
  // Only include categories that have at least one unlocked activity
  const unlocked = new Set(state.unlocked_activities || []);
  const catScores = {};
  const availableCats = Object.keys(categories).filter(c => {
    if (c === 'rest') return false;
    // Check if any unlocked activity belongs to this category
    for (const [actId, act] of Object.entries(activities)) {
      if (act.category === c && unlocked.has(actId)) return true;
    }
    return false;
  });

  for (const cat of availableCats) {
    catScores[cat] = 0;
  }

  // High stat weight: use sqrt curve to flatten extreme dominance
  // (stat 275 vs 25 → linear: 11x difference → sqrt: 3.3x difference)
  const catStatMap = {
    study: 'intelligence', martial: 'combat', arts: 'art',
    etiquette: 'etiquette', faith: 'faith', cooking: 'cooking',
    magic: 'magic_power', job: 'charm', adventure: 'combat'
  };
  let maxStatSqrt = 0;
  for (const cat of availableCats) {
    const statKey = catStatMap[cat];
    if (statKey) {
      const val = Math.sqrt(vars[statKey] || 0);
      if (val > maxStatSqrt) maxStatSqrt = val;
    }
  }
  if (maxStatSqrt > 0) {
    for (const cat of availableCats) {
      const statKey = catStatMap[cat];
      if (statKey) {
        catScores[cat] += (Math.sqrt(vars[statKey] || 0) / maxStatSqrt) * (prefWeights.high_stat || 0.25);
      }
    }
  }

  // Recent success: check last 3 schedule slots for what was recently done
  const recentActivities = [];
  for (let i = 1; i <= 3; i++) {
    const actId = vars[`schedule_${i}`];
    if (actId && actId !== 'none' && activities[actId]) {
      recentActivities.push(activities[actId].category);
    }
  }
  for (const cat of recentActivities) {
    if (catScores[cat] !== undefined) {
      catScores[cat] += (prefWeights.recent_success || 0.3) / Math.max(1, recentActivities.length);
    }
  }

  // Low stress preference: categories with lower typical stress get a boost
  for (const cat of availableCats) {
    let totalStress = 0;
    let count = 0;
    for (const act of Object.values(activities)) {
      if (act.category === cat && act.effects && act.effects.stress) {
        const avg = (act.effects.stress[0] + act.effects.stress[1]) / 2;
        totalStress += avg;
        count++;
      }
    }
    if (count > 0) {
      const avgStress = totalStress / count;
      const stressScore = Math.max(0, 1 - avgStress / 15);
      catScores[cat] += stressScore * (prefWeights.low_stress_activity || 0.2);
    }
  }

  // Anti-repetition: penalize if same wish as last month (or last 2 months)
  const wishHistory = state.wish_history || [];
  for (let i = 0; i < Math.min(wishHistory.length, 3); i++) {
    const prevCat = wishHistory[wishHistory.length - 1 - i];
    if (prevCat && catScores[prevCat] !== undefined) {
      // Most recent: -40%, 2nd: -20%, 3rd: -10%
      const penalty = [0.4, 0.2, 0.1][i] || 0;
      catScores[prevCat] *= (1 - penalty);
    }
  }

  // Personality boost: curious personality gets extra random spread
  const personality = vars.personality || '';
  const randomWeight = prefWeights.random || 0.25;
  const randomBoost = personality === 'curious' ? 1.5 : 1.0;

  // Random factor
  for (const cat of availableCats) {
    catScores[cat] += Math.random() * randomWeight * randomBoost;
  }

  // Weighted random selection instead of argmax
  // (every category has a chance proportional to its score)
  const totalScore = Object.values(catScores).reduce((s, v) => s + Math.max(v, 0.01), 0);
  let roll = Math.random() * totalScore;
  let bestCat = availableCats[0] || 'rest';
  for (const [cat, score] of Object.entries(catScores)) {
    roll -= Math.max(score, 0.01);
    if (roll <= 0) {
      bestCat = cat;
      break;
    }
  }

  // Pick a wish text template
  const templates = wishTemplates[bestCat] || ['{name}는 이번 달에 무언가를 하고 싶어한다.'];
  const text = templates[rand(0, templates.length - 1)].replace(/\{name\}/g, name);

  return { wish_category: bestCat, wish_text: text };
}


// ============================================================
// === Competition System ===
// ============================================================

/**
 * runCompetitionInternal — Simulate a seasonal competition.
 *
 * Reads competition definition from events-config seasonal_events.
 * Simulates against NPC_COUNT npcs with configurable variance.
 * Returns { success, competition_name, rank, rank_index, score, npc_scores, rewards }
 */
function runCompetitionInternal(competitionId, vars, eventsConfig, sysConfig) {
  const seasonalEvents = (eventsConfig && eventsConfig.seasonal_events) || {};
  const compConfig = (eventsConfig && eventsConfig.competition_config) || {};

  // Find the competition definition across all seasonal events (including dark competitions)
  let compDef = null;
  for (const evt of Object.values(seasonalEvents)) {
    const comps = evt.competitions || [];
    const found = comps.find(c => c.id === competitionId);
    if (found) { compDef = found; break; }
    // Also search dark_competitions
    if (evt.dark_competitions) {
      const darkFound = evt.dark_competitions.find(c => c.id === competitionId);
      if (darkFound) { compDef = darkFound; break; }
    }
  }
  if (!compDef) {
    return { success: false, message: `알 수 없는 대회: ${competitionId}` };
  }

  const npcCount = compConfig.npc_count || 5;
  const npcBaseStat = compConfig.npc_base_stat || 50;
  const npcStatPerYear = compConfig.npc_stat_per_year || 30;
  const npcVariance = compConfig.npc_variance || 30;
  const playerVariance = compConfig.player_variance || 20;
  const ranks = compConfig.ranks || ['우승', '준우승', '3위', '참가상'];
  const rewardTable = compConfig.rewards || {};

  // Calculate player score
  let playerBaseStat = vars[compDef.stat] || 0;
  if (compDef.stat2) {
    playerBaseStat = Math.floor((playerBaseStat + (vars[compDef.stat2] || 0)) / 2);
  }
  const playerScore = playerBaseStat + rand(-playerVariance, playerVariance);

  // Generate NPC scores
  const npcNames = ['알렉스', '리사', '마르코', '에밀리', '카를로', '소피아', '하인츠', '메이'];
  const npcScores = [];
  const yearFactor = (vars.current_year || 1);
  for (let i = 0; i < npcCount; i++) {
    const npcBase = npcBaseStat + yearFactor * npcStatPerYear + rand(-npcVariance, npcVariance);
    npcScores.push({
      name: npcNames[i % npcNames.length],
      score: npcBase
    });
  }

  // Determine rank
  const allScores = [{ name: vars.name || '올리브', score: playerScore, isPlayer: true }, ...npcScores];
  allScores.sort((a, b) => b.score - a.score);

  const playerRankIndex = allScores.findIndex(s => s.isPlayer);
  let rank;
  if (playerRankIndex < ranks.length - 1) {
    rank = ranks[playerRankIndex];
  } else {
    rank = ranks[ranks.length - 1]; // 참가상
  }

  // Get rewards
  const rewards = { ...(rewardTable[rank] || {}) };

  return {
    success: true,
    competition_name: compDef.name,
    category: compDef.category,
    rank,
    rank_index: playerRankIndex,
    score: playerScore,
    npc_scores: npcScores.sort((a, b) => b.score - a.score),
    rewards
  };
}


// ============================================================
// === Popup Effect Collector ===
// ============================================================

/**
 * collectPopups — Examine events and results, return a popups array for result.
 * Max 3 popups per turn, prioritized by importance.
 *
 * @param {Array} events - Slot events (critical_success, failure, perfect_run, etc.)
 * @param {Object|null} monthSummary - Month advancement summary (birthday, unlock, seasonal, etc.)
 * @param {Object|null} simResult - Daily simulation result (for perfect_run check)
 * @param {Object|null} compResult - Competition result
 * @param {Object|null} adventureResult - Adventure combat result
 * @returns {Array} popups array (may be empty)
 */
function collectPopups(events, monthSummary, simResult, compResult, adventureResult) {
  // Each candidate: { priority, popup }
  // Lower priority number = higher importance
  const candidates = [];

  // --- Slot events ---
  for (const evt of (events || [])) {
    if (evt.type === 'runaway' || evt.type === 'sick') {
      candidates.push({
        priority: 1,
        popup: {
          template: 'alert',
          duration: 4000,
          vars: {
            title: evt.type === 'runaway' ? '가출!' : '과로!',
            message: evt.message
          }
        }
      });
    } else if (evt.type === 'perfect_run') {
      candidates.push({
        priority: 3,
        popup: { template: 'perfect-run', duration: 4000, vars: { message: evt.message } }
      });
    } else if (evt.type === 'critical_success') {
      candidates.push({
        priority: 4,
        popup: { template: 'critical-success', duration: 3500, vars: { message: evt.message } }
      });
    } else if (evt.type === 'failure') {
      candidates.push({
        priority: 8,
        popup: { template: 'failure', duration: 3000, vars: { message: evt.message } }
      });
    }
  }

  // --- Competition result ---
  if (compResult && compResult.success) {
    candidates.push({
      priority: 2,
      popup: {
        template: 'competition',
        duration: 4000,
        vars: {
          competition_name: compResult.competition_name,
          rank: compResult.rank,
          score: compResult.score
        }
      }
    });
  }

  // --- Month summary events ---
  if (monthSummary) {
    // Ending notice (highest priority among month events)
    if (monthSummary.ending_notice) {
      candidates.push({
        priority: 1,
        popup: {
          template: 'alert',
          duration: 5000,
          vars: { title: '성장 완료', message: monthSummary.ending_notice }
        }
      });
    }

    // Stress explosion events (runaway/sick) from monthSummary.stress_event
    if (monthSummary.stress_event) {
      const se = monthSummary.stress_event;
      candidates.push({
        priority: 1,
        popup: {
          template: 'alert',
          duration: 4000,
          vars: {
            title: se.type === 'runaway' ? '가출!' : '과로!',
            message: se.message
          }
        }
      });
    }

    // Birthday
    if (monthSummary.birthday) {
      candidates.push({
        priority: 5,
        popup: { template: 'birthday', duration: 4000, vars: {} }
      });
    }

    // Seasonal event
    if (monthSummary.seasonal_event) {
      candidates.push({
        priority: 6,
        popup: {
          template: 'seasonal',
          duration: 3500,
          vars: {
            event_name: monthSummary.seasonal_event.name || monthSummary.seasonal_event.season_event || '계절 이벤트',
            message: monthSummary.seasonal_event.message
          }
        }
      });
    }

    // Unlocks
    if (monthSummary.new_unlocks && monthSummary.new_unlocks.length > 0) {
      for (const actName of monthSummary.new_unlocks) {
        candidates.push({
          priority: 7,
          popup: { template: 'unlock', duration: 3500, vars: { activity_name: actName } }
        });
      }
    }
  }

  // --- Adventure result ---
  if (adventureResult) {
    const allWon = adventureResult.battles && adventureResult.battles.every(b => b.won);
    const defeated = adventureResult.hp_remaining <= 0;
    if (defeated) {
      candidates.push({
        priority: 2,
        popup: {
          template: 'adventure-defeat',
          duration: 4000,
          vars: { zone_name: adventureResult.zone || '???' }
        }
      });
    } else if (allWon && adventureResult.battles && adventureResult.battles.length > 0) {
      const lootParts = [];
      if (adventureResult.total_gold > 0) lootParts.push(`${adventureResult.total_gold}G`);
      if (adventureResult.treasures && adventureResult.treasures.length > 0) lootParts.push(adventureResult.treasures.join(', '));
      candidates.push({
        priority: 3,
        popup: {
          template: 'adventure-victory',
          duration: 3500,
          vars: {
            zone_name: adventureResult.zone || '???',
            loot: lootParts.length > 0 ? lootParts.join(' + ') : null
          }
        }
      });
    }
  }

  if (candidates.length === 0) return [];

  // Sort by priority (lower = more important), keep top 3
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates.slice(0, 3).map(c => c.popup);
}


// ============================================================
// === Month Advancement ===
// ============================================================

function advanceMonth(v, config, state, eventLog, sysConfig, eventsConfig) {
  const activities = config.activities || {};
  const events = [];

  // --- Stress explosion check (from system-config) ---
  const stressExpCfg = (sysConfig && sysConfig.stress_explosion) || {};
  const stressThreshold = stressExpCfg.threshold || 100;
  let stressEvent = null;
  if (v.stress >= stressThreshold) {
    const runawayCfg = stressExpCfg.runaway || {};
    const sickCfg = stressExpCfg.sick || {};
    const runawayChance = runawayCfg.chance || 0.5;

    if (Math.random() < runawayChance) {
      stressEvent = { type: 'runaway', message: '스트레스가 폭발하여 가출했다!', effects: { ...(runawayCfg.effects || {}) } };
    } else {
      stressEvent = { type: 'sick', message: '과로로 쓰러졌다!', effects: { ...(sickCfg.effects || {}) } };
    }
    for (const [stat, delta] of Object.entries(stressEvent.effects)) {
      v[stat] = Math.max(0, (v[stat] || 0) + delta);
    }
    events.push(stressEvent);
  }

  // --- Advance month ---
  v.current_month += 1;
  if (v.current_month > 12) {
    v.current_month = 1;
    v.current_year += 1;
    v.age += 1;
  }
  v.season = getSeason(v.current_month);
  v.day_number = (v.day_number || 0) + 1;
  v.mood = getMood(v.stress, sysConfig);

  // --- Seasonal events (check the NEW month — festivals happen when you arrive, not when you leave) ---
  const seasonalEvent = checkSeasonalEvent(v, eventsConfig);
  if (seasonalEvent) events.push(seasonalEvent);

  // --- Yearly allowance from guardian background (once per year, on month 1) ---
  if (v.current_month === 1) {
    const allowanceRange = v.__allowance;
    if (allowanceRange && Array.isArray(allowanceRange) && (allowanceRange[0] > 0 || allowanceRange[1] > 0)) {
      const allowance = randRange(allowanceRange);
      if (allowance > 0) {
        v.gold += allowance;
        events.push({ type: 'allowance', message: `${v.__allowance_desc || '양육비'} +${allowance}G 지급!` });
      }
    }
  }

  // --- HP natural recovery (from system-config) ---
  const hpRecCfg = (sysConfig && sysConfig.hp_recovery) || {};
  const hpBase = hpRecCfg.base || 2;
  const hpStaminaDivisor = hpRecCfg.stamina_divisor || 50;
  v.hp = Math.min(v.hp_max || 30, (v.hp || 0) + Math.floor((v.stamina || 0) / hpStaminaDivisor) + hpBase);

  // --- Reset schedule/slots ---
  v.schedule_1 = 'none';
  v.schedule_2 = 'none';
  v.schedule_3 = 'none';
  v.current_slot = 0;
  v.turn_phase = 'setup';
  state.competitions_entered = [];
  state.father_talked_this_month = false;
  v.father_talked = false;
  // Don't set advance:null here — let the panel's finalize() handle closing
  // via sendMessage() auto-close after animation completes
  v.__modals = { ...(v.__modals || {}), portrait: 'dismissible' };

  // --- Stance calculation + portrait update ---
  const prevStance = v.stance || 'default';
  const prevAge = (v.age || 10) - (v.current_month === 1 ? 1 : 0);
  v.stance = computeStance(v, sysConfig, state);
  let portraitChanged = false;
  if (v.stance !== prevStance || v.age !== prevAge) {
    v.portrait_needs_update = true;
    portraitChanged = true;
  }

  // --- Unlock check ---
  const newUnlocks = checkUnlocksInternal(v, config, state);
  if (newUnlocks.length > 0) {
    state.unlocked_activities = [...(state.unlocked_activities || []), ...newUnlocks];
    events.push({ type: 'unlock', message: `새 활동 해금: ${newUnlocks.map(id => (activities[id] || {}).name || id).join(', ')}` });
  }

  // --- Competitions available (uses NEW month — same month as seasonal event) ---
  const seasonalEvents = (eventsConfig && eventsConfig.seasonal_events) || {};
  const monthKey = String(v.current_month);
  const currentSeasonalEvt = seasonalEvents[monthKey];
  let competitionsAvailable = currentSeasonalEvt && currentSeasonalEvt.competitions
    ? currentSeasonalEvt.competitions.map(c => ({ id: c.id, name: c.name, category: c.category, stat: c.stat }))
    : null;

  // Merge dark competitions if dark_path active
  if (state.dark_path && currentSeasonalEvt && currentSeasonalEvt.dark_competitions) {
    const age = v.age || 10;
    const darkComps = currentSeasonalEvt.dark_competitions
      .filter(c => !c.age_min || age >= c.age_min)
      .map(c => ({ id: c.id, name: c.name, category: c.category, stat: c.stat }));
    competitionsAvailable = (competitionsAvailable || []).concat(darkComps);
  }

  // Store competitions in variables for panel available_when check
  v.__competitions_available = competitionsAvailable || [];
  // Remaining turns to enter competition (slot 3 auto-transitions, so only 2 chances: before slot 1 and before slot 2)
  if (competitionsAvailable && competitionsAvailable.length > 0) {
    v.__competitions_remaining_turns = 2;
  } else {
    v.__competitions_remaining_turns = 0;
  }

  // --- Birthday ---
  if (v.current_month === v.birth_month) {
    events.push({ type: 'birthday', message: `${v.name}의 ${v.age}세 생일이다!` });
    v.stress = Math.max(0, v.stress - 10);
  }

  // --- Turn counter ---
  state.total_turns = (state.total_turns || 0) + 1;

  // --- Event log ---
  let updatedLog = eventLog;
  for (const evt of events) {
    updatedLog = addLogEntry(updatedLog, {
      type: evt.type || 'event',
      month: `${v.current_year}년차 ${v.current_month}월`,
      text: evt.message
    });
  }

  // --- Ending notice ---
  let endingNotice = null;
  if (v.age >= 18) {
    endingNotice = `${v.name}가 18세가 되었습니다! 이제 엔딩을 맞이할 시간입니다.`;
  }

  // --- Auto-generate next month's wish ---
  const wish = generateWishInternal(v, sysConfig, eventsConfig, config, state);
  v.wish_activity = wish.wish_category;
  v.wish_text = wish.wish_text;
  // Track wish history for anti-repetition
  if (!state.wish_history) state.wish_history = [];
  state.wish_history.push(wish.wish_category);
  if (state.wish_history.length > 6) state.wish_history = state.wish_history.slice(-6);

  const monthEndResult = {
    month: v.current_month,
    year: v.current_year,
    age: v.age,
    season: v.season,
    new_unlocks: newUnlocks.map(id => (activities[id] || {}).name || id),
    seasonal_event: seasonalEvent,
    birthday: v.current_month === v.birth_month,
    stress_event: stressEvent,
    ending_notice: endingNotice,
    events: events,
    competitions_available: competitionsAvailable,
    next_wish: { category: wish.wish_category, text: wish.wish_text },
    _eventLog: updatedLog
  };
  if (portraitChanged) {
    monthEndResult.portrait_update = {
      reason: v.stance !== prevStance ? 'stance_change' : 'age_change',
      old_stance: prevStance,
      new_stance: v.stance,
      age: v.age
    };
  }
  return monthEndResult;
}


// ============================================================
// === Values System ===
// ============================================================

const STAT_DISPLAY_NAMES = {
  stamina: '체력', intelligence: '지력', elegance: '기품', charm: '매력',
  morals: '도덕', sensitivity: '감수성', faith: '신앙', combat: '무술',
  etiquette: '예절', cooking: '요리', art: '예술', music: '음악'
};

/**
 * selectPeriodicTopic — Pick a values topic based on current game context.
 * Randomly selects from context-appropriate candidates.
 */
function selectPeriodicTopic(v, state) {
  const topics = [];
  const stance = v.stance || 'default';
  const age = v.age || 10;

  // Stance-based topics
  const stanceTopics = {
    warrior:     { topic: 'strength_purpose',    context: '무술 중심 성장 — 힘의 의미' },
    studious:    { topic: 'knowledge_value',     context: '학업 중심 성장 — 배움의 가치' },
    elegant:     { topic: 'social_grace',        context: '기품/예절 중심 — 사교와 체면' },
    charming:    { topic: 'beauty_power',        context: '매력 중심 성장 — 아름다움과 영향력' },
    artistic:    { topic: 'creative_soul',       context: '예술 중심 성장 — 창작과 감수성' },
    devout:      { topic: 'faith_meaning',       context: '신앙/도덕 중심 — 믿음의 의미' },
    culinary:    { topic: 'craft_pride',         context: '요리 중심 성장 — 기술과 자부심' },
    magical:     { topic: 'arcane_mystery',      context: '마법 중심 성장 — 신비와 힘의 대가' },
    tomboyish:   { topic: 'freedom_identity',    context: '활달한 성격 — 자유와 정체성' },
    nurturing:   { topic: 'caring_bonds',        context: '다정한 성격 — 돌봄과 유대' },
    alluring:    { topic: 'awakening_desire',    context: '다크 — 매력의 자각과 욕망의 시작' },
    provocative: { topic: 'power_through_body',  context: '다크 — 육체적 도발과 지배욕' },
    submissive:  { topic: 'surrender_comfort',   context: '다크 — 복종과 안도, 자아 포기의 유혹' },
    dominant:    { topic: 'control_pleasure',    context: '다크 — 지배의 쾌감과 권력' },
    masochist:   { topic: 'pain_as_pleasure',    context: '다크 — 고통 속 쾌락, 수치와 흥분' },
    sadist:      { topic: 'others_suffering',    context: '다크 — 타인의 고통에서 오는 흥분' },
    pet:         { topic: 'owned_identity',      context: '다크 — 소유물로서의 정체성, 완전한 헌신' },
    queen:       { topic: 'absolute_dominion',   context: '다크 — 절대 지배, 모든 것을 손 안에' }
  };
  if (stanceTopics[stance]) topics.push(stanceTopics[stance]);

  // Dark path reflections
  if (state.dark_path) {
    topics.push({ topic: 'dark_reflection', context: '다크패스 — 어둠의 세계에 대한 성찰' });
    topics.push({ topic: 'innocence_loss',  context: '다크패스 — 순수함과 세상의 현실' });
  }

  // Age-based topics
  if (age <= 12) {
    topics.push({ topic: 'childhood_wonder', context: '어린 시절 — 세상에 대한 호기심' });
    topics.push({ topic: 'family_meaning',   context: '어린 시절 — 가족의 의미' });
  } else if (age <= 15) {
    topics.push({ topic: 'identity_search',  context: '사춘기 — 나는 누구인가' });
    topics.push({ topic: 'peer_pressure',    context: '사춘기 — 또래와 사회적 압력' });
  } else {
    topics.push({ topic: 'future_path',   context: '성장기 — 장래와 진로' });
    topics.push({ topic: 'independence',   context: '성장기 — 독립과 자립' });
  }

  // General topics
  topics.push({ topic: 'happiness',  context: '일반 — 행복이란 무엇인가' });
  topics.push({ topic: 'friendship', context: '일반 — 우정과 관계' });

  return topics[Math.floor(Math.random() * topics.length)];
}

/**
 * checkValuesTrigger — Determine if a values prompt should be shown this slot.
 *
 * Checks conditional triggers (dark events, stress explosion, stat milestones,
 * morals extremes) and periodic trigger (every N months).
 *
 * Returns: { reason, priority, topic, context, stat?, milestone? } or null
 */
function checkValuesTrigger(v, state, slotEvents, statChanges, sysConfig) {
  const valCfg = (sysConfig && sysConfig.values_system) || {};
  if (valCfg.enabled === false) return null;

  const periodicInterval = valCfg.periodic_interval || 3;
  const conditionalCooldown = valCfg.conditional_cooldown || 6;
  const urgentCooldown = valCfg.urgent_cooldown || 3;
  const condCfg = valCfg.conditional_triggers || {};

  // Already triggered this slot? (set by values panel after user picks a choice)
  if (state.values_this_slot) return null;

  const absMonth = ((v.current_year || 1) - 1) * 12 + (v.current_month || 1);
  const lastTrigger = state.last_values_month || 0;
  const monthsSince = absMonth - lastTrigger;

  const triggers = [];

  // --- Urgent triggers (shorter cooldown: 3 months) ---

  // Stress explosion (runaway or sick)
  if (condCfg.stress_explosion !== false && monthsSince >= urgentCooldown) {
    if (slotEvents.some(e => e.type === 'runaway' || e.type === 'sick')) {
      triggers.push({
        reason: 'stress_explosion', priority: 5, topic: 'stress_crisis',
        context: '스트레스 폭발로 쓰러지거나 가출한 후'
      });
    }
  }

  // Dark path events this slot
  if (state.dark_path && condCfg.dark_event !== false && monthsSince >= urgentCooldown) {
    if (slotEvents.some(e =>
      e.type === 'dark_encounter' || e.type === 'dark_random' ||
      (e.type === 'encounter' && state.dark_path)
    )) {
      triggers.push({
        reason: 'dark_event', priority: 4, topic: 'dark_experience',
        context: '다크패스 관련 이벤트를 경험한 직후'
      });
    }
  }

  // --- Conditional triggers (longer cooldown: 6 months) ---

  // Stat milestones (100, 200, 300...) — no cooldown, each milestone fires only once
  const milestoneInterval = condCfg.stat_milestone_interval || 100;
  if (statChanges && condCfg.stat_milestone !== false) {
    for (const [stat, delta] of Object.entries(statChanges)) {
      if (stat === 'stress' || stat === 'hp' || stat === 'gold' || delta <= 0) continue;
      const current = v[stat] || 0;
      const prev = current - delta;
      const prevMs = Math.floor(prev / milestoneInterval);
      const currMs = Math.floor(current / milestoneInterval);
      if (currMs > prevMs && currMs >= 1) {
        triggers.push({
          reason: 'stat_milestone', priority: 3,
          topic: 'stat_milestone', stat, milestone: currMs * milestoneInterval,
          context: `${STAT_DISPLAY_NAMES[stat] || stat}이(가) ${currMs * milestoneInterval}에 도달`
        });
        break; // one milestone per slot
      }
    }
  }

  // Morals extremes
  const moralsLow = condCfg.morals_extreme_low ?? 5;
  const moralsHigh = condCfg.morals_extreme_high ?? 80;
  if (monthsSince >= conditionalCooldown) {
    if ((v.morals || 0) <= moralsLow) {
      triggers.push({
        reason: 'morals_low', priority: 3, topic: 'moral_boundary',
        context: `도덕 수치가 ${v.morals}까지 하락`
      });
    } else if ((v.morals || 0) >= moralsHigh) {
      triggers.push({
        reason: 'morals_high', priority: 2, topic: 'moral_conviction',
        context: `도덕 수치가 ${v.morals}까지 상승`
      });
    }
  }

  // High stress approaching explosion
  const stressThresh = condCfg.high_stress_threshold || 90;
  if ((v.stress || 0) >= stressThresh && monthsSince >= conditionalCooldown) {
    triggers.push({
      reason: 'high_stress', priority: 2, topic: 'stress_coping',
      context: `스트레스가 ${v.stress}까지 올라간 상태`
    });
  }

  // --- Periodic trigger (lowest priority, time-gated) ---
  if (monthsSince >= periodicInterval) {
    const topic = selectPeriodicTopic(v, state);
    triggers.push({
      reason: 'periodic', priority: 1,
      topic: topic.topic, context: topic.context
    });
  }

  if (triggers.length === 0) return null;

  // Pick highest priority trigger
  triggers.sort((a, b) => b.priority - a.priority);
  return triggers[0];
}


// ============================================================
// === Internal helpers ===
// ============================================================

function checkUnlocksInternal(vars, config, state) {
  const activities = config.activities || {};
  const unlocked = new Set(state.unlocked_activities || []);
  const darkPath = state.dark_path || false;
  const newUnlocks = [];
  for (const [id, act] of Object.entries(activities)) {
    if (unlocked.has(id)) continue;
    if (act.dark_only && !darkPath) continue;
    if (!act.requirements || Object.keys(act.requirements).length === 0) {
      // dark_only activities with no requirements should auto-unlock when dark_path is active
      if (act.dark_only && darkPath) {
        newUnlocks.push(id);
      }
      continue;
    }
    if (meetsRequirements(act.requirements, vars)) newUnlocks.push(id);
  }
  return newUnlocks;
}

/**
 * checkSeasonalEvent — Read seasonal events from events-config instead of hardcoding.
 */
function checkSeasonalEvent(vars, eventsConfig) {
  const seasonalEvents = (eventsConfig && eventsConfig.seasonal_events) || {};
  const monthKey = String(vars.current_month);
  const evt = seasonalEvents[monthKey];
  if (!evt) return null;
  return {
    type: evt.type || 'seasonal',
    message: evt.message,
    name: evt.name || evt.season_event,
    season_event: evt.season_event
  };
}

function runAdventure(zone, vars, data, config) {
  const zones = config.adventure_zones || {};
  const zoneData = zones[zone];
  if (!zoneData) return null;

  const inv = { ...(data.inventory || {}) };
  const items = { ...(inv.items || {}) };
  const playerAtk = (vars.attack || 5) + getEquipBonus(inv, 'attack');
  const playerDef = (vars.defense || 5) + getEquipBonus(inv, 'defense');
  let playerHp = vars.hp || 30;
  const playerMagic = vars.magic_power || 0;

  const battles = [];
  let totalGold = 0;
  let totalExpCombat = 0;
  const treasuresFound = [];
  const numEncounters = rand(2, 4);

  for (let i = 0; i < numEncounters && playerHp > 0; i++) {
    const enemyTemplate = zoneData.enemies[rand(0, zoneData.enemies.length - 1)];
    const enemy = { ...enemyTemplate };
    let rounds = 0, dmgTaken = 0;
    const roundLog = [];
    const enemyMaxHp = enemy.hp;

    while (enemy.hp > 0 && playerHp > 0 && rounds < 20) {
      rounds++;
      const entry = { round: rounds, player_dmg: 0, enemy_dmg: 0, crit: false, dodged: false, magic: false, player_hp: playerHp, enemy_hp: enemy.hp };

      // Player attacks
      const crit = Math.random() < (0.1 + (vars.combat || 0) / 2000);
      let pDmg = Math.max(1, playerAtk - enemy.def + rand(-2, 3));
      if (crit) { pDmg = Math.floor(pDmg * 1.8); entry.crit = true; }
      let magicDmg = 0;
      if (playerMagic > 20 && Math.random() < 0.2) { magicDmg = Math.floor(playerMagic / 5); pDmg += magicDmg; entry.magic = true; }
      enemy.hp = Math.max(0, enemy.hp - pDmg);
      entry.player_dmg = pDmg;
      entry.enemy_hp = enemy.hp;

      if (enemy.hp <= 0) { roundLog.push(entry); break; }

      // Enemy attacks
      if (Math.random() >= Math.min(0.3, (vars.combat || 0) / 1000)) {
        let eDmg = Math.max(1, enemy.atk - playerDef + rand(-2, 2));
        playerHp = Math.max(0, playerHp - eDmg);
        dmgTaken += eDmg;
        entry.enemy_dmg = eDmg;
      } else {
        entry.dodged = true;
      }
      entry.player_hp = playerHp;
      roundLog.push(entry);
    }
    const won = enemy.hp <= 0;
    let rewards = {};
    if (won) {
      const g = randRange(enemyTemplate.gold || [0, 0]);
      const e = randRange(enemyTemplate.exp_combat || [0, 0]);
      totalGold += g; totalExpCombat += e;
      rewards = { gold: g, exp_combat: e };
    }
    battles.push({
      enemy: enemyTemplate.name, enemy_max_hp: enemyMaxHp, rounds, won,
      damage_taken: dmgTaken, rewards, round_log: roundLog
    });
  }

  for (const t of (zoneData.treasures || [])) {
    if (Math.random() < (t.chance || 0)) {
      treasuresFound.push(t.name);
      items[t.name] = (items[t.name] || 0) + 1;
    }
  }

  return {
    zone: zoneData.name, battles, total_gold: totalGold, total_exp_combat: totalExpCombat,
    treasures: treasuresFound, hp_remaining: playerHp, _items: items
  };
}


/**
 * generateAdventureEncounters — Pre-generate encounter list for interactive adventure.
 * Does NOT resolve fights; just picks enemies and rolls treasure chances.
 */
function generateAdventureEncounters(zone, vars, config) {
  const zones = config.adventure_zones || {};
  const zoneData = zones[zone];
  if (!zoneData) return null;

  const numEncounters = rand(2, 4);
  const encounters = [];
  for (let i = 0; i < numEncounters; i++) {
    const t = zoneData.enemies[rand(0, zoneData.enemies.length - 1)];
    encounters.push({
      name: t.name, hp: t.hp, max_hp: t.hp,
      atk: t.atk, def: t.def,
      exp_combat: t.exp_combat || [0, 0], gold: t.gold || [0, 0]
    });
  }

  // Pre-roll treasures (revealed at adventure end)
  const pendingTreasures = [];
  for (const t of (zoneData.treasures || [])) {
    if (Math.random() < (t.chance || 0)) pendingTreasures.push(t.name);
  }

  return {
    active: true,
    zone, zone_name: zoneData.name,
    encounters, current_index: 0,
    battles_log: [],
    pending_treasures: pendingTreasures,
    total_gold: 0, total_exp: 0,
    status: 'encounter' // encounter | fight_won | defeated | retreated | complete
  };
}

/**
 * resolveOneEncounterFight — Resolve a single fight in interactive adventure.
 * Returns fight result without modifying any external state.
 */
function resolveOneEncounterFight(encounter, vars, data) {
  const inv = data.inventory || {};
  const playerAtk = (vars.attack || 5) + getEquipBonus(inv, 'attack');
  const playerDef = (vars.defense || 5) + getEquipBonus(inv, 'defense');
  let playerHp = vars.hp || 0;
  const playerMagic = vars.magic_power || 0;

  const enemy = { hp: encounter.hp, atk: encounter.atk, def: encounter.def };
  let rounds = 0, dmgTaken = 0;
  const roundLog = [];

  while (enemy.hp > 0 && playerHp > 0 && rounds < 20) {
    rounds++;
    const entry = { round: rounds, player_dmg: 0, enemy_dmg: 0, crit: false, dodged: false, magic: false, player_hp: playerHp, enemy_hp: enemy.hp };

    const crit = Math.random() < (0.1 + (vars.combat || 0) / 2000);
    let pDmg = Math.max(1, playerAtk - enemy.def + rand(-2, 3));
    if (crit) { pDmg = Math.floor(pDmg * 1.8); entry.crit = true; }
    if (playerMagic > 20 && Math.random() < 0.2) { pDmg += Math.floor(playerMagic / 5); entry.magic = true; }
    enemy.hp = Math.max(0, enemy.hp - pDmg);
    entry.player_dmg = pDmg;
    entry.enemy_hp = enemy.hp;

    if (enemy.hp <= 0) { roundLog.push(entry); break; }

    if (Math.random() >= Math.min(0.3, (vars.combat || 0) / 1000)) {
      let eDmg = Math.max(1, encounter.atk - playerDef + rand(-2, 2));
      playerHp = Math.max(0, playerHp - eDmg);
      dmgTaken += eDmg;
      entry.enemy_dmg = eDmg;
    } else {
      entry.dodged = true;
    }
    entry.player_hp = playerHp;
    roundLog.push(entry);
  }

  const won = enemy.hp <= 0;
  const rewards = won ? { gold: randRange(encounter.gold), exp_combat: randRange(encounter.exp_combat) } : {};

  return { enemy_name: encounter.name, won, rounds, damage_taken: dmgTaken, round_log: roundLog, rewards, player_hp_after: playerHp };
}

/**
 * applyDefeatPenalties — Apply penalties for HP=0 defeat in adventure.
 * Returns stat changes applied.
 */
function applyDefeatPenalties(v, state, sysConfig) {
  const pen = (sysConfig && sysConfig.defeat_penalties) || {};
  const changes = {};

  // Gold loss
  const goldLossRatio = pen.gold_loss_ratio || 0.3;
  const goldLost = Math.floor((v.gold || 0) * goldLossRatio);
  if (goldLost > 0) { v.gold = Math.max(0, (v.gold || 0) - goldLost); changes.gold = -goldLost; }

  // Stress gain
  const stressGain = pen.stress_gain || 15;
  const oldStress = v.stress || 0;
  v.stress = clamp(oldStress + stressGain, 0, v.stress_max || 110);
  changes.stress = v.stress - oldStress;

  // Combat loss (confidence shaken)
  const combatLoss = pen.combat_loss || 5;
  const oldCombat = v.combat || 0;
  v.combat = Math.max(0, oldCombat - combatLoss);
  changes.combat = v.combat - oldCombat;

  // Reputation loss
  const repLoss = pen.reputation_loss || 10;
  const oldRep = v.reputation || 0;
  v.reputation = Math.max(0, oldRep - repLoss);
  changes.reputation = v.reputation - oldRep;

  // Dark path extra penalties
  if (state.dark_path) {
    const dark = pen.dark_path_extra || {};
    if (dark.morals_loss) {
      const oldMorals = v.morals || 0;
      v.morals = Math.max(0, oldMorals - dark.morals_loss);
      changes.morals = v.morals - oldMorals;
    }
    if (dark.sensitivity_gain) {
      const oldSens = v.sensitivity || 0;
      v.sensitivity = Math.min(v.sensitivity_max || 999, oldSens + dark.sensitivity_gain);
      changes.sensitivity = v.sensitivity - oldSens;
    }
  }

  return changes;
}


// ============================================================
// === Action Handlers ===
// ============================================================

const ACTIONS = {

  /**
   * apply_setup — Apply initial game setup (guardian background, child name/birthday/personality).
   * args: { child_name?, birth_month?, guardian_background?, personality?, dark_path? }
   * result: { success, applied: { name, birth_month, background, personality, dark_path }, stat_changes }
   */
  apply_setup(ctx, args) {
    const { child_name, birth_month, guardian_background, personality, dark_path } = args;
    const v = { ...ctx.variables };
    const setupConfig = ctx.data['setup-config'] || {};
    const state = { ...(ctx.data['game-state'] || {}) };
    const statChanges = {};

    // Apply child name
    if (child_name) v.name = child_name;

    // Apply birth month
    if (birth_month && birth_month >= 1 && birth_month <= 12) {
      v.birth_month = birth_month;
    }

    // Apply guardian background bonuses
    const bgConfig = (setupConfig.guardian_backgrounds || {})[guardian_background];
    if (bgConfig) {
      v.guardian_background = guardian_background;
      v.guardian_background_name = bgConfig.name;

      // Stat bonuses
      for (const [stat, bonus] of Object.entries(bgConfig.bonuses || {})) {
        const oldVal = v[stat] || 0;
        const maxKey = stat + '_max';
        const max = v[maxKey] || 999;
        v[stat] = clamp(oldVal + bonus, 0, max);
        statChanges[stat] = (statChanges[stat] || 0) + bonus;
      }

      // Initial gold (replaces default 500G)
      if (bgConfig.initial_gold !== undefined) {
        v.gold = bgConfig.initial_gold;
        statChanges.gold = bgConfig.initial_gold - 500; // delta from default
      } else if (bgConfig.gold_bonus) {
        v.gold = (v.gold || 500) + bgConfig.gold_bonus;
        statChanges.gold = bgConfig.gold_bonus;
      }

      // Monthly allowance (stored in variables for advanceMonth to use)
      if (bgConfig.allowance) {
        v.__allowance = bgConfig.allowance;
        v.__allowance_desc = bgConfig.allowance_desc || '양육비';
      }

      // Special early unlocks — generic array or legacy hardcoded
      if (bgConfig.early_unlocks && Array.isArray(bgConfig.early_unlocks)) {
        const unlocked = new Set(state.unlocked_activities || []);
        for (const actId of bgConfig.early_unlocks) {
          unlocked.add(actId);
        }
        state.unlocked_activities = [...unlocked];
      }
      if (guardian_background === 'wizard') {
        const unlocked = state.unlocked_activities || [];
        if (!unlocked.includes('magic_school')) {
          state.unlocked_activities = [...unlocked, 'magic_school'];
        }
      }
      if (guardian_background === 'knight') {
        const unlocked = state.unlocked_activities || [];
        if (!unlocked.includes('knight_training')) {
          state.unlocked_activities = [...unlocked, 'knight_training'];
        }
      }
      if (guardian_background === 'priest') {
        const unlocked = state.unlocked_activities || [];
        if (!unlocked.includes('temple_training')) {
          state.unlocked_activities = [...unlocked, 'temple_training'];
        }
      }
      // Dark path guardian — activate dark_path flag
      if (bgConfig.dark_only) {
        state.dark_path = true;
      }
    }

    // Explicit dark_path from setup panel
    if (dark_path === true || dark_path === 'true') {
      state.dark_path = true;
    }

    // Apply personality bonuses/penalties
    const persConfig = (setupConfig.personality_types || {})[personality];
    if (persConfig) {
      v.personality = personality;
      v.personality_name = persConfig.name;

      for (const [stat, bonus] of Object.entries(persConfig.bonuses || {})) {
        const oldVal = v[stat] || 0;
        const maxKey = stat + '_max';
        const max = v[maxKey] || 999;
        v[stat] = clamp(oldVal + bonus, 0, max);
        statChanges[stat] = (statChanges[stat] || 0) + bonus;
      }
      for (const [stat, penalty] of Object.entries(persConfig.penalties || {})) {
        const oldVal = v[stat] || 0;
        v[stat] = Math.max(0, oldVal + penalty);
        statChanges[stat] = (statChanges[stat] || 0) + penalty;
      }
    }

    // Generate initial wish
    const sysConfig = ctx.data['system-config'] || {};
    const eventsConfig = ctx.data['events-config'] || {};
    const scheduleConfig = ctx.data['schedule-config'] || {};
    const wish = generateWishInternal(v, sysConfig, eventsConfig, scheduleConfig, state);
    v.wish_activity = wish.wish_category;
    v.wish_text = wish.wish_text;
    if (!state.wish_history) state.wish_history = [];
    state.wish_history.push(wish.wish_category);

    // Run unlock check after setup (catches dark_only activities with empty requirements)
    const setupUnlocks = checkUnlocksInternal(v, scheduleConfig, state);
    if (setupUnlocks.length > 0) {
      state.unlocked_activities = [...(state.unlocked_activities || []), ...setupUnlocks];
    }

    return {
      variables: v,
      data: { 'game-state.json': state },
      result: {
        success: true,
        applied: {
          name: v.name,
          birth_month: v.birth_month,
          background: bgConfig ? bgConfig.name : null,
          background_special: bgConfig ? bgConfig.special : null,
          personality: persConfig ? persConfig.name : null,
          dark_path: state.dark_path || false
        },
        stat_changes: statChanges,
        initial_wish: wish.wish_text
      }
    };
  },

  /**
   * advance_slot — Advance 1 schedule slot.
   * args: (none — reads current_slot and schedule_N from variables)
   *
   * Checks wish_activity match for wish bonus/penalty.
   * When slot 3 is processed, automatically includes turn_transition (month advance)
   * so this action is always safe to call standalone.
   */
  advance_slot(ctx, args) {
    // Wrapper: run slot processing, then auto-merge transition if slot 3
    const slotResult = ACTIONS._advance_slot_inner(ctx, args);
    if (!slotResult.result?.success || !slotResult.result?.pending_transition) {
      return slotResult;
    }
    // Slot 3 done — auto-run turn_transition with updated context
    const mergedCtx = {
      ...ctx,
      variables: { ...ctx.variables, ...slotResult.variables },
      data: { ...ctx.data }
    };
    // Apply data changes from slot result to context
    for (const [k, v] of Object.entries(slotResult.data || {})) {
      const key = k.replace('.json', '');
      mergedCtx.data[key] = { ...(mergedCtx.data[key] || {}), ...v };
    }
    const transResult = ACTIONS.turn_transition(mergedCtx, {});
    // Merge: slot variables + transition variables
    const mergedVars = { ...slotResult.variables, ...(transResult.variables || {}) };
    // Merge data files
    const mergedData = { ...(slotResult.data || {}) };
    for (const [k, v] of Object.entries(transResult.data || {})) {
      mergedData[k] = { ...(mergedData[k] || {}), ...v };
    }
    // Attach transition info to result
    slotResult.result.transition = transResult.result;
    delete slotResult.result.pending_transition;
    return {
      variables: mergedVars,
      data: mergedData,
      result: slotResult.result
    };
  },

  _advance_slot_inner(ctx, args) {
    const v = { ...ctx.variables };
    const config = ctx.data['schedule-config'] || {};
    const state = { ...(ctx.data['game-state'] || {}) };
    let eventLog = { ...(ctx.data['event-log'] || {}) };
    const sysConfig = ctx.data['system-config'] || {};
    const eventsConfig = ctx.data['events-config'] || {};
    const activities = config.activities || {};
    const allActivities = { ...activities, ...(state.custom_activities || {}) };
    const wishSys = sysConfig.wish_system || {};

    // Reset values trigger flag for this slot
    state.values_this_slot = false;

    // Determine next slot
    const nextSlot = (v.current_slot || 0) + 1;
    if (nextSlot > 3) {
      return { result: { success: false, message: '이미 3슬롯을 모두 진행했습니다. 다음 턴을 설정하세요.' } };
    }

    const slotKey = `schedule_${nextSlot}`;
    const actId = v[slotKey];
    const events = [];
    const statChanges = {};
    let goldChange = 0;
    let payEarned = 0;
    let costPaid = 0;
    let adventureResult = null;
    let wishFollowed = null;

    // Empty slot -> reject, prompt schedule edit
    if (!actId || actId === 'none') {
      return {
        result: {
          success: false,
          message: `${SLOT_LABELS[nextSlot]} 스케줄이 비어있습니다. 스케줄을 수정해주세요.`,
          empty_slot: nextSlot
        }
      };
    }

    const act = allActivities[actId];
    if (!act) {
      return { result: { success: false, message: `알 수 없는 활동: ${actId}` } };
    }

    // --- Wish system: check if activity matches wish ---
    const wishActivity = v.wish_activity || null;
    if (wishActivity) {
      wishFollowed = (act.category === wishActivity);
    }

    // --- Cost deduction ---
    const cost = act.cost || 0;
    if (cost > 0 && v.gold < cost) {
      return { result: { success: false, message: `골드 부족 (필요: ${cost}G, 보유: ${v.gold}G)` } };
    }
    if (cost > 0) {
      v.gold -= cost;
      goldChange -= cost;
      costPaid = cost;
    }

    // --- Wish stress modifier (common for both paths) ---
    const followBonus = wishSys.follow_bonus || {};
    const ignorePenalty = wishSys.ignore_penalty || {};
    let wishStressMod = 0;
    if (wishFollowed === true) {
      wishStressMod = -(followBonus.stress_reduction || 3);
    } else if (wishFollowed === false) {
      wishStressMod = (ignorePenalty.stress_increase || 3);
    }

    // --- Snapshot initial stats for animation ---
    const initialSnapshot = {};
    const simStatsToTrack = new Set(['gold', 'stress']);
    if (act.effects) for (const s of Object.keys(act.effects)) simStatsToTrack.add(s);
    if (act.side_effects) for (const s of Object.keys(act.side_effects)) simStatsToTrack.add(s);
    if (act.stat_bonus) for (const s of Object.keys(act.stat_bonus)) simStatsToTrack.add(s);
    for (const s of simStatsToTrack) initialSnapshot[s] = v[s] || 0;

    let simResult = null;
    const skipCategories = new Set(((sysConfig.daily_simulation || {}).skip_categories) || ['rest']);

    if (DAILY_SIM_CATEGORIES.has(act.category) && !skipCategories.has(act.category)) {
      // ================================================================
      // ===== DAILY SIMULATION PATH (study, martial, arts, job...) =====
      // ================================================================

      const prevCount = ((state.activity_stats || {})[actId] || {}).count || 0;
      simResult = simulateSlotDaily(act, v, sysConfig, prevCount);

      // Apply simulation stat results to v (with modifiers)
      const mods = getModifiers(v);
      for (const [stat, delta] of Object.entries(simResult.totalStatChanges)) {
        const displayDelta = applyStat(v, stat, delta, mods);
        if (displayDelta !== 0) statChanges[stat] = displayDelta;
      }
      v.gold = Math.max(0, (v.gold || 0) + simResult.totalGoldChange);
      goldChange += simResult.totalGoldChange;
      payEarned = simResult.totalPayEarned;

      // Slot events (skip crit/fail — replaced by daily success/failure)
      const slotEvents = rollSlotEvents(act, v, nextSlot, sysConfig, eventsConfig, { skipCritFail: true, gameState: state, actId });
      for (const evt of slotEvents) {
        if (evt.effects) {
          for (const [stat, delta] of Object.entries(evt.effects)) {
            if (stat === 'gold') {
              v.gold = Math.max(0, (v.gold || 0) + delta);
              goldChange += delta;
            } else {
              const dd = applyStat(v, stat, delta, mods);
              if (dd !== 0) statChanges[stat] = (statChanges[stat] || 0) + dd;
            }
          }
        }
        events.push(evt);
      }

      // Perfect run check
      if (simResult.successCount === simResult.workingDays) {
        const perfectCfg = ((sysConfig.daily_simulation || {}).perfect_run || {});
        const bonusRatio = perfectCfg.stat_bonus_ratio || 0.25;
        for (const [stat, delta] of Object.entries(simResult.totalStatChanges)) {
          if (stat !== 'stress' && delta > 0) {
            const bonus = Math.max(1, Math.round(delta * bonusRatio));
            const dd = applyStat(v, stat, bonus, mods);
            if (dd !== 0) statChanges[stat] = (statChanges[stat] || 0) + dd;
          }
        }
        if (simResult.totalPayEarned > 0) {
          const goldBonus = Math.round(simResult.totalPayEarned * (perfectCfg.gold_bonus_ratio || 0.20));
          v.gold += goldBonus;
          goldChange += goldBonus;
        }
        const stressReduction = perfectCfg.stress_reduction || 3;
        const dd = applyStat(v, 'stress', -stressReduction, mods);
        if (dd !== 0) statChanges.stress = (statChanges.stress || 0) + dd;

        events.push({
          type: 'perfect_run',
          message: perfectCfg.message || '완벽! 모든 날을 성공적으로 보냈다!'
        });
      }

    } else {
      // ================================================================
      // ===== OLD SINGLE-ROLL PATH (rest, adventure, free_time) =====
      // ================================================================

      const isRest = act.category === 'rest';
      const slotEvents = rollSlotEvents(act, v, nextSlot, sysConfig, eventsConfig, { skipCritFail: isRest, gameState: state, actId });
      let effectMultiplier = 1.0;
      for (const evt of slotEvents) {
        if (evt.multiplier) effectMultiplier = evt.multiplier;
      }

      // Wish effect multiplier (only for old path)
      if (wishFollowed === true) {
        effectMultiplier *= (followBonus.effect_multiplier || 1.2);
      }

      // Apply stat effects (with modifiers)
      const mods = getModifiers(v);
      const failStressMultiplier = (sysConfig.slot_events && sysConfig.slot_events.failure && sysConfig.slot_events.failure.stress_on_fail_multiplier) || 1.5;
      if (act.effects) {
        for (const [stat, range] of Object.entries(act.effects)) {
          let delta = randRange(range);
          if (stat === 'stress') {
            if (delta < 0) {
              // Stress REDUCTION (rest etc): crit = more reduction, fail = less reduction
              delta = effectMultiplier > 1 ? Math.floor(delta * 1.5) : (effectMultiplier < 1 ? Math.ceil(delta * 0.5) : delta);
            } else {
              // Stress GAIN: crit = less stress, fail = more stress
              delta = effectMultiplier > 1 ? Math.floor(delta * 0.5) : Math.ceil(delta * (effectMultiplier < 1 ? failStressMultiplier : 1));
            }
          } else {
            delta = Math.round(delta * effectMultiplier);
          }
          const dd = applyStat(v, stat, delta, mods);
          if (dd !== 0) statChanges[stat] = dd;
        }
      }

      // Side effects
      if (act.side_effects) {
        for (const [stat, range] of Object.entries(act.side_effects)) {
          const delta = randRange(range);
          const dd = applyStat(v, stat, delta, mods);
          if (dd !== 0) statChanges[stat] = (statChanges[stat] || 0) + dd;
        }
      }

      // Job pay
      if (act.pay) {
        let pay = randRange(act.pay);
        pay = Math.round(pay * effectMultiplier);
        v.gold += pay;
        goldChange += pay;
        payEarned = pay;
      }

      // Job stat bonus
      if (act.stat_bonus) {
        for (const [stat, range] of Object.entries(act.stat_bonus)) {
          const delta = Math.round(randRange(range) * effectMultiplier);
          const dd = applyStat(v, stat, delta, mods);
          if (dd !== 0) statChanges[stat] = (statChanges[stat] || 0) + dd;
        }
      }

      // Slot event effects
      for (const evt of slotEvents) {
        if (evt.effects) {
          for (const [stat, delta] of Object.entries(evt.effects)) {
            if (stat === 'gold') {
              v.gold = Math.max(0, (v.gold || 0) + delta);
              goldChange += delta;
            } else {
              const dd = applyStat(v, stat, delta, mods);
              if (dd !== 0) statChanges[stat] = (statChanges[stat] || 0) + dd;
            }
          }
        }
        events.push(evt);
      }

      // Free time random event
      if (act.random_event_chance && Math.random() < act.random_event_chance) {
        const rndEvt = generateRandomEvent(v, eventsConfig, state);
        if (rndEvt.effects) {
          for (const [stat, delta] of Object.entries(rndEvt.effects)) {
            if (stat === 'gold') {
              v.gold = Math.max(0, (v.gold || 0) + delta);
              goldChange += delta;
            } else {
              const dd = applyStat(v, stat, delta, mods);
              if (dd !== 0) statChanges[stat] = (statChanges[stat] || 0) + dd;
            }
          }
        }
        events.push(rndEvt);
      }

      // Adventure — start interactive encounter mode
      if (act.adventure_zone) {
        const advState = generateAdventureEncounters(act.adventure_zone, v, config);
        if (advState) {
          advState.player_hp = v.hp || 0;
          advState.player_max_hp = v.hp_max || 40;
          v.__adventure = advState;
          // adventure modal is opened by advance panel after AI turn completes (turnEnd)
        }
      }
    }

    // ================================================================
    // ===== COMMON: Wish stress, state update, logging, return =====
    // ================================================================

    // Apply wish stress modifier
    if (wishStressMod !== 0) {
      const oldStress = v.stress || 0;
      v.stress = clamp(oldStress + wishStressMod, 0, v.stress_max || 100);
      statChanges.stress = (statChanges.stress || 0) + (v.stress - oldStress);
      if (wishFollowed) {
        events.push({ type: 'wish_bonus', message: `${v.name || '올리브'}가 하고 싶은 일을 해서 기분이 좋아졌다!` });
      } else {
        events.push({ type: 'wish_penalty', message: `${v.name || '올리브'}가 하고 싶은 일을 못 해서 살짝 불만이다.` });
      }
    }

    // Weight change per slot (homeostasis-based)
    const weightDelta = calculateWeightChange(actId, act.category, v, sysConfig);
    if (weightDelta !== 0) {
      const oldWeight = v.weight || 30;
      v.weight = oldWeight + weightDelta;
      statChanges.weight = weightDelta;
    }

    // Natural HP recovery per slot (even non-rest activities heal a bit)
    if (!act.adventure_zone) {
      const hpRecCfg = (sysConfig && sysConfig.hp_recovery) || {};
      const slotHpBase = hpRecCfg.slot_base || 3;
      const slotHpStaminaDiv = hpRecCfg.slot_stamina_divisor || 30;
      const slotHpGain = slotHpBase + Math.floor((v.stamina || 0) / slotHpStaminaDiv);
      const oldHp = v.hp || 0;
      v.hp = Math.min(v.hp_max || 30, oldHp + slotHpGain);
      if (v.hp > oldHp) {
        statChanges.hp = (statChanges.hp || 0) + (v.hp - oldHp);
      }
    }

    // Clamp stress, update mood
    v.stress = clamp(v.stress || 0, 0, v.stress_max || 100);
    v.mood = getMood(v.stress, sysConfig);

    // Update state
    v.current_slot = nextSlot;
    v.turn_phase = 'executing';
    // Decrement competition remaining turns
    if (v.__competitions_remaining_turns > 0) {
      v.__competitions_remaining_turns -= 1;
    }
    // Keep advance dock visible during animation — finalize()'s sendMessage() auto-closes it
    v.__modals = { ...(v.__modals || {}), portrait: null };

    // Event log
    let updatedLog = addLogEntry(eventLog, {
      type: 'slot',
      month: `${v.current_year}년차 ${v.current_month}월 ${SLOT_LABELS[nextSlot]}`,
      text: act.name + (events.length ? ' — ' + events.map(e => e.message).join('; ') : ''),
      gold_change: goldChange
    });

    // --- Activity stats tracking ---
    if (!state.activity_stats) state.activity_stats = {};
    const curPeriod = `${v.current_year}년차 ${v.current_month}월 ${SLOT_LABELS[nextSlot]}`;
    const prevStats = state.activity_stats[actId] || { count: 0, last_period: null };
    const activityContext = {
      total_count: prevStats.count + 1,
      last_period: prevStats.last_period
    };
    state.activity_stats[actId] = {
      count: prevStats.count + 1,
      last_period: curPeriod
    };

    // --- Values system trigger check ---
    const valuesTrigger = checkValuesTrigger(v, state, events, statChanges, sysConfig);
    if (valuesTrigger) {
      const absMonth = ((v.current_year || 1) - 1) * 12 + (v.current_month || 1);
      state.last_values_month = absMonth;
    }

    // --- Build return ---
    if (simResult) {
      // Collect popup effects
      const popups = collectPopups(events, null, simResult, null);

      return {
        variables: v,
        data: { 'game-state.json': state, 'event-log.json': updatedLog },
        result: {
          success: true,
          slot_number: nextSlot,
          slot_label: SLOT_LABELS[nextSlot],
          activity_name: act.name,
          activity_category: act.category,
          activity_context: activityContext,
          stat_changes: statChanges,
          gold_change: goldChange,
          pay_earned: payEarned,
          cost_paid: costPaid,
          events: events,
          wish_followed: wishFollowed,
          pending_transition: nextSlot === 3,
          adventure_result: null,
          values_trigger: valuesTrigger || undefined,
          popups: popups.length > 0 ? popups : undefined,
          // Daily simulation data
          steps: simResult.steps,
          daily_summary: {
            success_count: simResult.successCount,
            working_days: simResult.workingDays,
            perfect_run: simResult.successCount === simResult.workingDays
          }
        }
      };
    }

    // Collect popup effects
    const popupsNds = collectPopups(events, null, null, null, null);
    const adventureStarted = !!(v.__adventure && v.__adventure.active);

    return {
      variables: v,
      data: { 'game-state.json': state, 'event-log.json': updatedLog },
      result: {
        success: true,
        slot_number: nextSlot,
        slot_label: SLOT_LABELS[nextSlot],
        activity_name: act.name,
        activity_category: act.category,
        activity_context: activityContext,
        stat_changes: statChanges,
        gold_change: goldChange,
        pay_earned: payEarned,
        cost_paid: costPaid,
        events: events,
        wish_followed: wishFollowed,
        pending_transition: nextSlot === 3,
        adventure_result: null,
        adventure_started: adventureStarted,
        values_trigger: valuesTrigger || undefined,
        popups: popupsNds.length > 0 ? popupsNds : undefined
      }
    };
  },

  /**
   * turn_transition — Advance month after slot 3.
   * Called separately after advance_slot returns pending_transition: true.
   */
  turn_transition(ctx, args) {
    const v = { ...ctx.variables };
    const config = ctx.data['schedule-config'] || {};
    const state = { ...(ctx.data['game-state'] || {}) };
    let eventLog = { ...(ctx.data['event-log'] || {}) };
    const sysConfig = ctx.data['system-config'] || {};
    const eventsConfig = ctx.data['events-config'] || {};

    // Guard: already transitioned
    if (v.turn_phase === 'setup' && v.current_slot === 0) {
      return { result: { success: false, message: 'Already transitioned' } };
    }

    // Run month advance (reuses existing advanceMonth function unchanged)
    const monthSummary = advanceMonth(v, config, state, eventLog, sysConfig, eventsConfig);
    if (monthSummary._eventLog) {
      eventLog = monthSummary._eventLog;
      delete monthSummary._eventLog;
    }

    // Collect month-transition popups only
    const popups = collectPopups([], monthSummary, null, null);

    // Determine if AI narration is needed for this transition
    const needs_narration = !!(
      monthSummary.birthday ||
      monthSummary.stress_event ||
      monthSummary.seasonal_event ||
      (monthSummary.competitions_available && monthSummary.competitions_available.length > 0) ||
      monthSummary.ending_notice ||
      (monthSummary.portrait_update && monthSummary.portrait_update.reason === 'age_change')
    );

    return {
      variables: v,
      data: {
        'game-state.json': state,
        'event-log.json': eventLog
      },
      result: {
        success: true,
        needs_narration,
        month_summary: monthSummary,
        popups: popups.length > 0 ? popups : undefined
      }
    };
  },

  /**
   * check_unlocks — Check activity unlock conditions.
   */
  check_unlocks(ctx, args) {
    const config = ctx.data['schedule-config'] || {};
    const state = { ...(ctx.data['game-state'] || {}) };
    const newUnlocks = checkUnlocksInternal(ctx.variables, config, state);

    if (newUnlocks.length > 0) {
      state.unlocked_activities = [...(state.unlocked_activities || []), ...newUnlocks];
      return {
        data: { 'game-state.json': state },
        result: {
          success: true,
          newly_unlocked: newUnlocks.map(id => ((config.activities || {})[id] || {}).name || id)
        }
      };
    }
    return { result: { success: true, newly_unlocked: [] } };
  },

  /**
   * adventure — Standalone auto-combat adventure.
   * args: { zone }
   */
  adventure(ctx, args) {
    const { zone } = args;
    const config = ctx.data['schedule-config'] || {};
    const v = { ...ctx.variables };
    const result = runAdventure(zone, v, ctx.data, config);
    if (!result) {
      return { result: { success: false, message: `알 수 없는 모험 지역: ${zone}` } };
    }

    const inv = { ...(ctx.data.inventory || {}) };
    inv.items = result._items;
    delete result._items;

    const eventLog = { ...(ctx.data['event-log'] || {}) };
    const winsCount = result.battles.filter(b => b.won).length;
    const updatedLog = addLogEntry(eventLog, {
      type: 'adventure',
      month: `${v.current_year}년차 ${v.current_month}월`,
      text: `${result.zone} 모험: ${winsCount}/${result.battles.length}승, +${result.total_gold}G${result.treasures.length ? ', 보물: ' + result.treasures.join(', ') : ''}`
    });

    // Apply combat exp with modifiers
    const mods = getModifiers(v);
    applyStat(v, 'combat', result.total_exp_combat, mods);

    return {
      variables: { hp: result.hp_remaining, gold: (v.gold || 0) + result.total_gold, combat: v.combat },
      data: { 'inventory.json': inv, 'event-log.json': updatedLog },
      result: { success: true, ...result }
    };
  },

  // ================================================================
  // === Interactive Adventure Actions ===
  // ================================================================

  /**
   * adventure_fight — Resolve one encounter fight in interactive adventure.
   * args: (none — reads __adventure from variables)
   */
  adventure_fight(ctx, args) {
    const v = { ...ctx.variables };
    const adv = v.__adventure;
    if (!adv || !adv.active || adv.status === 'defeated' || adv.status === 'complete' || adv.status === 'retreated') {
      return { result: { success: false, message: '진행 중인 모험이 없습니다.' } };
    }

    const encounter = adv.encounters[adv.current_index];
    if (!encounter) return { result: { success: false, message: '더 이상 적이 없습니다.' } };

    // Resolve one fight
    const fightResult = resolveOneEncounterFight(encounter, v, ctx.data);

    // Apply HP change
    v.hp = fightResult.player_hp_after;
    adv.player_hp = fightResult.player_hp_after;

    // Record battle
    adv.battles_log.push({
      enemy: fightResult.enemy_name, won: fightResult.won,
      rounds: fightResult.rounds, damage_taken: fightResult.damage_taken,
      rewards: fightResult.rewards, round_log: fightResult.round_log
    });

    const state = { ...(ctx.data['game-state'] || {}) };
    const sysConfig = ctx.data['system-config'] || {};
    let defeatPenalties = null;

    if (fightResult.won) {
      // Apply rewards (combat exp with modifiers)
      const mods = getModifiers(v);
      const goldReward = fightResult.rewards.gold || 0;
      const expReward = fightResult.rewards.exp_combat || 0;
      v.gold = (v.gold || 0) + goldReward;
      applyStat(v, 'combat', expReward, mods);
      adv.total_gold += goldReward;
      adv.total_exp += expReward;

      // Advance to next encounter or complete
      if (adv.current_index + 1 >= adv.encounters.length) {
        adv.status = 'complete';
        // Award pending treasures
        const inv = { ...(ctx.data.inventory || {}) };
        const items = { ...(inv.items || {}) };
        for (const t of adv.pending_treasures) {
          items[t] = (items[t] || 0) + 1;
        }
        inv.items = items;
        v.__adventure = adv;

        return {
          variables: v,
          data: { 'inventory.json': inv, 'game-state.json': state },
          result: {
            success: true,
            fight: fightResult,
            adventure_status: 'complete',
            treasures: adv.pending_treasures,
            total_gold: adv.total_gold,
            total_exp: adv.total_exp,
            battles_log: adv.battles_log
          }
        };
      } else {
        adv.current_index++;
        adv.status = 'encounter';
      }
    } else {
      // Defeated — HP reached 0
      adv.status = 'defeated';
      defeatPenalties = applyDefeatPenalties(v, state, sysConfig);

      // Set dark path defeat flag for narrative
      if (state.dark_path) {
        state.flags = state.flags || {};
        state.flags.adventure_defeated = true;
        state.flags[`defeated_by_${encounter.name.replace(/\s/g, '_')}`] = true;
      }
    }

    v.__adventure = adv;

    const returnData = { 'game-state.json': state };
    return {
      variables: v,
      data: returnData,
      result: {
        success: true,
        fight: fightResult,
        adventure_status: adv.status,
        next_enemy: adv.status === 'encounter' ? adv.encounters[adv.current_index]?.name : null,
        defeat_penalties: defeatPenalties,
        dark_path: state.dark_path || false,
        total_gold: adv.total_gold,
        total_exp: adv.total_exp,
        battles_log: adv.battles_log
      }
    };
  },

  /**
   * adventure_use_item — Use a consumable item during adventure encounter.
   * args: { item }
   */
  adventure_use_item(ctx, args) {
    const { item } = args;
    if (!item) return { result: { success: false, message: '아이템 이름이 필요합니다.' } };

    const v = { ...ctx.variables };
    const adv = v.__adventure;
    if (!adv || !adv.active || adv.status !== 'encounter') {
      return { result: { success: false, message: '아이템을 사용할 수 없는 상태입니다.' } };
    }

    const inv = { ...(ctx.data.inventory || {}) };
    const items = { ...(inv.items || {}) };
    const catalog = inv.shop_catalog || {};

    // Check ownership
    if (!items[item] || items[item] <= 0) {
      return { result: { success: false, message: `${item}이(가) 없습니다.` } };
    }

    // Check it's a consumable (has effect, no type field or type is not equipment)
    const itemInfo = catalog[item];
    if (!itemInfo || itemInfo.type) {
      return { result: { success: false, message: `${item}은(는) 사용할 수 없는 아이템입니다.` } };
    }

    // Consume item
    items[item]--;
    if (items[item] <= 0) delete items[item];
    inv.items = items;

    // Apply effects
    const effects = itemInfo.effect || {};
    const applied = {};
    for (const [stat, delta] of Object.entries(effects)) {
      const oldVal = v[stat] || 0;
      if (stat === 'hp') {
        v.hp = Math.min(v.hp_max || 40, oldVal + delta);
        adv.player_hp = v.hp;
      } else if (stat === 'stress') {
        v.stress = clamp(oldVal + delta, 0, v.stress_max || 110);
      } else {
        v[stat] = oldVal + delta;
      }
      applied[stat] = (v[stat] || 0) - oldVal;
    }

    v.__adventure = adv;

    return {
      variables: v,
      data: { 'inventory.json': inv },
      result: {
        success: true,
        item_used: item,
        effects_applied: applied,
        description: itemInfo.description || '',
        player_hp: v.hp,
        player_max_hp: v.hp_max || 40,
        remaining_count: items[item] || 0
      }
    };
  },

  /**
   * adventure_retreat — Flee from adventure, keeping rewards earned so far.
   * args: (none)
   */
  adventure_retreat(ctx, args) {
    const v = { ...ctx.variables };
    const adv = v.__adventure;
    if (!adv || !adv.active || (adv.status !== 'encounter' && adv.status !== 'fight_won')) {
      return { result: { success: false, message: '퇴각할 수 없는 상태입니다.' } };
    }

    adv.status = 'retreated';
    v.__adventure = adv;

    return {
      variables: v,
      result: {
        success: true,
        adventure_status: 'retreated',
        battles_completed: adv.battles_log.length,
        total_encounters: adv.encounters.length,
        total_gold: adv.total_gold,
        total_exp: adv.total_exp,
        battles_log: adv.battles_log
      }
    };
  },

  /**
   * adventure_complete — Cleanup after adventure panel is done. Called when player clicks "완료".
   * args: (none)
   */
  adventure_complete(ctx, args) {
    const v = { ...ctx.variables };
    const adv = v.__adventure;
    if (!adv) return { result: { success: false, message: '모험 데이터가 없습니다.' } };

    const summary = {
      zone: adv.zone_name,
      status: adv.status,
      battles: adv.battles_log,
      treasures: adv.pending_treasures || [],
      total_gold: adv.total_gold,
      total_exp: adv.total_exp,
      hp_remaining: v.hp,
      hp_max: v.hp_max || 40,
      dark_path: (ctx.data['game-state'] || {}).dark_path || false
    };

    // Cleanup adventure state
    v.__adventure = null;
    v.__modals = { ...(v.__modals || {}), adventure: false };

    return {
      variables: v,
      result: { success: true, summary }
    };
  },

  /**
   * buy_item — Purchase item from shop.
   * args: { item, quantity? }
   */
  buy_item(ctx, args) {
    const { item, quantity = 1 } = args;
    const v = { ...ctx.variables };
    const inv = { ...(ctx.data.inventory || {}) };
    const catalog = inv.shop_catalog || {};

    const product = catalog[item];
    if (!product) {
      const available = Object.entries(catalog).map(([id, p]) => `${id}(${p.price}G)`).join(', ');
      return { result: { success: false, message: `상점에 '${item}'이(가) 없습니다. inventory.json의 shop_catalog에서 올바른 아이템 ID를 확인한 뒤, 이 턴의 응답을 생성하기 전에 run_tool로 직접 재호출하라.` } };
    }
    if (product.requirements && !meetsRequirements(product.requirements, v))
      return { result: { success: false, message: '구매 조건 미달' } };

    const totalCost = product.price * quantity;
    if (v.gold < totalCost)
      return { result: { success: false, message: `골드 부족 (필요: ${totalCost}G, 보유: ${v.gold}G)` } };

    v.gold -= totalCost;

    if (product.type === 'outfit') {
      const outfits = [...(inv.outfits || [])];
      if (!outfits.find(o => o.id === product.outfit_id)) {
        outfits.push({ id: product.outfit_id, name: product.outfit_name, description: product.outfit_desc, stats: product.stats || {} });
        inv.outfits = outfits;
      }
    } else {
      const items = { ...(inv.items || {}) };
      items[item] = (items[item] || 0) + quantity;
      inv.items = items;
    }

    return {
      variables: { gold: v.gold },
      data: { 'inventory.json': inv },
      result: { success: true, item, quantity, cost: totalCost, new_balance: v.gold }
    };
  },

  /**
   * use_item — Use a consumable item.
   * args: { item }
   */
  use_item(ctx, args) {
    const { item } = args;
    const inv = { ...(ctx.data.inventory || {}) };
    const items = { ...(inv.items || {}) };
    const catalog = inv.shop_catalog || {};
    const v = { ...ctx.variables };

    if (!items[item] || items[item] <= 0)
      return { result: { success: false, message: `${item}이(가) 없습니다` } };

    items[item] -= 1;
    if (items[item] <= 0) delete items[item];
    inv.items = items;

    const product = catalog[item];
    const effects = product?.effect || {};
    const mods = getModifiers(v);
    const appliedEffects = {};
    for (const [stat, delta] of Object.entries(effects)) {
      if (stat === 'gold') {
        v.gold = Math.max(0, (v.gold || 0) + delta);
        appliedEffects.gold = delta;
      } else {
        const dd = applyStat(v, stat, delta, mods);
        if (dd !== 0) appliedEffects[stat] = dd;
      }
    }

    return {
      variables: v,
      data: { 'inventory.json': inv },
      result: { success: true, item, effects: appliedEffects }
    };
  },

  /**
   * equip — Equip gear or outfit.
   * args: { type, item?, outfit_id? }
   */
  equip(ctx, args) {
    const { type, item, outfit_id } = args;
    const inv = { ...(ctx.data.inventory || {}) };
    const catalog = inv.shop_catalog || {};

    if (type === 'outfit') {
      const outfit = (inv.outfits || []).find(o => o.id === outfit_id);
      if (!outfit) return { result: { success: false, message: '해당 의상이 없습니다' } };
      inv.equipped_outfit = outfit_id;
      return {
        variables: { outfit: outfit.name },
        data: { 'inventory.json': inv },
        result: { success: true, equipped: outfit.name, stat_bonus: outfit.stats }
      };
    }

    const equipment = { ...(inv.equipment || {}) };
    const items = { ...(inv.items || {}) };
    if (!items[item] || items[item] <= 0)
      return { result: { success: false, message: `${item}이(가) 인벤토리에 없습니다` } };

    const prevItem = equipment[type];
    if (prevItem) items[prevItem] = (items[prevItem] || 0) + 1;
    items[item] -= 1;
    if (items[item] <= 0) delete items[item];
    equipment[type] = item;
    inv.equipment = equipment;
    inv.items = items;

    return {
      data: { 'inventory.json': inv },
      result: { success: true, equipped: item, type, stat_bonus: catalog[item]?.stats || {} }
    };
  },

  /**
   * add_activity — Dynamically add a new activity.
   * args: { id, name, category, cost?, requirements?, effects?, side_effects?, pay?, stat_bonus?, description? }
   */
  add_activity(ctx, args) {
    const { id, name, category, cost, requirements, effects, side_effects, pay, stat_bonus, description } = args;
    if (!id || !name || !category)
      return { result: { success: false, message: 'id, name, category는 필수입니다' } };

    const state = { ...(ctx.data['game-state'] || {}) };
    const custom = { ...(state.custom_activities || {}) };
    custom[id] = { name, category, cost: cost || 0, requirements: requirements || {}, effects: effects || {}, side_effects, pay, stat_bonus, description: description || '', is_custom: true };
    state.custom_activities = custom;

    if (meetsRequirements(requirements || {}, ctx.variables)) {
      state.unlocked_activities = [...(state.unlocked_activities || []), id];
    }

    return {
      data: { 'game-state.json': state },
      result: { success: true, activity_name: name, activity_id: id, auto_unlocked: meetsRequirements(requirements || {}, ctx.variables) }
    };
  },

  /**
   * check_ending — Evaluate ending candidates.
   * Reads all ending conditions from endings-config.json.
   */
  check_ending(ctx, args) {
    const v = ctx.variables;
    const endingsConfig = ctx.data['endings-config'] || {};
    const endingsList = endingsConfig.endings || [];
    const defaultEnding = endingsConfig.default_ending || { name: '마을 아가씨', description: '평범하지만 행복한 삶을 살다' };
    const candidates = [];

    const state = ctx.data['game-state'] || {};
    for (const ending of endingsList) {
      // Skip dark-only endings when dark path is off
      if (ending.dark_only && !state.dark_path) continue;
      const conditions = ending.conditions || {};
      if (meetsRequirements(conditions, v)) {
        // Calculate score from score_stats
        let score = 0;
        for (const stat of (ending.score_stats || [])) {
          score += (v[stat] || 0);
        }
        candidates.push({
          name: ending.name,
          score,
          description: ending.description,
          is_bad: ending.is_bad || false
        });
      }
    }

    // Always add default ending as fallback
    candidates.push({ name: defaultEnding.name, score: 0, description: defaultEnding.description });

    candidates.sort((a, b) => b.score - a.score);
    return {
      result: {
        success: true,
        candidates: candidates.slice(0, 5),
        note: 'AI는 이 후보 목록과 대화 맥락을 종합하여 가장 적절한 엔딩을 선택할 수 있다'
      }
    };
  },

  /**
   * generate_wish — Compute what Olive wants to do this month.
   * args: (none)
   *
   * Sets wish_activity and wish_text variables.
   * Returns { success, wish_category, wish_text }
   */
  generate_wish(ctx, args) {
    const v = { ...ctx.variables };
    const sysConfig = ctx.data['system-config'] || {};
    const eventsConfig = ctx.data['events-config'] || {};
    const scheduleConfig = ctx.data['schedule-config'] || {};
    const state = { ...(ctx.data['game-state'] || {}) };

    const wish = generateWishInternal(v, sysConfig, eventsConfig, scheduleConfig, state);
    v.wish_activity = wish.wish_category;
    v.wish_text = wish.wish_text;

    return {
      variables: { wish_activity: wish.wish_category, wish_text: wish.wish_text },
      result: {
        success: true,
        wish_category: wish.wish_category,
        wish_text: wish.wish_text
      }
    };
  },

  /**
   * run_competition — Run a seasonal competition.
   * args: { competition_id }
   *
   * Reads competition from events-config seasonal_events.
   * Simulates against NPCs with configurable variance.
   * Applies rewards to variables.
   * Returns { success, competition_name, rank, rank_index, score, npc_scores, rewards }
   */
  run_competition(ctx, args) {
    const { competition_id } = args;
    if (!competition_id) {
      return { result: { success: false, message: 'competition_id는 필수입니다' } };
    }

    const v = { ...ctx.variables };
    const eventsConfig = ctx.data['events-config'] || {};
    const sysConfig = ctx.data['system-config'] || {};
    const state = { ...(ctx.data['game-state'] || {}) };
    let eventLog = { ...(ctx.data['event-log'] || {}) };

    // Only one competition per festival — check if already entered any
    const entered = state.competitions_entered || [];
    if (entered.length > 0) {
      return { result: { success: false, message: '이번 축제에서는 이미 대회에 참가했습니다 (1개만 가능)' } };
    }

    const compResult = runCompetitionInternal(competition_id, v, eventsConfig, sysConfig);
    if (!compResult.success) {
      return { result: compResult };
    }

    // Apply rewards to variables (with modifiers)
    const mods = getModifiers(v);
    const statChanges = {};
    for (const [stat, delta] of Object.entries(compResult.rewards)) {
      if (stat === 'gold') {
        v.gold = Math.max(0, (v.gold || 0) + delta);
        statChanges.gold = delta;
      } else {
        const dd = applyStat(v, stat, delta, mods);
        if (dd !== 0) statChanges[stat] = dd;
      }
    }

    // Update mood after stress changes
    v.mood = getMood(v.stress || 0, sysConfig);

    // Record participation to prevent re-entry
    if (!state.competitions_entered) state.competitions_entered = [];
    state.competitions_entered.push(competition_id);

    // Clear available competitions — only 1 per season
    v.__competitions_available = [];
    v.__competitions_remaining_turns = 0;

    // Log the competition
    eventLog = addLogEntry(eventLog, {
      type: 'competition',
      month: `${v.current_year}년차 ${v.current_month}월`,
      text: `${compResult.competition_name}: ${compResult.rank} (점수: ${Math.floor(compResult.score)})`
    });

    // Collect popup effects for competition
    const compPopups = collectPopups([], null, null, compResult);

    return {
      variables: v,
      data: { 'game-state.json': state, 'event-log.json': eventLog },
      result: {
        success: true,
        competition_name: compResult.competition_name,
        category: compResult.category,
        rank: compResult.rank,
        rank_index: compResult.rank_index,
        score: Math.floor(compResult.score),
        npc_scores: compResult.npc_scores.map(n => ({ ...n, score: Math.floor(n.score) })),
        rewards: statChanges,
        popups: compPopups.length > 0 ? compPopups : undefined
      }
    };
  },


  // ============================================================
  // === set_schedule — Set schedule slots (1-3) in one call ===
  // ============================================================
  /**
   * set_schedule — 스케줄 슬롯을 설정한다.
   * args: { slots: { 1: "actId", 2: "actId", 3: "actId" } }
   *   - 일부 슬롯만 설정 가능 (예: { 1: "martial_dojo" })
   *   - "none"으로 설정하면 해당 슬롯 비움
   * result: { success, slots: { 1: actName, ... }, warnings: [] }
   */
  set_schedule(ctx, args) {
    const { slots } = args;
    if (!slots || typeof slots !== 'object') {
      return { result: { success: false, message: 'slots 파라미터가 필요합니다. 예: { 1: "martial_dojo", 2: "rest" }' } };
    }

    const v = { ...ctx.variables };
    const config = ctx.data['schedule-config'] || {};
    const acts = config.activities || {};
    const state = ctx.data['game-state'] || {};
    const custom = state.custom_activities || {};
    const allActs = { ...acts, ...custom };
    const unlocked = new Set(state.unlocked_activities || []);
    const warnings = [];
    const result = {};

    for (const [slotNum, actId] of Object.entries(slots)) {
      const n = parseInt(slotNum);
      if (n < 1 || n > 3) { warnings.push(`슬롯 ${slotNum}은 유효하지 않습니다 (1-3)`); continue; }

      if (actId === 'none' || !actId) {
        v[`schedule_${n}`] = 'none';
        result[n] = null;
        continue;
      }

      const act = allActs[actId];
      if (!act) { warnings.push(`활동 '${actId}'을(를) 찾을 수 없습니다.`); continue; }
      if (!unlocked.has(actId)) { warnings.push(`활동 '${act.name}'이(가) 아직 해금되지 않았습니다.`); continue; }

      // Check requirements
      const reqs = act.requirements || {};
      let meetsReqs = true;
      for (const [stat, min] of Object.entries(reqs)) {
        if (stat === 'gold_cost') continue;
        if ((v[stat] || 0) < min) { warnings.push(`${act.name}: ${stat} ${min} 이상 필요`); meetsReqs = false; }
      }
      if (!meetsReqs) continue;

      v[`schedule_${n}`] = actId;
      result[n] = act.name;
    }

    return {
      variables: v,
      result: { success: true, slots: result, warnings }
    };
  },


  // ============================================================
  // === confirm_schedule — Confirm schedule and start executing ===
  // ============================================================
  /**
   * confirm_schedule — 스케줄을 확정하고 실행 페이즈로 전환한다.
   * args: {} (없음)
   * result: { success, schedule: [{ slot, activity_name, activity_id }], message }
   */
  confirm_schedule(ctx, args) {
    const v = { ...ctx.variables };
    const config = ctx.data['schedule-config'] || {};
    const acts = config.activities || {};
    const state = ctx.data['game-state'] || {};
    const custom = state.custom_activities || {};
    const allActs = { ...acts, ...custom };

    // Validate at least one slot is set
    const s1 = v.schedule_1 || 'none';
    const s2 = v.schedule_2 || 'none';
    const s3 = v.schedule_3 || 'none';
    if (s1 === 'none' && s2 === 'none' && s3 === 'none') {
      return { result: { success: false, message: '스케줄이 비어있습니다. 최소 1개 슬롯을 설정해주세요.' } };
    }

    // Validate activity IDs exist
    const unlocked = new Set(state.unlocked_activities || []);
    const invalidSlots = [];
    for (const [slot, aid] of [['상순', s1], ['중순', s2], ['하순', s3]]) {
      if (aid === 'none') continue;
      if (!allActs[aid]) {
        invalidSlots.push({ slot, aid });
      }
    }
    if (invalidSlots.length > 0) {
      const errSlots = invalidSlots.map(s => `${s.slot}: "${s.aid}"`).join(', ');
      const validIds = Object.entries(allActs)
        .filter(([id, act]) => !act.requirements || Object.keys(act.requirements).length === 0 || unlocked.has(id))
        .map(([id, act]) => `${id}(${act.name})`)
        .join(', ');
      return { result: { success: false, message: `존재하지 않는 활동 ID: ${errSlots}. 사용 가능한 활동: ${validIds}` } };
    }

    // Transition to executing phase
    v.turn_phase = 'executing';
    v.current_slot = 0;

    // Close schedule modal, open advance dock, hide portrait
    v.__modals = {
      ...(v.__modals || {}),
      schedule: false,
      advance: true,
      portrait: null
    };

    const schedule = [];
    const LBL = ['', '상순', '중순', '하순'];
    for (let i = 1; i <= 3; i++) {
      const aid = v[`schedule_${i}`];
      const act = allActs[aid];
      schedule.push({
        slot: i,
        label: LBL[i],
        activity_id: aid,
        activity_name: act ? act.name : (aid === 'none' ? '없음' : aid)
      });
    }

    return {
      variables: v,
      result: {
        success: true,
        schedule,
        message: `${v.current_year}년차 ${v.current_month}월 스케줄이 확정되었습니다.`
      }
    };
  },


  // ============================================================
  // === talk_to_father — Monthly conversation with father ===
  // ============================================================
  /**
   * talk_to_father — 아빠와 대화 (월 1회 무료)
   * args: { mode: "warm"|"strict" }
   *
   * 2가지 모드 중 선택 → 내부 풀에서 랜덤 대화 주제 뽑기.
   * 스탠스에 따라 풀 내 가중치 변동. guardian_background 보너스 적용.
   * result: { success, mode, picked_topic, topic_name, effects }
   */
  talk_to_father(ctx, args) {
    const { mode } = args;
    if (!mode || !['warm', 'strict'].includes(mode)) {
      return { result: { success: false, message: 'mode가 필요합니다 (warm/strict)' } };
    }

    const v = { ...ctx.variables };
    const state = { ...(ctx.data['game-state'] || {}) };

    if (state.father_talked_this_month) {
      return { result: { success: false, already_talked: true, message: '이번 달에는 이미 아빠와 대화했습니다.' } };
    }

    const bg = v.guardian_background || 'hero';
    const stance = v.stance || 'default';

    // ── Conversation pools ──
    const POOLS = {
      warm: [
        { id: 'play', name: '함께 놀기', effects: { charm: 2, stress: -8 }, weight: 1 },
        { id: 'cook_together', name: '같이 요리하기', effects: { cooking: 3, sensitivity: 2, stress: -4 }, weight: 1 },
        { id: 'listen', name: '이야기 들어주기', effects: { sensitivity: 3, morals: 2, stress: -3 }, weight: 1 },
        { id: 'praise', name: '칭찬해주기', effects: { charm: 2, morals: 2, stress: -5 }, weight: 1 },
        { id: 'adventure_tale', name: '모험담 들려주기', effects: { combat: 2, sensitivity: 2, stress: -3 }, weight: 1 },
        { id: 'music_together', name: '같이 노래하기', effects: { music: 3, charm: 1, stress: -5 }, weight: 1 }
      ],
      strict: [
        { id: 'martial_train', name: '무술 지도', effects: { combat: 4, stamina: 2, attack: 1, stress: 2 }, weight: 1 },
        { id: 'study_check', name: '학업 점검', effects: { intelligence: 4, morals: 2, stress: 1 }, weight: 1 },
        { id: 'etiquette_lesson', name: '예절 교육', effects: { etiquette: 3, elegance: 3, stress: 2 }, weight: 1 },
        { id: 'life_lecture', name: '인생 훈화', effects: { morals: 5, sensitivity: 1, stress: 1 }, weight: 1 },
        { id: 'endurance', name: '체력 단련', effects: { stamina: 4, combat: 2, stress: 3 }, weight: 1 },
        { id: 'discipline', name: '정신 수양', effects: { faith: 3, morals: 3, stress: 2 }, weight: 1 }
      ]
    };

    // ── Stance-based weight modifiers ──
    const STANCE_WEIGHTS = {
      warrior:   { martial_train: 2, endurance: 1.5, adventure_tale: 1.5 },
      studious:  { study_check: 2, life_lecture: 1.5, listen: 1.5 },
      charming:  { praise: 2, play: 1.5, music_together: 1.5 },
      elegant:   { etiquette_lesson: 2, discipline: 1.5, praise: 1.5 },
      artistic:  { music_together: 2, listen: 1.5, cook_together: 1.5 },
      devout:    { discipline: 2, life_lecture: 1.5, listen: 1.5 },
      rebellious:{ play: 2, adventure_tale: 1.5, martial_train: 1.5 },
      culinary:  { cook_together: 2, praise: 1.5, play: 1.5 }
    };

    const pool = POOLS[mode].map(t => ({ ...t }));
    const stanceW = STANCE_WEIGHTS[stance] || {};
    for (const t of pool) {
      if (stanceW[t.id]) t.weight *= stanceW[t.id];
    }

    // Weighted random pick
    const totalWeight = pool.reduce((s, t) => s + t.weight, 0);
    let roll = Math.random() * totalWeight;
    let picked = pool[0];
    for (const t of pool) {
      roll -= t.weight;
      if (roll <= 0) { picked = t; break; }
    }

    // Apply effects (with modifiers)
    const mods = getModifiers(v);
    const appliedEffects = {};
    for (const [stat, val] of Object.entries(picked.effects)) {
      if (stat === 'gold') {
        v.gold = Math.max(0, (v.gold || 0) + val);
        appliedEffects.gold = val;
      } else {
        const dd = applyStat(v, stat, val, mods);
        if (dd !== 0) appliedEffects[stat] = dd;
      }
    }

    // Guardian background bonus (flat bonus on top, also with modifiers)
    const BG_BONUS = {
      hero: { combat: 2, attack: 1 },
      knight: { combat: 1, defense: 1 },
      scholar: { intelligence: 2 },
      wizard: { magic_power: 2 },
      priest: { faith: 2, morals: 1 },
      noble: { elegance: 2 },
      artist: { art: 2 },
      merchant: { charm: 1, gold: 5 }
    };
    const bgBonus = BG_BONUS[bg] || {};
    for (const [stat, val] of Object.entries(bgBonus)) {
      if (stat === 'gold') {
        v.gold = Math.max(0, (v.gold || 0) + val);
        appliedEffects.gold = (appliedEffects.gold || 0) + val;
      } else {
        const dd = applyStat(v, stat, val, mods);
        if (dd !== 0) appliedEffects[stat] = (appliedEffects[stat] || 0) + dd;
      }
    }

    state.father_talked_this_month = true;
    v.father_talked = true;

    return {
      variables: v,
      data: { 'game-state.json': state },
      result: {
        success: true,
        mode,
        picked_topic: picked.id,
        topic_name: picked.name,
        effects: appliedEffects
      }
    };
  },

  // ============================================================
  // === enter_competition — Register for seasonal competition ===
  // ============================================================
  /**
   * enter_competition — 계절 대회에 등록한다.
   * args: { competition_id }
   * result: { success, competition_name, category }
   */
  enter_competition(ctx, args) {
    const { competition_id } = args;
    if (!competition_id) {
      return { result: { success: false, message: 'competition_id가 필요합니다.' } };
    }

    const v = { ...ctx.variables };
    const eventsConfig = ctx.data['events-config'] || {};
    const seasonalEvents = eventsConfig.seasonal_events || {};

    // Find the competition in seasonal events
    let foundComp = null;
    for (const [, season] of Object.entries(seasonalEvents)) {
      const comps = season.competitions || [];
      const match = comps.find(c => c.id === competition_id);
      if (match) { foundComp = match; break; }
    }

    if (!foundComp) {
      return { result: { success: false, message: `대회 '${competition_id}'를 찾을 수 없습니다.` } };
    }

    // Check if already entered this season
    const state = { ...(ctx.data['game-state'] || {}) };
    if ((state.competitions_entered || []).includes(competition_id)) {
      return { result: { success: false, message: `이미 '${foundComp.name}'에 참가했습니다.` } };
    }

    // Set competition pending and open modal
    v.__competition_pending = {
      id: competition_id,
      name: foundComp.name,
      category: foundComp.category
    };
    v.__modals = { ...(v.__modals || {}), competition: true };

    return {
      variables: v,
      result: {
        success: true,
        competition_name: foundComp.name,
        category: foundComp.category
      }
    };
  }
};


// ============================================================
// === Main Dispatcher ===
// ============================================================

module.exports = async function(context, args) {
  const { action, ...params } = args;
  const handler = ACTIONS[action];
  if (!handler) return { result: { success: false, message: `알 수 없는 액션: ${action}` } };
  return handler(context, params);
};
