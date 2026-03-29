import * as fs from "fs";
import * as path from "path";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

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
    // Read current variables
    let raw = fs.readFileSync(varsPath, "utf-8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const vars = JSON.parse(raw);
    const modals: Record<string, unknown> = vars.__modals || {};

    // Read modal groups from layout.json
    const layoutPath = path.join(sessionDir, "layout.json");
    let modalGroups: Record<string, string[]> = {};
    if (fs.existsSync(layoutPath)) {
      try {
        let layoutRaw = fs.readFileSync(layoutPath, "utf-8");
        if (layoutRaw.charCodeAt(0) === 0xfeff) layoutRaw = layoutRaw.slice(1);
        const layout = JSON.parse(layoutRaw);
        modalGroups = layout?.panels?.modalGroups || {};
      } catch {
        // layout parse error — proceed without groups
      }
    }

    // Find group for a given modal name
    function findGroup(modalName: string): string | null {
      for (const [groupName, members] of Object.entries(modalGroups)) {
        if (members.includes(modalName)) return groupName;
      }
      return null;
    }

    // Get all members of a group
    function getGroupMembers(groupName: string): string[] {
      return modalGroups[groupName] || [];
    }

    switch (action) {
      case "open": {
        // Close other modals in the same group
        const group = findGroup(name!);
        if (group) {
          for (const member of getGroupMembers(group)) {
            if (member !== name) {
              modals[member] = false;
            }
          }
        }
        modals[name!] = mode ?? "dismissible";
        break;
      }
      case "close": {
        modals[name!] = false;
        break;
      }
      case "closeAll": {
        const exceptSet = new Set(except || []);
        for (const key of Object.keys(modals)) {
          if (!exceptSet.has(key)) {
            modals[key] = false;
          }
        }
        break;
      }
    }

    // Write back atomically
    vars.__modals = modals;
    fs.writeFileSync(varsPath, JSON.stringify(vars, null, 2), "utf-8");


    return NextResponse.json({ ok: true, __modals: modals });
  } catch (err) {
    console.error("[modals] error:", err);
    return NextResponse.json({ error: "Failed to update modals" }, { status: 500 });
  }
}
