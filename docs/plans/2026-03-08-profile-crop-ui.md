# Profile Crop UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 세션 중 생성된 이미지를 portrait 비율로 크롭하여 프로필 이미지로 설정하는 인터랙티브 모달 UI 구현

**Architecture:** React 컴포넌트(`ProfileCropModal`)를 `createPortal`로 렌더링. Canvas 기반 크롭 박스 + 하단 썸네일 스트립. 서버에서 sharp로 실제 크롭 처리. MCP `update_profile` 호출 시 crop 없으면 WS 이벤트로 모달 오픈, 사용자가 크롭 확정하면 별도 API로 처리 완료.

**Tech Stack:** React 19, Canvas API, sharp (Node.js), Next.js API Routes, WebSocket

---

### Task 1: sharp 패키지 설치

**Step 1: 설치**

```bash
npm install sharp
```

**Step 2: 타입 확인**

sharp는 자체 타입 선언을 포함하므로 `@types/sharp` 불필요. `import sharp from 'sharp'`가 타입 에러 없이 동작하는지 확인.

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add sharp dependency for image cropping"
```

---

### Task 2: 세션 이미지 목록 API

**Files:**
- Create: `src/app/api/sessions/[id]/images/route.ts`

**Step 1: API 구현**

세션의 `images/` 디렉토리에서 이미지 파일 목록을 반환하는 GET 엔드포인트.

```typescript
import * as fs from "fs";
import * as path from "path";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const svc = getServices();
  const sessionDir = svc.sessions.getSessionDir(id);
  const imagesDir = path.join(sessionDir, "images");

  if (!fs.existsSync(imagesDir)) {
    return NextResponse.json({ images: [] });
  }

  const files = fs.readdirSync(imagesDir)
    .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
    .filter((f) => f !== "profile.png" && f !== "icon.png")
    .sort()
    .map((f) => `images/${f}`);

  return NextResponse.json({ images: files });
}
```

주의: `profile.png`과 `icon.png`은 결과물이므로 목록에서 제외.

**Step 2: 수동 테스트**

```bash
curl http://localhost:3340/api/sessions/<session-id>/images
```

Expected: `{"images":["images/foo-001.png","images/bar-002.png",...]}`

**Step 3: Commit**

```bash
git add src/app/api/sessions/\[id\]/images/route.ts
git commit -m "feat: add session images list API endpoint"
```

---

### Task 3: 크롭 완료 API 엔드포인트

**Files:**
- Create: `src/app/api/sessions/[id]/crop-profile/route.ts`

**Step 1: 구현**

프론트엔드에서 크롭 좌표를 받아 sharp로 크롭 → profile.png 저장 → faceCrop → 페르소나 동기화 → WS 브로드캐스트.

```typescript
import { NextResponse } from "next/server";
import * as path from "path";
import * as fs from "fs";
import sharp from "sharp";
import { getServices } from "@/lib/services";
import { ComfyUIClient } from "@/lib/comfyui-client";
import { wsBroadcast } from "@/lib/ws-server";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const svc = getServices();
  const sessionDir = svc.sessions.getSessionDir(id);

  const body = (await req.json()) as {
    sourceImage: string;
    crop: { x: number; y: number; width: number; height: number };
  };

  if (!body.sourceImage || !body.crop) {
    return NextResponse.json(
      { error: "Missing sourceImage or crop" },
      { status: 400 }
    );
  }

  const sourceImagePath = path.join(sessionDir, body.sourceImage);
  if (!fs.existsSync(sourceImagePath)) {
    return NextResponse.json(
      { error: `Source image not found: ${body.sourceImage}` },
      { status: 404 }
    );
  }

  const imagesDir = path.join(sessionDir, "images");
  fs.mkdirSync(imagesDir, { recursive: true });

  // Step 1: Crop with sharp → profile.png
  const profilePath = path.join(imagesDir, "profile.png");
  const { x, y, width, height } = body.crop;
  await sharp(sourceImagePath)
    .extract({
      left: Math.round(x),
      top: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    })
    .toFile(profilePath);

  console.log(
    `[crop-profile] Cropped ${body.sourceImage} (${x},${y},${width}x${height}) → profile.png`
  );

  // Step 2: Face-crop for icon
  const host = process.env.COMFYUI_HOST || "127.0.0.1";
  const port = parseInt(process.env.COMFYUI_PORT || "8188", 10);
  const workflowsDir = path.join(
    process.cwd(), "data", "tools", "comfyui", "skills", "generate-image", "workflows"
  );
  const client = new ComfyUIClient({ host, port }, workflowsDir);

  let iconResult;
  try {
    iconResult = await client.faceCrop(profilePath, "icon.png", sessionDir);
  } catch (err) {
    console.error(`[crop-profile] Face crop failed:`, err);
    iconResult = { success: false, error: String(err) };
  }

  // Step 3: Sync to persona directory
  const sessionInfo = svc.sessions.getSessionInfo(id);
  const personaName = sessionInfo?.persona;
  let personaSynced = false;
  if (personaName && svc.sessions.personaExists(personaName)) {
    try {
      const personaImagesDir = path.join(
        svc.sessions.getPersonaDir(personaName), "images"
      );
      fs.mkdirSync(personaImagesDir, { recursive: true });
      fs.copyFileSync(profilePath, path.join(personaImagesDir, "profile.png"));
      if (iconResult?.success) {
        const sessionIconPath = path.join(imagesDir, "icon.png");
        if (fs.existsSync(sessionIconPath)) {
          fs.copyFileSync(
            sessionIconPath,
            path.join(personaImagesDir, "icon.png")
          );
        }
      }
      personaSynced = true;
    } catch (err) {
      console.error(`[crop-profile] Persona sync failed:`, err);
    }
  }

  // Step 4: Broadcast
  const timestamp = Date.now();
  wsBroadcast("profile:update", {
    sessionId: id,
    profile: "images/profile.png",
    icon: iconResult?.success ? "images/icon.png" : null,
    timestamp,
  });

  return NextResponse.json({
    status: "success",
    profile: "images/profile.png",
    icon: iconResult?.success ? "images/icon.png" : null,
    iconError: iconResult?.success ? undefined : iconResult?.error,
    personaSynced,
  });
}
```

**Step 2: Commit**

```bash
git add src/app/api/sessions/\[id\]/crop-profile/route.ts
git commit -m "feat: add crop-profile API with sharp image cropping"
```

---

### Task 4: update-profile API 수정 — crop 없으면 WS 이벤트 전송

**Files:**
- Modify: `src/app/api/tools/comfyui/update-profile/route.ts`

**Step 1: crop 파라미터 분기 추가**

기존 body에 `crop` 필드 추가. crop이 없으면 `profile:crop-request` WS 이벤트만 보내고 즉시 응답. crop이 있으면 sharp로 크롭 후 기존 flow.

```typescript
// 변경할 body 타입:
const body = (await req.json()) as {
  sourceImage: string;
  crop?: { x: number; y: number; width: number; height: number };
  persona?: string;
};

// crop이 없으면 → 크롭 모달 요청만 보내고 리턴
if (!body.crop) {
  wsBroadcast("profile:crop-request", {
    sessionId: svc.currentSessionId,
    sourceImage: body.sourceImage,
  });
  return NextResponse.json({
    status: "pending_crop",
    message: "Crop modal opened for user. Profile will be updated after user confirms crop area.",
  });
}

// crop이 있으면 → sharp 크롭 후 기존 flow
// Step 1: Crop with sharp → profile.png (기존 copyFileSync 대체)
import sharp from "sharp";
const profilePath = path.join(imagesDir, "profile.png");
await sharp(sourceImagePath)
  .extract({
    left: Math.round(body.crop.x),
    top: Math.round(body.crop.y),
    width: Math.round(body.crop.width),
    height: Math.round(body.crop.height),
  })
  .toFile(profilePath);
```

전체 파일은 아래 구조로 재작성:
1. `body.sourceImage` 검증 (기존 동일)
2. `sessionDir` 확인 (기존 동일)
3. 소스 이미지 존재 확인 (기존 동일)
4. **분기**: `!body.crop` → broadcast `profile:crop-request` + 즉시 return `pending_crop`
5. `body.crop` 있으면 → sharp extract → profile.png
6. faceCrop → icon.png (기존 동일)
7. 페르소나 동기화 (기존 동일)
8. broadcast `profile:update` (기존 동일)

**Step 2: Commit**

```bash
git add src/app/api/tools/comfyui/update-profile/route.ts
git commit -m "feat: update-profile supports crop coords, broadcasts crop-request when absent"
```

---

### Task 5: MCP 도구 update_profile에 crop 필드 추가

**Files:**
- Modify: `src/mcp/claude-bridge-mcp-server.mjs` (lines 492-513)

**Step 1: inputSchema 수정**

```javascript
server.registerTool(
  "update_profile",
  {
    description:
      "Update the persona's profile image. If crop coordinates are omitted, opens an interactive " +
      "crop modal for the user to select the portrait area. If crop is provided, crops directly. " +
      "After cropping, auto-generates a face-cropped icon (256x256) and syncs to persona directory.",
    inputSchema: {
      sourceImage: z.string().min(1).describe(
        "Relative path within session, e.g. 'images/mira-walk-flustered-202.png'"
      ),
      crop: z.object({
        x: z.number().describe("Crop start X in source image pixels"),
        y: z.number().describe("Crop start Y in source image pixels"),
        width: z.number().describe("Crop width in pixels"),
        height: z.number().describe("Crop height in pixels"),
      }).optional().describe(
        "Crop coordinates. If omitted, an interactive crop modal opens for the user."
      ),
    },
  },
  async (input) => {
    try {
      const payload = { sourceImage: input.sourceImage };
      if (input.crop) payload.crop = input.crop;
      const data = await requestJson("POST", "/api/tools/comfyui/update-profile", payload);
      return ok(data);
    } catch (error) {
      return fail(error);
    }
  }
);
```

**Step 2: Commit**

```bash
git add src/mcp/claude-bridge-mcp-server.mjs
git commit -m "feat: update_profile MCP tool supports optional crop coordinates"
```

---

### Task 6: ProfileCropModal React 컴포넌트

**Files:**
- Create: `src/components/ProfileCropModal.tsx`

**Step 1: 컴포넌트 구현**

핵심 기능:
- `createPortal(document.body)`로 렌더링
- Canvas 위에 이미지 + 반투명 dim 오버레이 + 밝은 크롭 박스
- 크롭 박스: portrait 비율 (832:1216 = 0.684:1) 고정
- 드래그로 크롭 박스 이동 (마우스/터치), 바운더리 클램핑
- 줌 슬라이더: 50%~100% 크롭 박스 크기 조절
- 하단 썸네일 스트립: 세션 이미지 목록, 가로 스크롤, 선택 시 이미지 교체
- 확인/취소 버튼
- 확인 시 표시 좌표 → 원본 픽셀 좌표 변환 후 `POST /api/sessions/{id}/crop-profile` 호출

```typescript
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";

const PORTRAIT_RATIO = 832 / 1216; // width / height ≈ 0.684

interface CropRect {
  x: number; y: number; width: number; height: number;
}

interface ProfileCropModalProps {
  sessionId: string;
  initialImage?: string; // relative path like "images/foo.png"
  onClose: () => void;
  onComplete?: () => void;
}

export default function ProfileCropModal({
  sessionId,
  initialImage,
  onClose,
  onComplete,
}: ProfileCropModalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [images, setImages] = useState<string[]>([]);
  const [selectedImage, setSelectedImage] = useState(initialImage || "");
  const [imageLoaded, setImageLoaded] = useState(false);
  const [zoom, setZoom] = useState(1.0); // 1.0 = max (full width or height)
  const [cropOffset, setCropOffset] = useState({ x: 0, y: 0 }); // crop box center offset from image center
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [dragOffsetStart, setDragOffsetStart] = useState({ x: 0, y: 0 });
  const [submitting, setSubmitting] = useState(false);
  const [visible, setVisible] = useState(false);

  // Animate in
  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  // Load session images list
  useEffect(() => {
    fetch(`/api/sessions/${sessionId}/images`)
      .then((r) => r.json())
      .then((data) => {
        setImages(data.images || []);
        if (!selectedImage && data.images?.length > 0) {
          setSelectedImage(data.images[data.images.length - 1]);
        }
      });
  }, [sessionId]); // selectedImage intentionally excluded

  // Load selected image
  useEffect(() => {
    if (!selectedImage) return;
    setImageLoaded(false);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      setImageLoaded(true);
      setCropOffset({ x: 0, y: 0 });
      setZoom(1.0);
    };
    img.src = `/api/sessions/${sessionId}/files?path=${selectedImage}`;
  }, [selectedImage, sessionId]);

  // Compute display dimensions and crop box
  const getLayout = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return null;

    const cw = canvas.width;
    const ch = canvas.height;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;

    // Fit image into canvas
    const scale = Math.min(cw / iw, ch / ih);
    const dispW = iw * scale;
    const dispH = ih * scale;
    const imgX = (cw - dispW) / 2;
    const imgY = (ch - dispH) / 2;

    // Crop box size at current zoom
    // Start with max crop box that fits image in portrait ratio
    let cropW = dispW;
    let cropH = cropW / PORTRAIT_RATIO;
    if (cropH > dispH) {
      cropH = dispH;
      cropW = cropH * PORTRAIT_RATIO;
    }
    // Apply zoom (zoom=1 → full size, zoom=0.5 → half)
    cropW *= zoom;
    cropH *= zoom;

    // Crop box position (centered + offset, clamped)
    const centerX = imgX + dispW / 2;
    const centerY = imgY + dispH / 2;
    let cx = centerX + cropOffset.x - cropW / 2;
    let cy = centerY + cropOffset.y - cropH / 2;
    cx = Math.max(imgX, Math.min(imgX + dispW - cropW, cx));
    cy = Math.max(imgY, Math.min(imgY + dispH - cropH, cy));

    return { imgX, imgY, dispW, dispH, cropX: cx, cropY: cy, cropW, cropH, scale, iw, ih };
  }, [zoom, cropOffset]);

  // Draw canvas
  useEffect(() => {
    if (!imageLoaded) return;
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const layout = getLayout();
    if (!layout) return;

    const { imgX, imgY, dispW, dispH, cropX, cropY, cropW, cropH } = layout;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw image
    ctx.drawImage(img, imgX, imgY, dispW, dispH);

    // Dim overlay (outside crop)
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    // Top
    ctx.fillRect(imgX, imgY, dispW, cropY - imgY);
    // Bottom
    ctx.fillRect(imgX, cropY + cropH, dispW, imgY + dispH - cropY - cropH);
    // Left
    ctx.fillRect(imgX, cropY, cropX - imgX, cropH);
    // Right
    ctx.fillRect(cropX + cropW, cropY, imgX + dispW - cropX - cropW, cropH);

    // Crop box border
    ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
    ctx.lineWidth = 2;
    ctx.strokeRect(cropX, cropY, cropW, cropH);

    // Rule of thirds guidelines
    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 2; i++) {
      const gx = cropX + (cropW * i) / 3;
      const gy = cropY + (cropH * i) / 3;
      ctx.beginPath(); ctx.moveTo(gx, cropY); ctx.lineTo(gx, cropY + cropH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cropX, gy); ctx.lineTo(cropX + cropW, gy); ctx.stroke();
    }
  }, [imageLoaded, getLayout]);

  // Resize canvas to fill container
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const ro = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
      // Trigger redraw
      setImageLoaded((v) => v); // force re-render
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Mouse/touch drag handlers
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const layout = getLayout();
    if (!layout) return;
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Only start drag if pointer is inside crop box
    if (
      mx >= layout.cropX && mx <= layout.cropX + layout.cropW &&
      my >= layout.cropY && my <= layout.cropY + layout.cropH
    ) {
      setDragging(true);
      setDragStart({ x: e.clientX, y: e.clientY });
      setDragOffsetStart({ ...cropOffset });
      canvas.setPointerCapture(e.pointerId);
    }
  }, [getLayout, cropOffset]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    setCropOffset({
      x: dragOffsetStart.x + dx,
      y: dragOffsetStart.y + dy,
    });
  }, [dragging, dragStart, dragOffsetStart]);

  const handlePointerUp = useCallback(() => {
    setDragging(false);
  }, []);

  // Submit crop
  const handleConfirm = useCallback(async () => {
    const layout = getLayout();
    if (!layout) return;

    // Convert display coords to original image pixels
    const { imgX, imgY, scale, cropX, cropY, cropW, cropH } = layout;
    const origX = (cropX - imgX) / scale;
    const origY = (cropY - imgY) / scale;
    const origW = cropW / scale;
    const origH = cropH / scale;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/crop-profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceImage: selectedImage,
          crop: {
            x: Math.round(origX),
            y: Math.round(origY),
            width: Math.round(origW),
            height: Math.round(origH),
          },
        }),
      });
      if (res.ok) {
        onComplete?.();
        onClose();
      }
    } finally {
      setSubmitting(false);
    }
  }, [getLayout, sessionId, selectedImage, onClose, onComplete]);

  // ESC to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 transition-opacity duration-200"
        style={{
          zIndex: 10000,
          backgroundColor: "rgba(0, 0, 0, 0.7)",
          backdropFilter: "blur(4px)",
          opacity: visible ? 1 : 0,
        }}
        onClick={onClose}
      />
      {/* Modal */}
      <div
        className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none"
        style={{ zIndex: 10001 }}
      >
        <div
          className="relative pointer-events-auto w-full transition-all duration-200 flex flex-col"
          style={{
            maxWidth: "800px",
            maxHeight: "85vh",
            opacity: visible ? 1 : 0,
            transform: visible ? "scale(1) translateY(0)" : "scale(0.95) translateY(10px)",
          }}
        >
          <div
            className="rounded-2xl overflow-hidden border border-white/[0.08] shadow-2xl flex flex-col"
            style={{ backgroundColor: "rgba(15, 15, 26, 0.95)" }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
              <span className="text-[12px] font-semibold uppercase tracking-wider"
                style={{ color: "var(--accent, #b8a0e8)", opacity: 0.8 }}>
                Profile Crop
              </span>
              <button onClick={onClose}
                className="text-white/40 hover:text-white/80 transition-colors p-1"
                aria-label="Close">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="4" y1="4" x2="12" y2="12" />
                  <line x1="12" y1="4" x2="4" y2="12" />
                </svg>
              </button>
            </div>

            {/* Canvas area */}
            <div ref={containerRef} className="relative flex-1 min-h-0"
              style={{ height: "50vh" }}>
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full cursor-move"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
              />
              {!imageLoaded && selectedImage && (
                <div className="absolute inset-0 flex items-center justify-center text-white/40">
                  Loading...
                </div>
              )}
              {!selectedImage && (
                <div className="absolute inset-0 flex items-center justify-center text-white/40">
                  Select an image below
                </div>
              )}
            </div>

            {/* Zoom slider */}
            <div className="px-5 py-2 flex items-center gap-3 border-t border-white/[0.06]">
              <span className="text-white/40 text-xs">Zoom</span>
              <input
                type="range"
                min="0.5"
                max="1"
                step="0.01"
                value={zoom}
                onChange={(e) => setZoom(parseFloat(e.target.value))}
                className="flex-1 accent-purple-400"
              />
              <span className="text-white/40 text-xs w-10 text-right">
                {Math.round(zoom * 100)}%
              </span>
            </div>

            {/* Thumbnail strip */}
            <div className="px-3 py-2 border-t border-white/[0.06]">
              <div className="flex gap-2 overflow-x-auto pb-1"
                style={{ scrollbarWidth: "thin" }}>
                {images.map((img) => (
                  <button
                    key={img}
                    onClick={() => setSelectedImage(img)}
                    className="flex-shrink-0 rounded-lg overflow-hidden border-2 transition-all"
                    style={{
                      width: 64, height: 64,
                      borderColor: img === selectedImage
                        ? "var(--accent, #b8a0e8)"
                        : "transparent",
                      opacity: img === selectedImage ? 1 : 0.6,
                    }}
                  >
                    <img
                      src={`/api/sessions/${sessionId}/files?path=${img}`}
                      alt=""
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  </button>
                ))}
                {images.length === 0 && (
                  <span className="text-white/30 text-xs py-4 px-2">No images in session</span>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3 px-5 py-3 border-t border-white/[0.06]">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-sm text-white/60 hover:text-white/90 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                disabled={!imageLoaded || submitting}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40"
                style={{
                  backgroundColor: "var(--accent, #b8a0e8)",
                  color: "#000",
                }}
              >
                {submitting ? "Processing..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}
```

**Step 2: Commit**

```bash
git add src/components/ProfileCropModal.tsx
git commit -m "feat: add ProfileCropModal component with canvas crop UI and image picker"
```

---

### Task 7: ChatPage에 ProfileCropModal 연결

**Files:**
- Modify: `src/app/chat/[sessionId]/page.tsx`

**Step 1: state 추가 및 WS 핸들러 등록**

```typescript
// Import 추가
import ProfileCropModal from "@/components/ProfileCropModal";

// State 추가
const [cropModalOpen, setCropModalOpen] = useState(false);
const [cropInitialImage, setCropInitialImage] = useState<string | undefined>();

// WebSocket handlers에 추가:
"profile:crop-request": (p) => {
  const data = p as { sourceImage?: string };
  setCropInitialImage(data.sourceImage);
  setCropModalOpen(true);
},
```

**Step 2: JSX에 모달 렌더링**

SyncModal 바로 아래에 추가:

```tsx
{cropModalOpen && (
  <ProfileCropModal
    sessionId={sessionId}
    initialImage={cropInitialImage}
    onClose={() => setCropModalOpen(false)}
    onComplete={() => {
      // profile:update WS broadcast will handle the image refresh
    }}
  />
)}
```

**Step 3: Commit**

```bash
git add src/app/chat/\[sessionId\]/page.tsx
git commit -m "feat: integrate ProfileCropModal with crop-request WS handler"
```

---

### Task 8: 통합 테스트 및 디버깅

**Step 1: dev 서버 시작**

```bash
npm run dev
```

**Step 2: 수동 테스트 시나리오**

1. 세션 열기 → 이미지가 있는 세션 진입
2. AI에게 프로필 업데이트 요청 → MCP `update_profile` 호출됨 → 크롭 모달 오픈 확인
3. 크롭 박스 드래그 이동 → 바운더리 클램핑 동작 확인
4. 줌 슬라이더 → 크롭 박스 크기 변경 확인
5. 하단 썸네일에서 다른 이미지 선택 → 이미지 전환 확인
6. 확인 클릭 → API 호출 → 프로필 이미지 업데이트 확인
7. ESC 또는 취소 → 모달 닫힘 확인

**Step 3: Edge cases 확인**
- 이미지가 없는 세션에서 모달 열기
- 가로 이미지 vs 세로 이미지
- 줌 최소(50%)에서 드래그 범위

**Step 4: 최종 commit**

```bash
git add -A
git commit -m "fix: address integration issues from testing"
```

---

### Task Summary

| Task | Description | Dependencies |
|------|-------------|-------------|
| 1 | sharp 설치 | - |
| 2 | 이미지 목록 API | - |
| 3 | 크롭 완료 API | Task 1 |
| 4 | update-profile API 수정 | Task 1 |
| 5 | MCP 도구 수정 | Task 4 |
| 6 | ProfileCropModal 컴포넌트 | Task 2, 3 |
| 7 | ChatPage 연결 | Task 4, 6 |
| 8 | 통합 테스트 | All |

Tasks 1, 2는 독립적으로 병렬 실행 가능. Tasks 3, 4도 Task 1 완료 후 병렬 가능.
