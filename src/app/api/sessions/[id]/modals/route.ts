import * as fs from "fs";
import * as path from "path";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { mutateSessionJson } from "@/lib/session-state";

interface ModalAction {
  action: "open" | "close" | "closeAll";
  name?: string;
  mode?: true | "dismissible";
  except?: string[];
}

/**
 * POST /api/sessions/[id]/modals
 *
 * Dedicated modal visibility management with group-aware logic.
 * When opening a modal, other modals in the same group are auto-closed.
 * Groups are defined in layout.json -> panels.modalGroups.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const svc = getServices();
  const sessionDir = svc.sessions.getSessionDir(id);

  let body: ModalAction;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { action, name, mode, except } = body;

  if (!action || !["open", "close", "closeAll"].includes(action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }
  if ((action === "open" || action === "close") && !name) {
    return NextResponse.json({ error: "name is required for open/close" }, { status: 400 });
  }

  const varsPath = path.join(sessionDir, "variables.json");
  if (!fs.existsSync(varsPath)) {
    return NextResponse.json({ error: "variables.json not found" }, { status: 404 });
  }

  try {
    // modal groups (layout.json) — variables와 독립이라 transform 밖에서 읽음
    const layoutPath = path.join(sessionDir, "layout.json");
    let modalGroups: Record<string, string[]> = {};
    if (fs.existsSync(layoutPath)) {
      try {
        let layoutRaw = fs.readFileSync(layoutPath, "utf-8");
        if (layoutRaw.charCodeAt(0) === 0xfeff) layoutRaw = layoutRaw.slice(1);
        modalGroups = JSON.parse(layoutRaw)?.panels?.modalGroups || {};
      } catch { /* groups 없이 진행 */ }
    }
    const findGroup = (m: string): string | null => {
      for (const [g, members] of Object.entries(modalGroups)) if (members.includes(m)) return g;
      return null;
    };

    let resultModals: Record<string, unknown> = {};
    const r = await mutateSessionJson(varsPath, (current) => {
      const modals: Record<string, unknown> = { ...((current.__modals as Record<string, unknown>) || {}) };
      switch (action) {
        case "open": {
          const group = findGroup(name!);
          if (group) for (const member of modalGroups[group] || []) if (member !== name) modals[member] = false;
          modals[name!] = mode ?? "dismissible";
          break;
        }
        case "close":
          modals[name!] = false;
          break;
        case "closeAll": {
          const exceptSet = new Set(except || []);
          for (const key of Object.keys(modals)) if (!exceptSet.has(key)) modals[key] = false;
          break;
        }
      }
      resultModals = modals;
      return { ...current, __modals: modals };
    });
    if (!r.ok) {
      return NextResponse.json({ error: "Failed to update modals" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, __modals: resultModals });
  } catch (err) {
    console.error("[modals] error:", err);
    return NextResponse.json({ error: "Failed to update modals" }, { status: 500 });
  }
}
