"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";

const PORTRAIT_RATIO = 832 / 1216; // width / height ≈ 0.684

interface ProfileCropModalProps {
  sessionId: string;
  initialImage?: string;
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
  const [zoom, setZoom] = useState(1.0);
  const [cropOffset, setCropOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const dragOffsetStartRef = useRef({ x: 0, y: 0 });
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
        if (!initialImage && data.images?.length > 0) {
          setSelectedImage(data.images[data.images.length - 1]);
        }
      });
  }, [sessionId, initialImage]);

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
    if (!canvas || !img || canvas.width === 0 || canvas.height === 0) return null;

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
    let cropW = dispW;
    let cropH = cropW / PORTRAIT_RATIO;
    if (cropH > dispH) {
      cropH = dispH;
      cropW = cropH * PORTRAIT_RATIO;
    }
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
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !imageLoaded) return;

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
    ctx.fillRect(imgX, imgY, dispW, cropY - imgY);
    ctx.fillRect(imgX, cropY + cropH, dispW, imgY + dispH - cropY - cropH);
    ctx.fillRect(imgX, cropY, cropX - imgX, cropH);
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

  // Redraw on state changes
  useEffect(() => { draw(); }, [draw]);

  // Resize canvas to fill container
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resizeCanvas = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        canvas.width = rect.width;
        canvas.height = rect.height;
        draw();
      }
    };

    const ro = new ResizeObserver(resizeCanvas);
    ro.observe(container);
    // Initial size
    requestAnimationFrame(resizeCanvas);
    return () => ro.disconnect();
  }, [draw]);

  // Pointer handlers for drag
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const layout = getLayout();
    if (!layout) return;
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (
      mx >= layout.cropX && mx <= layout.cropX + layout.cropW &&
      my >= layout.cropY && my <= layout.cropY + layout.cropH
    ) {
      setDragging(true);
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      dragOffsetStartRef.current = { ...cropOffset };
      canvas.setPointerCapture(e.pointerId);
    }
  }, [getLayout, cropOffset]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setCropOffset({
      x: dragOffsetStartRef.current.x + dx,
      y: dragOffsetStartRef.current.y + dy,
    });
  }, [dragging]);

  const handlePointerUp = useCallback(() => {
    setDragging(false);
  }, []);

  // Submit crop
  const handleConfirm = useCallback(async () => {
    const layout = getLayout();
    if (!layout) return;

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
              <span
                className="text-[12px] font-semibold uppercase tracking-wider"
                style={{ color: "var(--accent, #b8a0e8)", opacity: 0.8 }}
              >
                Profile Crop
              </span>
              <button
                onClick={onClose}
                className="text-white/40 hover:text-white/80 transition-colors p-1"
                aria-label="Close"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="4" y1="4" x2="12" y2="12" />
                  <line x1="12" y1="4" x2="4" y2="12" />
                </svg>
              </button>
            </div>

            {/* Canvas area */}
            <div ref={containerRef} className="relative flex-1 min-h-0" style={{ height: "50vh" }}>
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full"
                style={{ cursor: dragging ? "grabbing" : "grab" }}
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
              <span className="text-white/40 text-xs whitespace-nowrap">Zoom</span>
              <input
                type="range"
                min="0.3"
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
              <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: "thin" }}>
                {images.map((img) => (
                  <button
                    key={img}
                    onClick={() => setSelectedImage(img)}
                    className="flex-shrink-0 rounded-lg overflow-hidden border-2 transition-all hover:opacity-90"
                    style={{
                      width: 64,
                      height: 64,
                      borderColor: img === selectedImage ? "var(--accent, #b8a0e8)" : "transparent",
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
