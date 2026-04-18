"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import PersonaCard from "@/components/PersonaCard";
import SessionCard from "@/components/SessionCard";
import ProfileCard from "@/components/ProfileCard";
import NewPersonaDialog from "@/components/NewPersonaDialog";
import NewProfileDialog from "@/components/NewProfileDialog";
import PersonaStartModal from "@/components/PersonaStartModal";
import ImportPersonaModal from "@/components/ImportPersonaModal";
import PublishPersonaModal from "@/components/PublishPersonaModal";
import ClonePersonaDialog from "@/components/ClonePersonaDialog";

const PERSONA_ACCENTS = [
  "var(--plum)",
  "#e6a664",
  "#8ec46a",
  "#6ac4e6",
  "#e66a8c",
  "#c888e6",
];

interface Persona {
  name: string;
  displayName: string;
  hasIcon?: boolean;
  tagline?: string;
  importMeta?: {
    source: string;
    url: string;
    installedAt: string;
    installedCommit: string;
  };
  publishMeta?: {
    url: string;
  };
}

interface Session {
  id: string;
  persona: string;
  displayName?: string;
  title: string;
  createdAt: string;
  hasIcon?: boolean;
  model?: string;
}

interface ProfileOption {
  slug: string;
  name: string;
  isPrimary?: boolean;
}

export default function LobbyPage() {
  const router = useRouter();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<{
    slug: string;
    name: string;
    description: string;
    isPrimary?: boolean;
  } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  useEffect(() => {
    if (window.innerWidth < 768) setSidebarOpen(false);
  }, []);
  const [importOpen, setImportOpen] = useState(false);
  const [publishTarget, setPublishTarget] = useState<string | null>(null);
  const [updateStatuses, setUpdateStatuses] = useState<Record<string, { status: string; behindCount?: number }>>({});
  const [cloneTarget, setCloneTarget] = useState<string | null>(null);
  const [startModal, setStartModal] = useState<{
    open: boolean;
    personaName: string;
    personaDisplayName: string;
    accentColor: string;
  }>({ open: false, personaName: "", personaDisplayName: "", accentColor: "" });

  const loadLobby = useCallback(async () => {
    const [pRes, sRes, prRes] = await Promise.all([
      fetch("/api/personas"),
      fetch("/api/sessions"),
      fetch("/api/profiles"),
    ]);
    if (pRes.ok) setPersonas(await pRes.json());
    if (sRes.ok) setSessions(await sRes.json());
    if (prRes.ok) {
      const list = await prRes.json();
      setProfiles(list);
      if (list.length === 0) setProfileDialogOpen(true);
    }
  }, []);

  useEffect(() => {
    loadLobby();
  }, [loadLobby]);

  const handlePersonaClick = (personaName: string, displayName: string, index: number) => {
    setStartModal({
      open: true,
      personaName,
      personaDisplayName: displayName,
      accentColor: PERSONA_ACCENTS[index % PERSONA_ACCENTS.length],
    });
  };

  const startSession = async (personaName: string, profileSlug?: string, model?: string) => {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personaName, profileSlug }),
    });
    if (res.ok) {
      const session = await res.json();
      const q = model ? `?model=${encodeURIComponent(model)}` : "";
      router.push(`/chat/${encodeURIComponent(session.id)}${q}`);
    }
  };

  const createProfile = async (
    name: string,
    description: string,
    isPrimary?: boolean
  ): Promise<ProfileOption> => {
    const res = await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, isPrimary }),
    });
    const data = await res.json();
    if (isPrimary) {
      // Update local state to clear other primaries
      setProfiles((prev) =>
        prev.map((p) => ({ ...p, isPrimary: false }))
      );
    }
    const newProfile = { slug: data.slug, name: data.name, isPrimary };
    setProfiles((prev) => [...prev, newProfile]);
    return newProfile;
  };

  const editProfile = async (slug: string) => {
    const res = await fetch(`/api/profiles/${encodeURIComponent(slug)}`);
    if (!res.ok) return;
    const data = await res.json();
    setEditingProfile({
      slug: data.slug,
      name: data.name,
      description: data.description || "",
      isPrimary: data.isPrimary,
    });
    setProfileDialogOpen(true);
  };

  const saveProfile = async (name: string, description: string, isPrimary?: boolean) => {
    if (editingProfile) {
      await fetch(`/api/profiles/${encodeURIComponent(editingProfile.slug)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, isPrimary }),
      });
      setEditingProfile(null);
      loadLobby();
    } else {
      await createProfile(name, description, isPrimary);
    }
  };

  const deleteProfile = async (slug: string) => {
    await fetch(`/api/profiles/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    });
    setProfiles((prev) => prev.filter((p) => p.slug !== slug));
  };

  const deleteSession = async (id: string) => {
    await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    loadLobby();
  };

  const startBuilder = (name: string, model?: string) => {
    const params = new URLSearchParams({ mode: "new" });
    if (model) params.set("model", model);
    router.push(`/builder/${encodeURIComponent(name)}?${params}`);
  };

  const editPersona = (name: string) => {
    router.push(`/builder/${encodeURIComponent(name)}?mode=edit`);
  };

  const deletePersona = async (name: string) => {
    // Delete all sessions belonging to this persona first
    const related = sessions.filter((s) => s.persona === name);
    await Promise.all(
      related.map((s) =>
        fetch(`/api/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" })
      )
    );
    await fetch(`/api/personas/${encodeURIComponent(name)}`, { method: "DELETE" });
    loadLobby();
  };

  const handleImported = useCallback((_name: string) => {
    loadLobby();
  }, [loadLobby]);

  const handleOpenBuilder = useCallback((name: string, initialMessage: string) => {
    router.push(`/builder/${encodeURIComponent(name)}?mode=edit&initialMessage=${encodeURIComponent(initialMessage)}`);
  }, [router]);

  const handleCheckUpdate = useCallback(async (name: string) => {
    setUpdateStatuses((prev) => ({ ...prev, [name]: { status: "checking" } }));
    try {
      const res = await fetch(`/api/personas/${encodeURIComponent(name)}/check-update`, { method: "POST" });
      const data = await res.json();
      if (data.upToDate) {
        setUpdateStatuses((prev) => ({ ...prev, [name]: { status: "up-to-date" } }));
      } else {
        setUpdateStatuses((prev) => ({ ...prev, [name]: { status: "update-available", behindCount: data.behindCount } }));
      }
    } catch {
      setUpdateStatuses((prev) => ({ ...prev, [name]: { status: "error" } }));
    }
  }, []);

  const handleUpdate = useCallback((name: string) => {
    const msg = "이 페르소나는 외부에서 가져온 것이며 원본 리포에 업데이트가 있습니다. origin에서 최신 변경사항을 pull 받아주세요. 완료 후 보안 점검도 진행할까요?";
    router.push(`/builder/${encodeURIComponent(name)}?mode=edit&initialMessage=${encodeURIComponent(msg)}`);
  }, [router]);

  const sessionCountByPersona = (name: string) =>
    sessions.filter((s) => s.persona === name).length;

  const personaIndexMap = useMemo(() => {
    const m = new Map<string, number>();
    personas.forEach((p, i) => m.set(p.name, i));
    return m;
  }, [personas]);

  return (
    <div className="flex h-screen relative bg-lobby-bg text-text">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar: Sessions */}
      <aside
        className={`shrink-0 flex flex-col border-r border-lobby-border bg-lobby-surface transition-all duration-normal overflow-hidden
          fixed inset-y-0 left-0 z-40 md:relative md:z-auto ${
          sidebarOpen ? "w-[280px]" : "w-0 border-r-0"
        }`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-lobby-border">
          <span className="font-serif italic text-sm" style={{ color: "var(--plum)" }}>
            Sessions
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-text-mute uppercase tracking-[0.15em]">
              {sessions.length}
            </span>
            <button
              onClick={() => setSidebarOpen(false)}
              className="w-7 h-7 flex items-center justify-center rounded-md text-text-dim/60 cursor-pointer
                hover:bg-white/5 hover:text-text transition-all duration-fast text-sm"
            >
              &lsaquo;
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {sessions.length === 0 ? (
            <p className="font-serif italic text-text-mute text-sm text-center py-10">
              아직 세션이 없습니다
            </p>
          ) : (
            sessions.map((s, i) => (
              <SessionCard
                key={s.id}
                id={s.id}
                title={s.displayName || s.title}
                persona={s.displayName || s.persona}
                createdAt={s.createdAt}
                hasIcon={s.hasIcon}
                model={s.model}
                index={i}
                personaIndex={personaIndexMap.get(s.persona) ?? 0}
                onOpen={() => {
                  router.push(`/chat/${encodeURIComponent(s.id)}`);
                  if (window.innerWidth < 768) setSidebarOpen(false);
                }}
                onDelete={() => deleteSession(s.id)}
              />
            ))
          )}
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header
          className="flex items-center gap-3 px-4 py-3 md:px-7 md:py-4 border-b border-lobby-border backdrop-blur-glass"
          style={{ background: "color-mix(in srgb, var(--lobby-bg) 60%, transparent)" }}
        >
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              className="w-8 h-8 flex items-center justify-center rounded-md text-text-dim cursor-pointer
                border border-lobby-border hover:bg-white/5 hover:text-text transition-all duration-fast text-sm"
            >
              &rsaquo;
            </button>
          )}
          <div className="flex items-baseline gap-[3px]">
            <span className="font-sans font-medium text-[15px]" style={{ letterSpacing: "-0.01em" }}>
              Claude
            </span>
            <span className="font-serif italic text-[15px]" style={{ color: "var(--plum)", letterSpacing: "-0.01em" }}>
              Play
            </span>
          </div>
          <div className="w-px h-3.5 bg-white/10 mx-3 hidden sm:block" />
          <span className="hidden sm:inline text-[11px] text-text-mute uppercase tracking-[0.2em]">
            Lobby
          </span>

          <div className="ml-auto flex items-center gap-1.5 md:gap-2 overflow-x-auto">
            {profiles.map((p) => (
              <ProfileCard
                key={p.slug}
                name={p.name}
                isPrimary={p.isPrimary}
                onEdit={() => editProfile(p.slug)}
                onDelete={() => deleteProfile(p.slug)}
              />
            ))}
            <button
              onClick={() => { setEditingProfile(null); setProfileDialogOpen(true); }}
              className="w-6 h-6 flex items-center justify-center rounded-full text-text-dim/60 cursor-pointer
                border border-dashed border-white/15 hover:bg-white/5 hover:text-text transition-all duration-fast text-xs"
              title="Add profile"
            >
              +
            </button>
          </div>
        </header>

        {/* Persona area */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-[1040px] mx-auto px-4 py-10 md:px-12 md:py-14">
            {/* Hero */}
            <div className="text-center mb-12 md:mb-14 animate-[slideUp_0.4s_ease_both]">
              <div className="text-[10px] font-medium uppercase mb-3.5" style={{ color: "var(--plum)", letterSpacing: "0.35em" }}>
                Tonight&rsquo;s Cast
              </div>
              <h2 className="font-sans font-extralight text-[30px] md:text-[38px] leading-[1.1]" style={{ letterSpacing: "-0.035em" }}>
                Who would you like to meet
                <span className="font-serif italic font-normal" style={{ color: "var(--plum)" }}>?</span>
              </h2>
              <p className="text-[13px] text-text-dim/70 mt-3.5 font-light">
                Choose a persona to start a new session
              </p>
              <div className="w-10 h-px mx-auto mt-5" style={{ background: "var(--plum-hairline)" }} />
            </div>

            {/* Grid */}
            <div
              className="grid gap-4 md:gap-[18px] mb-8 animate-[slideUp_0.4s_ease_0.08s_both]"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(200px, 100%), 1fr))" }}
            >
              {personas.map((p, i) => (
                <PersonaCard
                  key={p.name}
                  name={p.name}
                  displayName={p.displayName}
                  hasIcon={p.hasIcon}
                  tagline={p.tagline}
                  index={i}
                  sessionCount={sessionCountByPersona(p.name)}
                  onSelect={() => handlePersonaClick(p.name, p.displayName, i)}
                  onEdit={() => editPersona(p.name)}
                  onDelete={() => deletePersona(p.name)}
                  onClone={() => setCloneTarget(p.name)}
                  importMeta={p.importMeta}
                  publishMeta={p.publishMeta}
                  onCheckUpdate={p.importMeta ? () => handleCheckUpdate(p.name) : undefined}
                  updateStatus={updateStatuses[p.name]?.status ?? null}
                  behindCount={updateStatuses[p.name]?.behindCount}
                  onUpdate={updateStatuses[p.name]?.status === "update-available" ? () => handleUpdate(p.name) : undefined}
                />
              ))}

              {/* New Persona */}
              <button
                onClick={() => setDialogOpen(true)}
                className="flex flex-col items-center justify-center gap-2 rounded-xl cursor-pointer
                  border border-dashed border-white/10 min-h-[220px]
                  transition-all duration-fast hover:border-plum-hairline hover:bg-plum-soft"
              >
                <div className="w-9 h-9 rounded-[10px] flex items-center justify-center bg-plum-soft border border-plum-hairline"
                  style={{ color: "var(--plum)" }}>
                  <span className="text-lg font-extralight">+</span>
                </div>
                <span className="text-[11px] text-text-dim tracking-wider">페르소나 추가</span>
              </button>

              {/* Import from GitHub */}
              <button
                onClick={() => setImportOpen(true)}
                className="flex flex-col items-center justify-center gap-2 rounded-xl cursor-pointer
                  border border-dashed border-white/10 min-h-[220px] text-text-dim
                  transition-all duration-fast hover:border-plum-hairline hover:text-text"
              >
                <div className="w-9 h-9 rounded-[10px] flex items-center justify-center bg-white/[0.03] border border-white/10 text-text-dim/80">
                  <span className="text-base">&darr;</span>
                </div>
                <span className="text-[11px] tracking-wider">GitHub에서 가져오기</span>
              </button>
            </div>

            <div className="mt-8 text-center text-[10px] uppercase tracking-[0.25em] text-white/[0.18]">
              — Claude Play · Lobby —
            </div>
          </div>
        </div>
      </main>

      <NewPersonaDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreate={startBuilder}
      />

      <NewProfileDialog
        open={profileDialogOpen}
        onClose={() => {
          setProfileDialogOpen(false);
          setEditingProfile(null);
        }}
        onSave={saveProfile}
        editData={editingProfile}
        required={profiles.length === 0}
      />

      <PersonaStartModal
        open={startModal.open}
        personaName={startModal.personaName}
        personaDisplayName={startModal.personaDisplayName}
        accentColor={startModal.accentColor}
        profiles={profiles}
        onClose={() =>
          setStartModal({ open: false, personaName: "", personaDisplayName: "", accentColor: "" })
        }
        onStart={(profileSlug, model) => {
          const pName = startModal.personaName;
          setStartModal({ open: false, personaName: "", personaDisplayName: "", accentColor: "" });
          startSession(pName, profileSlug, model);
        }}
        onPublish={() => {
          const pName = startModal.personaName;
          setStartModal({ open: false, personaName: "", personaDisplayName: "", accentColor: "" });
          setPublishTarget(pName);
        }}
        isImported={!!personas.find(p => p.name === startModal.personaName)?.importMeta}
        isPublished={!!personas.find(p => p.name === startModal.personaName)?.publishMeta}
      />

      <ImportPersonaModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={handleImported}
        onOpenBuilder={handleOpenBuilder}
      />
      <PublishPersonaModal
        open={!!publishTarget}
        personaName={publishTarget || ""}
        onClose={() => setPublishTarget(null)}
        onOpenBuilder={handleOpenBuilder}
      />
      <ClonePersonaDialog
        open={!!cloneTarget}
        sourceName={cloneTarget || ""}
        onClose={() => setCloneTarget(null)}
        onCloned={() => loadLobby()}
      />
    </div>
  );
}
