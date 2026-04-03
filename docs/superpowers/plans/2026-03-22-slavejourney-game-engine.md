# SlaveJourney Game Engine Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the slavejourney persona from a simple merchant/slave RP into a full turn-based strategy RPG with Civilization-style movement, Final Fantasy-style combat, and Langrisser-style class promotion.

**Architecture:** Data-driven game engine (`tools/engine.js`) is the single state mutation hub. All gameplay data lives in JSON files (`party.json`, `classes.json`, `events.json`). Panels read data and call engine actions via `__panelBridge.runTool()`. The AI narrates engine results but never directly modifies game state.

**Tech Stack:** CommonJS engine scripts (Node.js), Handlebars HTML panels (Shadow DOM), JSON data files, ComfyUI image generation for character portraits.

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `party.json` | Party roster: all owned units with stats, class, level, XP, equipment. `formation` array is single source of truth for active lineup |
| `classes.json` | Class definitions: stat growth, skills, promotion tree, requirements |
| `events.json` | Travel event pool: per-terrain/danger random encounters, story events |
| `combat.json` | **Temporary** combat state — created by `combat_start`, deleted by `combat_end`. Contains enemies, turn_order, round, buffs, log. NOT in system JSON exclusion list (panels need `{{combat.*}}`). If session closes mid-combat, `combat_end` with defeat is auto-triggered on next session open |
| `tools/combat-engine.js` | Combat subsystem — separated from main engine for maintainability. Exports action handlers merged into ACTIONS in engine.js |
| `tools/party-engine.js` | Party/class subsystem — separated from main engine. Exports party management action handlers |
| `panels/05-파티.html` | Party management panel (modal): active 4 selection, unit details, class info |
| `panels/06-전투.html` | Combat panel (modal): FF-style turn battle UI, action selection, HP bars |
| `skills/manage-party/SKILL.md` | AI skill for creating/registering new characters with combat images |

### Modified Files
| File | Changes |
|------|---------|
| `tools/engine.js` | Add turn/supply actions, refactor travel system. Import combat-engine.js and party-engine.js. Rename `equip` → `equip_slave_item` for clarity |
| `variables.json` | Add party/combat/supply variables, remove redundant travel fields |
| `panels/03-지도.html` | Add "다음 턴" (next turn) button, travel day-by-day UI, destination lock |
| `panels/01-상태.html` | Add supply gauge, active party count display |
| `layout.json` | Add new panel placements and modal groups |
| `session-instructions.md` | Add combat/party/turn system rules for AI |
| `hint-rules.json` | Add party/supply snapshot rules |
| `items.json` | Add weapons, armor, consumables for combat |
| `inventory.json` | Add equipment section |
| `world.json` | Add per-route `event_tags` for travel event matching |

---

## Data Architecture

### `party.json` — Party Roster

```json
{
  "units": [
    {
      "id": "master",
      "name": "주인",
      "class_id": "mercenary",
      "class_name": "용병",
      "level": 1,
      "xp": 0,
      "xp_to_next": 100,
      "promotion_tier": 1,
      "hp": 120, "hp_max": 120,
      "mp": 30, "mp_max": 30,
      "stats": {
        "str": 14, "def": 10, "mag": 5, "mdf": 6,
        "spd": 11, "luk": 8
      },
      "skills": ["강타"],
      "equipment": {
        "weapon": null, "armor": null, "accessory": null
      },
      "image": "images/master-battle.png",
      "is_protagonist": true,
      "upkeep": 0
    },
    {
      "id": "lira",
      "name": "리라",
      "class_id": "attendant",
      "class_name": "시종",
      "level": 1,
      "xp": 0,
      "xp_to_next": 100,
      "promotion_tier": 1,
      "hp": 80, "hp_max": 80,
      "mp": 60, "mp_max": 60,
      "stats": {
        "str": 5, "def": 6, "mag": 12, "mdf": 14,
        "spd": 10, "luk": 12
      },
      "skills": ["치유", "격려"],
      "equipment": {
        "weapon": null, "armor": null, "accessory": null
      },
      "image": "images/lira-battle.png",
      "is_slave": true,
      "upkeep": 0
    }
  ],
  "max_active": 4,
  "formation": ["master", "lira"]
}
```

**Design decisions:**
- `formation` array = **single source of truth** for active combat lineup (max 4), ordered by position. No separate `active` boolean — a unit is active iff `formation.includes(unit.id)`
- `units` array = all owned units (active + reserve)
- `upkeep` = daily food cost per unit (protagonist/lira = 0, hired mercs = 1-2)
- `promotion_tier` = how many times promoted (for tracking total progression)
- `is_protagonist` / `is_slave` = special flags (cannot be dismissed)

### `classes.json` — Class System (Langrisser-style)

```json
{
  "classes": {
    "mercenary": {
      "name": "용병",
      "type": "physical",
      "tier": 1,
      "stat_growth": { "hp": 12, "mp": 3, "str": 3, "def": 2, "mag": 0, "mdf": 1, "spd": 2, "luk": 1 },
      "base_stats": { "hp": 120, "mp": 30, "str": 14, "def": 10, "mag": 5, "mdf": 6, "spd": 11, "luk": 8 },
      "skills_learned": { "1": "강타", "4": "전투 자세", "7": "분노의 일격" },
      "promotions": ["knight", "berserker", "ranger"],
      "max_level": 10,
      "description": "기본 전투 직업. 균형 잡힌 물리 전투 능력."
    },
    "knight": {
      "name": "기사",
      "type": "physical",
      "tier": 2,
      "stat_growth": { "hp": 15, "mp": 3, "str": 3, "def": 4, "mag": 0, "mdf": 2, "spd": 1, "luk": 1 },
      "base_stats": { "hp": 150, "mp": 35, "str": 16, "def": 14, "mag": 5, "mdf": 8, "spd": 10, "luk": 8 },
      "skills_learned": { "1": "방패 방어", "4": "도발", "7": "성스러운 검" },
      "promotions": ["paladin", "dark_knight"],
      "max_level": 10,
      "description": "방어 특화. 파티를 보호하는 방패."
    },
    "attendant": {
      "name": "시종",
      "type": "support",
      "tier": 1,
      "stat_growth": { "hp": 8, "mp": 6, "str": 1, "def": 1, "mag": 3, "mdf": 3, "spd": 2, "luk": 2 },
      "base_stats": { "hp": 80, "mp": 60, "str": 5, "def": 6, "mag": 12, "mdf": 14, "spd": 10, "luk": 12 },
      "skills_learned": { "1": "치유", "3": "격려", "6": "해독", "9": "대치유" },
      "promotions": ["healer", "enchantress", "dancer"],
      "max_level": 10,
      "description": "지원 특화. 치유와 버프로 파티를 보조."
    }
  },
  "skill_definitions": {
    "강타": { "name": "강타", "type": "physical", "power": 130, "mp_cost": 5, "target": "single_enemy", "desc": "강력한 일격을 가한다." },
    "치유": { "name": "치유", "type": "heal", "power": 80, "mp_cost": 8, "target": "single_ally", "desc": "아군 하나의 HP를 회복한다." },
    "격려": { "name": "격려", "type": "buff", "power": 0, "mp_cost": 6, "target": "single_ally", "effect": { "stat": "str", "bonus": 5, "turns": 3 }, "desc": "아군의 공격력을 일시적으로 높인다." },
    "방패 방어": { "name": "방패 방어", "type": "defend", "power": 0, "mp_cost": 0, "target": "self", "effect": { "def_mult": 2.0, "turns": 1 }, "desc": "이번 턴 방어력 2배." }
  },
  "promotion_rules": {
    "required_level": 10,
    "reset_level_to": 1,
    "stat_carry_percentage": 0.3,
    "keep_skills": true
  }
}
```

**Langrisser-style promotion:**
- Level 10 달성 → 선택 가능한 전직 분기 중 하나 선택
- 레벨 1로 리셋 + 새 클래스의 base_stats 적용
- **스탯 캐리 규칙 (비복리):** `carry_bonus = (current_stats - current_class.base_stats - previous_carry_bonus) * 0.3`. 즉, **현재 클래스에서 레벨업으로 얻은 순수 성장분만** 30% 캐리. 이전 전직에서 받은 캐리 보너스는 제외하여 복리 누적 방지. 유닛에 `carry_bonus` 객체를 저장하여 추적
- 이전 클래스에서 배운 스킬은 유지 (`keep_skills`)
- `promotion_tier` 증가 (1→2→3...)

### `events.json` — Travel Event Pool

```json
{
  "travel_events": [
    {
      "id": "bandit_ambush",
      "name": "산적 매복",
      "type": "combat",
      "terrain": ["산길", "숲길", "해안 절벽"],
      "min_danger": "medium",
      "weight": 30,
      "enemies": [
        { "name": "산적 두목", "hp": 100, "mp": 20, "stats": { "str": 12, "def": 8, "mag": 3, "mdf": 5, "spd": 9, "luk": 6 }, "skills": ["강타"], "xp": 40, "gold": 30 },
        { "name": "산적", "hp": 60, "mp": 0, "stats": { "str": 8, "def": 5, "mag": 0, "mdf": 3, "spd": 10, "luk": 4 }, "skills": [], "xp": 20, "gold": 10 },
        { "name": "산적", "hp": 60, "mp": 0, "stats": { "str": 8, "def": 5, "mag": 0, "mdf": 3, "spd": 10, "luk": 4 }, "skills": [], "xp": 20, "gold": 10 }
      ],
      "narrative_hint": "숲에서 산적들이 나타나 길을 막았다!"
    },
    {
      "id": "traveling_merchant",
      "name": "방랑 상인",
      "type": "encounter",
      "terrain": ["관도", "왕도", "포장 도로"],
      "min_danger": "low",
      "weight": 25,
      "options": [
        { "text": "물건을 살펴본다", "action": "trade" },
        { "text": "정보를 물어본다", "action": "info" },
        { "text": "무시하고 지나간다", "action": "ignore" }
      ],
      "narrative_hint": "길 위에서 짐을 가득 실은 마차를 끄는 상인과 마주쳤다."
    },
    {
      "id": "wild_beast",
      "name": "야생 동물 조우",
      "type": "combat",
      "terrain": ["숲길", "산길", "늪지"],
      "min_danger": "low",
      "weight": 25,
      "enemies": [
        { "name": "늑대", "hp": 45, "mp": 0, "stats": { "str": 10, "def": 4, "mag": 0, "mdf": 2, "spd": 14, "luk": 3 }, "skills": [], "xp": 15, "gold": 0 },
        { "name": "늑대", "hp": 45, "mp": 0, "stats": { "str": 10, "def": 4, "mag": 0, "mdf": 2, "spd": 14, "luk": 3 }, "skills": [], "xp": 15, "gold": 0 }
      ],
      "narrative_hint": "덤불에서 낮은 으르렁거림이 들린다. 야생 늑대 무리다!"
    },
    {
      "id": "campsite_found",
      "name": "빈 야영지 발견",
      "type": "rest",
      "terrain": ["숲길", "관도", "해안로"],
      "min_danger": "low",
      "weight": 15,
      "effect": { "stamina_restore": 20 },
      "narrative_hint": "누군가 남기고 간 야영지를 발견했다. 아직 불씨가 남아있다."
    },
    {
      "id": "herb_patch",
      "name": "약초 군락 발견",
      "type": "loot",
      "terrain": ["숲길", "늪지", "산길"],
      "min_danger": "low",
      "weight": 10,
      "loot": { "약초": 2 },
      "narrative_hint": "길가에 약초가 무성하게 자라고 있다."
    },
    {
      "id": "storm",
      "name": "갑작스런 폭풍",
      "type": "hazard",
      "terrain": ["해안로", "해안 절벽", "사막로"],
      "min_danger": "low",
      "weight": 10,
      "effect": { "stamina_drain": 15, "delay_days": 1 },
      "narrative_hint": "하늘이 급격히 어두워지더니 폭풍이 몰아치기 시작했다!"
    },
    {
      "id": "slave_escape_rumor",
      "name": "도망 노예 소문",
      "type": "story",
      "terrain": ["관도", "왕도", "포장 도로"],
      "min_danger": "low",
      "weight": 5,
      "narrative_hint": "길에서 마주친 여행자가 근처에서 주인을 죽이고 도망친 노예 이야기를 들려준다."
    },
    {
      "id": "ruins_discovery",
      "name": "고대 유적 발견",
      "type": "exploration",
      "terrain": ["사막로", "산길", "숲길"],
      "min_danger": "medium",
      "weight": 8,
      "options": [
        { "text": "탐사한다 (위험할 수 있음)", "action": "explore_ruins" },
        { "text": "지나친다", "action": "ignore" }
      ],
      "narrative_hint": "길에서 벗어난 곳에 무너진 석조 건물이 보인다. 고대 유적인 듯하다."
    }
  ],
  "event_rules": {
    "base_event_chance": 40,
    "danger_bonus": {
      "low": 0,
      "medium": 15,
      "high": 30
    },
    "max_events_per_day": 2
  }
}
```

### `variables.json` — New/Modified Variables

**Add:**
```json
{
  "supplies_display": "10일분",
  "active_party_count": 2,
  "total_party_count": 2,
  "in_combat": false,
  "combat_turn": 0,
  "turn_number": 1
}
```

**Remove (moved to party.json):** None — keep all existing variables. The party data is separate.

**Key variable changes:**
- `supplies_display` is a **derived display value** — NOT the source of truth. Actual food is `inventory.json.supplies["식량"]` (the existing system). The engine calculates `supplies_display = Math.floor(식량수량 / daily_cost)` on every relevant action and patches this variable for panel display
- Daily cost is dynamically computed: `base_cost(2) + sum(party.units.filter(inFormation).upkeep)` — protagonist and Lira have upkeep 0, hired mercs have upkeep 1-2
- `in_combat` flag controls combat panel modal visibility via `__modals`
- `turn_number` = travel turn counter (only increments during travel via `next_turn`). `day` is the universal day counter that increments in rest/camp/next_turn
- `combat_turn` = current turn index within combat (for panel display)

---

## Task Breakdown

### Task 1: Data Foundation — `party.json` + `classes.json`

**Files:**
- Create: `data/personas/slavejourney/party.json`
- Create: `data/personas/slavejourney/classes.json`

- [ ] **Step 1: Create `party.json` with protagonist + Lira**

Create the initial party roster with two units (master + lira) using the data structure defined above. Master = mercenary class, Lira = attendant class. Both `active: true`, both in `formation`.

- [ ] **Step 2: Create `classes.json` with full class tree**

Create the class tree with at least these paths:

```
Tier 1 → Tier 2 → Tier 3
─────────────────────────
용병(mercenary) → 기사(knight) → 성기사(paladin) / 암흑기사(dark_knight)
                → 광전사(berserker) → 파괴자(destroyer) / 전쟁광(warlord)
                → 유격수(ranger) → 궁수(archer) / 암살자(assassin)

시종(attendant) → 치유사(healer) → 사제(priest) / 현자(sage)
                → 요술사(enchantress) → 마녀(witch) / 비전술사(arcane)
                → 무희(dancer) → 검무사(blade_dancer) / 음유시인(bard)

병사(soldier) → 전사(warrior) → 챔피언(champion) / 장군(general)
              → 창병(lancer) → 용기사(dragoon) / 근위병(guardian)
              → 도적(thief) → 보물사냥꾼(treasure_hunter) / 닌자(ninja)
```

`soldier` is the base class for generic recruits/mercenaries.

Each class needs: name, type (physical/magic/support/hybrid), tier, stat_growth (per-level gains), base_stats (starting stats when entering this class), skills_learned (at which levels), promotions (array of next-tier class_ids), max_level (always 10), description.

Add all referenced skills to `skill_definitions`. Each skill: name, type (physical/heal/buff/debuff/magic), power, mp_cost, target (single_enemy/all_enemies/single_ally/all_allies/self), optional effect object, desc.

- [ ] **Step 3: Validate JSON files parse correctly**

Run: `node -e "require('./party.json'); require('./classes.json'); console.log('OK')"`

### Task 2: Travel Event Data — `events.json` + `world.json` Update

**Files:**
- Create: `data/personas/slavejourney/events.json`
- Modify: `data/personas/slavejourney/world.json` (add `event_tags` to routes)

- [ ] **Step 1: Create `events.json` with event pool**

Create 15-20 travel events across types: combat (5-6), encounter (4-5), loot (2-3), hazard (2-3), story (2-3), rest (1-2). Use the structure defined above. Ensure terrain tags match actual route terrains in world.json.

Combat events must include enemy data: name, hp, stats (str/def/spd minimum), skills array, xp reward, gold reward. Scale enemies across 3 difficulty tiers matching route danger levels.

- [ ] **Step 2: Add `event_tags` to world.json routes**

Add `"event_tags": ["terrain_type"]` to each route in world.json, matching the route's terrain to event pool terrain filters. This enables the engine to filter events by the current route's characteristics.

Example: `{ "from": "vela_port", "to": "coral_village", "terrain": "해안로", "event_tags": ["해안로", "coastal"] }`

- [ ] **Step 3: Validate data integrity**

Run: `node -e "const e=require('./events.json'); const w=require('./world.json'); console.log('Events:', e.travel_events.length, 'Routes with tags:', w.routes.filter(r=>r.event_tags).length)"`

### Task 3: Variables + Items Update

**Files:**
- Modify: `data/personas/slavejourney/variables.json`
- Modify: `data/personas/slavejourney/items.json`
- Modify: `data/personas/slavejourney/inventory.json`
- Modify: `data/personas/slavejourney/hint-rules.json`

- [ ] **Step 1: Add new variables to `variables.json`**

Add: `supplies` (10), `supplies_daily_cost` (2), `active_party_count` (2), `total_party_count` (2), `in_combat` (false), `combat_turn` (0), `turn_number` (1). Keep all existing variables.

- [ ] **Step 2: Add combat items to `items.json`**

Add `weapons`, `armor`, `accessories` sections:

```json
{
  "weapons": {
    "낡은 검": { "desc": "기본 검.", "price": 30, "weight": 2, "stats": { "str": 3 }, "type": "sword" },
    "사냥꾼 활": { "desc": "경량 활.", "price": 40, "weight": 1.5, "stats": { "str": 2, "spd": 1 }, "type": "bow" },
    "나무 지팡이": { "desc": "기본 지팡이.", "price": 25, "weight": 1, "stats": { "mag": 3 }, "type": "staff" }
  },
  "armor": {
    "가죽 갑옷": { "desc": "기본 방어구.", "price": 35, "weight": 3, "stats": { "def": 3 } },
    "천 로브": { "desc": "마법사용 로브.", "price": 30, "weight": 1, "stats": { "def": 1, "mdf": 3 } }
  },
  "accessories": {
    "행운의 부적": { "desc": "행운 +3.", "price": 50, "weight": 0.1, "stats": { "luk": 3 } }
  }
}
```

Add more items (8-10 weapons, 5-6 armor, 4-5 accessories) across tiers.

- [ ] **Step 3: Update inventory.json with starting equipment**

Add `equipment_stock` section for shop items, give protagonist and Lira starting weapons.

- [ ] **Step 4: Add supply/party hint rules**

Add to hint-rules.json:
- `supplies`: format `{value}일분`, tiers for depletion level
- `active_party_count`: format `{value}/4`, tiers for party fullness
- `turn_number`: format `Turn {value}`, no tiers

### Task 4: Engine — Turn System + Supply + Party Management

**Files:**
- Modify: `data/personas/slavejourney/tools/engine.js`

This is the largest task. Add the following engine actions:

- [ ] **Step 1: Add `next_turn` action**

The core "Civilization-style" turn advancement:

```javascript
ACTIONS.next_turn = function(ctx, args) {
  // 1. Must be traveling (else no turn to advance — in-town use rest/camp)
  // 2. Consume 식량 from inventory.supplies based on party size
  //    daily_cost = 2 + sum(formation units' upkeep)
  //    If 식량 < daily_cost: partial consume + stamina penalty
  // 3. Decrement travel_days_left
  // 4. Roll for travel events (using events.json + current route's event_tags)
  // 5. If travel_days_left == 0, arrive at destination + auto-call look
  // 6. Advance day, weather, season
  // 7. Update supplies_display = Math.floor(remaining_food / daily_cost)
  // 8. Increment turn_number
  // 9. Return: day summary, events triggered, arrival status
}
```

Key: this replaces the old `advance_time` auto-travel behavior. Now each day is explicitly advanced by the player pressing the "다음 턴" button. The `next_turn` button only shows during travel. In-town day advancement uses existing `rest`/`camp` actions.

- [ ] **Step 2: Add `forage` action (현지 조달)**

```javascript
ACTIONS.forage = function(ctx, args) {
  // When supplies are low, attempt to gather food locally
  // Success based on terrain + party luck
  // Returns: supplies gained (1-3) or failure
}
```

- [ ] **Step 3: Add party management actions**

```javascript
ACTIONS.party_status = function(ctx, args) {
  // Return full party roster with computed stats
}

ACTIONS.set_formation = function(ctx, args) {
  // args: { formation: ["unit_id", ...] } — max 4
  // Validates unit IDs exist and are owned
}

ACTIONS.recruit = function(ctx, args) {
  // args: { unit data from AI skill }
  // Adds unit to party.json units array
  // Deducts recruitment cost from gold
  // Does NOT auto-add to formation (user must manage via panel)
  // Updates total_party_count
}

ACTIONS.dismiss = function(ctx, args) {
  // args: { unit_id }
  // Cannot dismiss protagonist or Lira (is_protagonist/is_slave flags)
  // Removes from units array and formation (if in it)
  // Updates active_party_count / total_party_count
}

ACTIONS.equip_unit = function(ctx, args) {
  // args: { unit_id, slot: "weapon|armor|accessory", item: "item_name" }
  // item: null → unequip that slot (returns item to inventory)
  // Applies stat changes from equipment
  // NOTE: This is for party combat equipment (weapons/armor/accessories)
  //       Separate from equip_slave_item (renamed from equip) which handles
  //       slave items (족쇄/목줄/눈가리개 etc.)
}
```

- [ ] **Step 4: Add class/promotion actions**

```javascript
ACTIONS.promote = function(ctx, args) {
  // args: { unit_id, new_class_id }
  // Validates: unit is level 10, new_class_id is in current class's promotions
  // Langrisser rules: reset to level 1, apply new class base_stats
  // Carry 30% of accumulated growth stats as bonus
  // Keep all learned skills
  // Increment promotion_tier
}

// level_up is an INTERNAL helper, not a public action
function levelUp(unit, classDef) {
  // Apply class stat_growth to unit stats
  // Check skills_learned for new skills at this level
  // Increase xp_to_next (formula: 100 * level * 1.2)
  // Return: level, new_skills, stat_changes
}

ACTIONS.gain_xp = function(ctx, args) {
  // args: { unit_id, amount } or { party: true, amount } for party-wide XP
  // Add XP, auto-chain levelUp() if threshold reached (can multi-level)
  // Return: per-unit XP gained, level ups, new skills learned
}
```

- [ ] **Step 5: Refactor `travel` action**

Change `travel` to only set the destination and calculate route — no longer starts auto-advancing. The player must press "다음 턴" to advance each day.

```javascript
// travel now just locks in destination
// next_turn handles the day-by-day movement
```

- [ ] **Step 6: Refactor `advance_time` and `camp` and `rest`**

**advance_time:** Remove all travel-day processing (lines 267-298 of current engine). It now only handles in-location time passage (hours within a day). Travel progression is exclusively via `next_turn`.

**camp:** Remove travel-day decrement logic (lines ~1012-1026 of current engine). Camp is now only for overnight rest during travel (recovers stamina, but does NOT advance travel). Also add: **party HP restoration** — `camp` restores 30% of each formation unit's HP/MP.

**rest:** Keep inn behavior. Also add: **party HP restoration** — `rest` restores 100% of each formation unit's HP/MP (full heal at inn). Update `supplies_display` after food consumption.

Both `rest` and `camp` increment `day` counter but NOT `turn_number` (turn_number is travel-only).

### Task 5: Engine — Combat System

**Files:**
- Modify: `data/personas/slavejourney/tools/engine.js`

- [ ] **Step 1: Add `combat_start` action**

```javascript
ACTIONS.combat_start = function(ctx, args) {
  // args: { enemies: [...] } — enemy data from event or AI
  // Initialize combat state in variables
  // Determine turn order by speed (party + enemies)
  // Set in_combat = true
  // Open combat modal panel
  // Return: initial combat state, turn order
}
```

Combat state stored in `combat.json` (temporary data file during combat):
```json
{
  "enemies": [ { "id": "e1", "name": "산적", "hp": 60, "hp_max": 60, ... } ],
  "turn_order": ["master", "e1", "lira", "e2"],
  "current_turn": 0,
  "round": 1,
  "buffs": {},
  "log": []
}
```

- [ ] **Step 2: Add `combat_action` + `combat_resolve_enemies` actions**

```javascript
ACTIONS.combat_action = function(ctx, args) {
  // args: { unit_id, action: "attack|skill|defend|item", target_id?, skill_name?, item_name? }
  // Process one PLAYER unit's action only
  // Calculate damage, apply effects
  // Advance turn_order to next unit
  // If next unit(s) are enemies, auto-chain combat_resolve_enemies internally
  // Return: player action result + all auto-resolved enemy actions in sequence
  // If all enemies dead → auto-trigger combat_end (victory)
  // If all party dead → auto-trigger combat_end (defeat)
}

ACTIONS.combat_flee = function(ctx, args) {
  // Flee is party-wide, not per-unit
  // Success based on party avg SPD vs enemy avg SPD + luck
  // Success → combat_end(fled), lose some gold
  // Failure → enemies get free attacks, then next player turn
}

ACTIONS.combat_resolve_enemies = function(ctx, args) {
  // Process ALL consecutive enemy turns in one call
  // Each enemy auto-selects: attack weakest or use skill
  // Returns array of all enemy actions taken
  // This prevents race conditions from multiple round-trips
  // Called internally by combat_action when next turns are enemies
  // Can also be called directly by panel if needed
}
```

Damage formula (FF-style simplified):
- Physical: `damage = (attacker.str + weapon.str) * (skill.power / 100) - (defender.def + armor.def) * 0.5`
- Magic: `damage = (attacker.mag + weapon.mag) * (skill.power / 100) - defender.mdf * 0.5`
- Heal: `heal = caster.mag * (skill.power / 100)`
- Minimum damage = 1
- ±10% randomness applied to all damage/heal values

- [ ] **Step 3: Add `combat_end` action**

```javascript
ACTIONS.combat_end = function(ctx, args) {
  // Auto-called when combat resolves
  // Victory: distribute XP to all active party, add gold, check level ups
  // Defeat: lose some gold, party HP set to 1, retreat to last location
  // Set in_combat = false
  // Close combat modal
  // Delete combat.json
  // Return: results summary, XP gained, items dropped
}
```

### Task 6: Map Panel — Turn-Based Travel UI

**Files:**
- Modify: `data/personas/slavejourney/panels/03-지도.html`

- [ ] **Step 1: Add "다음 턴" button**

Add a prominent "다음 턴" (Next Turn) button that:
- Only visible when `traveling` is true
- Calls `engine.next_turn()`
- Displays the day's events in the panel
- Shows travel progress (day X of Y)
- Disabled during combat

- [ ] **Step 2: Add destination lock UX**

When the user selects a destination:
- Show confirmation with route info (days, danger, terrain)
- "출발" button calls `engine.travel({ destination })` to lock in
- After departure, hide destination selection, show progress + next_turn button
- Show "다음 턴" button prominently

- [ ] **Step 3: Add day event display**

After each `next_turn`:
- Show event cards (combat encounter, merchant, loot, etc.)
- Combat events show "전투 시작" button → opens combat modal
- Encounter events show choice buttons
- Loot/rest events show auto-applied results

- [ ] **Step 4: Show arrival celebration**

When `travel_days_left` reaches 0:
- Display arrival notification
- Auto-call `engine.look()` for new location
- Transition back to normal destination-selection mode

### Task 7: Party Management Panel

**Files:**
- Create: `data/personas/slavejourney/panels/05-파티.html`
- Modify: `data/personas/slavejourney/layout.json`

- [ ] **Step 1: Design party panel (modal)**

A modal panel showing:
- All owned units with portrait, name, class, level, HP/MP bars
- Active/Reserve toggle buttons (drag or click to swap)
- Active formation slots (4 max) clearly shown
- Unit detail view on click: full stats, skills, equipment, XP progress, promotion availability

Use `/frontend-design` skill for production-quality UI.

- [ ] **Step 2: Add equipment management**

Within unit detail view:
- Show current equipment slots (weapon/armor/accessory)
- List available items from inventory
- Equip/unequip buttons calling `engine.equip_unit()`
- Stat preview showing before/after equip

- [ ] **Step 3: Add promotion UI**

When a unit reaches level 10:
- Show "전직 가능!" badge
- Display branching class options with descriptions
- Preview stat changes for each option
- Confirm button calls `engine.promote()`

- [ ] **Step 4: Add layout.json entries**

Add to layout.json:
```json
{
  "panels": {
    "placement": {
      "파티": "modal",
      "전투": "modal"
    },
    "modalGroups": {
      "overlay": ["지도", "인벤토리", "파티"]
    },
    "autoRefresh": {
      "파티": false,
      "전투": false
    }
  }
}
```

Note: `전투` MUST have `autoRefresh: false` — combat panel manages its own state through `runTool` callbacks and animations. Variable changes during combat would cause destructive re-renders.

`파티` also needs `autoRefresh: false` to preserve tab state and equipment selection UI.

### Task 8: Combat Panel

**Files:**
- Create: `data/personas/slavejourney/panels/06-전투.html`

- [ ] **Step 1: Design FF-style combat UI**

A full-screen modal panel showing:
- **Top**: Enemy sprites/names with HP bars
- **Middle**: Battle log (scrolling text of actions)
- **Bottom**: Party lineup with HP/MP bars + active unit's action menu

Action menu (for current turn's unit):
- ⚔️ 공격 (basic attack)
- ✨ 스킬 (opens skill submenu)
- 🛡️ 방어 (defend this turn)
- 🎒 아이템 (use combat item)
- 🏃 도주 (flee attempt)

Use `/frontend-design` skill for polished battle UI with animations.

- [ ] **Step 2: Add turn indicator + action flow**

- Highlight whose turn it is (party or enemy)
- When it's a party member's turn, show action buttons
- When it's an enemy's turn, auto-resolve and animate
- Show damage numbers, healing numbers
- Skill selection submenu with MP cost display

- [ ] **Step 3: Add victory/defeat screens**

- Victory: XP gained, gold acquired, items dropped, level-up notifications
- Defeat: "전투에서 패배했다..." message, consequences shown
- Dismiss button to close combat panel

### Task 9: Status Panel Update + Supply Gauge

**Files:**
- Modify: `data/personas/slavejourney/panels/01-상태.html`

- [ ] **Step 1: Add supply gauge**

Add a supply bar showing `supplies` with color coding:
- Green (>5 days), Yellow (3-5), Red (<3)
- Label: "보급품: X일분"
- Add "현지 조달" button that calls `engine.forage()`

- [ ] **Step 2: Add party summary**

Show: "파티: X/4명 활성" + button to open party modal
Show: "턴: {turn_number}" counter

### Task 10: Character Creation Skill

**Files:**
- Create: `data/personas/slavejourney/skills/manage-party/SKILL.md`

- [ ] **Step 1: Write SKILL.md for party management**

```markdown
---
name: manage-party
description: 새로운 전투 캐릭터를 파티에 등록하거나, 기존 캐릭터의 정보를 조회/수정할 때 사용
allowed-tools: Read, Write, Edit, Glob, Bash
---

# 파티 관리

## 신규 캐릭터 등록
1. classes.json을 읽어 사용 가능한 클래스 확인
2. 캐릭터 데이터 구성 (name, class_id, stats 등)
3. engine의 `recruit` 액션으로 파티에 추가
4. ComfyUI로 전투 이미지 생성 (profile 워크플로, 전투 포즈)
5. party.json에 image 경로 기록

## 전직 처리
1. 레벨 10 달성한 유닛 확인
2. 사용자에게 전직 옵션 제시
3. engine의 `promote` 액션으로 전직 실행

## 용병 고용
NPC 용병 상점에서 제공하는 용병을 고용할 때:
- 고용비: 금화로 지불
- 유지비: 일일 식량 소모 (upkeep 값)
- 기본 클래스: soldier (Tier 1)
```

### Task 11: Session Instructions Update

**Files:**
- Modify: `data/personas/slavejourney/session-instructions.md`

- [ ] **Step 1: Add turn-based travel rules**

Add section explaining:
- Travel is day-by-day via "다음 턴" button (not instant)
- AI describes each day's journey based on engine events
- Combat events require AI to narrate the battle
- Supply consumption is automatic

- [ ] **Step 2: Add combat rules**

Add section explaining:
- FF-style turn-based combat via engine
- AI narrates combat actions with character personality
- Lira has combat dialogue appropriate to her personality
- Victory/defeat narrative integration

- [ ] **Step 3: Add party management rules**

Add section explaining:
- New party members can join via story events or hiring
- Use `manage-party` skill for character creation
- Promotion at level 10 with player choice

- [ ] **Step 4: Add new engine actions to the action list**

Document all new engine actions: `next_turn`, `forage`, `party_status`, `set_formation`, `recruit`, `dismiss`, `equip_unit`, `promote`, `level_up`, `gain_xp`, `combat_start`, `combat_action`, `combat_end`.

### Task 12: Battle Portraits — Initial Characters

**Files:**
- Generate images to: `data/personas/slavejourney/images/`

- [ ] **Step 1: Generate master battle portrait**

Use ComfyUI `profile` workflow to generate a battle-ready portrait for the protagonist (male merchant/fighter). Save as `images/master-battle.png`.

- [ ] **Step 2: Generate Lira battle portrait**

Use ComfyUI to generate Lira in a support/healer pose. Save as `images/lira-battle.png`.

### Task 13: Integration Testing

- [ ] **Step 1: Test full travel + combat loop**

```javascript
// Test: travel → next_turn → combat event → combat_start → combat_action → combat_end → arrive
const engine = require('./tools/engine.js');
// ... full integration test
```

- [ ] **Step 2: Test party management loop**

```javascript
// Test: recruit → set_formation → equip_unit → promote
```

- [ ] **Step 3: Test supply depletion loop**

```javascript
// Test: next_turn x N → supplies deplete → forage → continue
```

---

## Dependency Order

```
Task 1 (Data: party + classes) ──→ Task 4 (Engine: turn/supply/party)
Task 2 (Data: events + world)  ──→ Task 4
Task 3 (Data: variables + items) → Task 4
                                    ↓
Task 4 ──→ Task 5 (Engine: combat)
Task 4 ──→ Task 6 (Panel: map turn-based)
Task 4 ──→ Task 7 (Panel: party management)
Task 5 ──→ Task 8 (Panel: combat)
Task 4 ──→ Task 9 (Panel: status update)
Task 1 ──→ Task 10 (Skill: manage-party)
All   ──→ Task 11 (Session instructions)
Task 1 ──→ Task 12 (Battle portraits)
All   ──→ Task 13 (Integration testing)
```

**Parallel groups:**
- Group A (independent): Tasks 1, 2, 3 — all data files, can run in parallel
- Group B (depends on A): Tasks 4, 10 — engine + skill
- Group C (depends on B): Tasks 5, 6, 7, 9 — engine combat + panels
- Group D (depends on C): Task 8 — combat panel
- Group E (depends on all): Tasks 11, 12, 13 — finalization

---

## Risk Notes

1. **Engine size → Module splitting**: engine.js is already 2237 lines. This overhaul adds ~800-1000 more. **Mitigated** by splitting into `tools/engine.js` (dispatcher + existing), `tools/combat-engine.js` (combat subsystem), `tools/party-engine.js` (party/class subsystem). The main engine does `const combatActions = require('./combat-engine'); Object.assign(ACTIONS, combatActions);` to merge. The custom tools system only routes to `engine.js` via `runTool('engine', ...)`, so internal `require()` is transparent.

2. **Combat state persistence**: `combat.json` is a custom data file (not in system JSON exclusion list), so panels can read it as `__panelBridge.data.combat`. The engine writes to it via the `data: { "combat.json": ... }` return pattern. If session closes mid-combat, next session open should auto-resolve as defeat via a check in the `look` action.

3. **Combat panel race conditions**: Mitigated by `combat_resolve_enemies` action that batch-processes all enemy turns in one engine call. The panel chains: player action → engine resolves + auto-resolves enemies → return all results → panel animates sequentially.

4. **Turn button UX**: The "다음 턴" button must feel responsive. Panel shows loading state during engine call. Engine returns event data, panel displays event cards before AI narration.

5. **Class balance**: Initial stat values are placeholder. Balance tuning will happen during playtesting.

6. **`equip` vs `equip_unit` clarity**: Existing `equip` action is renamed to `equip_slave_item` for slave items (족쇄/목줄). New `equip_unit` is for party combat equipment (weapons/armor). session-instructions.md must document both clearly.
