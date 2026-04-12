import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "node:url";

// ── Type definitions ──────────────────────────────────────────────

export interface ParamDef {
  node: string;
  field: string;
  type?: "string" | "number" | "boolean" | "object" | "array";
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface WorkflowFeatures {
  checkpoint_auto?: boolean;
  lora_injection?: boolean;
  lora_couple_branches?: boolean;
  seed_randomize?: boolean;
  trigger_tags?: boolean;
}

export interface WorkflowOutputDef {
  node: string;
  type?: string;
  description?: string;
}

export interface WorkflowPackageMeta {
  description?: string;
  features?: WorkflowFeatures;
  outputs?: Record<string, WorkflowOutputDef>;
  params: Record<string, ParamDef>;
}

export interface ResolverContext {
  sessionDir?: string;
  config?: Record<string, unknown>;
  models?: { checkpoints: string[]; loras: string[] };
  defaultResolve: ResolverFn;
}

export type ResolverFn = (
  workflow: Record<string, unknown>,
  params: Record<string, unknown>,
  context: ResolverContext
) => Record<string, unknown>;

// ── Package types ─────────────────────────────────────────────────

export interface WorkflowPackage {
  name: string;
  workflow: Record<string, unknown>;
  meta: WorkflowPackageMeta;
  resolverPath?: string;
}

export interface WorkflowPackageSummary {
  name: string;
  description?: string;
  params: Record<string, { type?: string; required?: boolean; description?: string }>;
  hasResolver: boolean;
}

// ── Package load ──────────────────────────────────────────────────

export function loadPackage(workflowsDir: string, name: string): WorkflowPackage {
  const pkgDir = path.join(workflowsDir, name);
  if (!fs.existsSync(pkgDir) || !fs.statSync(pkgDir).isDirectory()) {
    throw new Error(`Workflow package "${name}" not found at ${pkgDir}`);
  }
  const workflowPath = path.join(pkgDir, "workflow.json");
  if (!fs.existsSync(workflowPath)) {
    throw new Error(`workflow.json not found in package "${name}"`);
  }
  const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf-8"));
  const paramsPath = path.join(pkgDir, "params.json");
  if (!fs.existsSync(paramsPath)) {
    throw new Error(`params.json not found in package "${name}"`);
  }
  const meta: WorkflowPackageMeta = JSON.parse(fs.readFileSync(paramsPath, "utf-8"));
  if (!meta.params || typeof meta.params !== "object") {
    throw new Error(`params.json in package "${name}" has no params field`);
  }
  const resolverPath = path.join(pkgDir, "resolver.mjs");
  const hasResolver = fs.existsSync(resolverPath);
  return { name, workflow, meta, resolverPath: hasResolver ? resolverPath : undefined };
}

// ── Package listing ───────────────────────────────────────────────

export function listPackages(workflowsDir: string): WorkflowPackageSummary[] {
  if (!fs.existsSync(workflowsDir)) return [];
  const entries = fs.readdirSync(workflowsDir, { withFileTypes: true });
  const results: WorkflowPackageSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const paramsPath = path.join(workflowsDir, entry.name, "params.json");
    if (!fs.existsSync(paramsPath)) continue;
    try {
      const meta: WorkflowPackageMeta = JSON.parse(fs.readFileSync(paramsPath, "utf-8"));
      const paramSummary: Record<string, { type?: string; required?: boolean; description?: string }> = {};
      for (const [k, v] of Object.entries(meta.params || {})) {
        paramSummary[k] = { type: v.type, required: v.required, description: v.description };
      }
      results.push({
        name: entry.name,
        description: meta.description,
        params: paramSummary,
        hasResolver: fs.existsSync(path.join(workflowsDir, entry.name, "resolver.mjs")),
      });
    } catch {
      /* skip malformed */
    }
  }
  return results;
}

// ── Default resolver ──────────────────────────────────────────────

function applyDefaultResolve(
  workflow: Record<string, unknown>,
  mcpParams: Record<string, unknown>,
  paramDefs: Record<string, ParamDef>
): Record<string, unknown> {
  for (const [paramName, paramDef] of Object.entries(paramDefs)) {
    const value = mcpParams[paramName] !== undefined ? mcpParams[paramName] : paramDef.default;
    if (value === undefined && paramDef.required) {
      throw new Error(`Required parameter "${paramName}" not provided`);
    }
    if (value === undefined) continue;
    // node/field가 없는 파라미터는 resolver 전용 제어 파라미터 — 기본 리졸버에서 건너뜀
    if (!paramDef.node || !paramDef.field) continue;
    const node = workflow[paramDef.node] as Record<string, unknown> | undefined;
    if (!node) continue;
    const inputs = node.inputs as Record<string, unknown> | undefined;
    if (!inputs) {
      node.inputs = { [paramDef.field]: value };
    } else {
      inputs[paramDef.field] = value;
    }
  }
  return workflow;
}

// ── Custom resolver loader ────────────────────────────────────────

async function loadCustomResolver(resolverPath: string): Promise<ResolverFn> {
  const stat = fs.statSync(resolverPath);
  const url = `${pathToFileURL(resolverPath)}?t=${stat.mtimeMs}`;
  const mod = await import(/* webpackIgnore: true */ url);
  if (typeof mod.default !== "function") {
    throw new Error(`resolver.mjs at ${resolverPath} does not export a default function`);
  }
  return mod.default as ResolverFn;
}

// ── Main resolve entry point ──────────────────────────────────────

export async function resolveWorkflow(
  pkg: WorkflowPackage,
  mcpParams: Record<string, unknown>,
  context: Omit<ResolverContext, "defaultResolve">
): Promise<Record<string, unknown>> {
  const workflow = JSON.parse(JSON.stringify(pkg.workflow)) as Record<string, unknown>;
  delete workflow._meta;
  const fullContext: ResolverContext = {
    ...context,
    defaultResolve: (wf, params) => applyDefaultResolve(wf, params, pkg.meta.params),
  };
  if (pkg.resolverPath) {
    const customResolve = await loadCustomResolver(pkg.resolverPath);
    return customResolve(workflow, mcpParams, fullContext);
  } else {
    return applyDefaultResolve(workflow, mcpParams, pkg.meta.params);
  }
}

// ── Parameter validation ──────────────────────────────────────────

export function validateParams(
  mcpParams: Record<string, unknown>,
  paramDefs: Record<string, ParamDef>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const [name, def] of Object.entries(paramDefs)) {
    const value = mcpParams[name];
    if (value === undefined) {
      if (def.required && def.default === undefined) {
        errors.push(`Required parameter "${name}" is missing`);
      }
      continue;
    }
    if (def.type) {
      const actualType = Array.isArray(value) ? "array" : typeof value;
      if (def.type === "array" && !Array.isArray(value)) {
        errors.push(`Parameter "${name}" expected array, got ${typeof value}`);
      } else if (def.type !== "array" && actualType !== def.type) {
        errors.push(`Parameter "${name}" expected ${def.type}, got ${actualType}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
