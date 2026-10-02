# MiniMax Music 3로 BGM 생성 — ComfyUI /prompt 직접 호출(공식 템플릿 audio_minimax_music_3 그래프와 동일, int8 저VRAM 구성).
# 사용: python scripts/music3.py "<캡션>" <seed> <초> <이름> [저장 경로(.mp3)] [가사]   (세션 루트 cwd)
#   캡션은 세 단락 형식이 가장 잘 먹힌다: "Global Metadata: 장르. BPM, 조성. 분위기…\n\nVocal Details: …(연주곡이면 'Instrumental only, no vocals.')\n\nArrangement: 악기·구성…"
#   가사는 [Intro]/[Verse]/[Chorus]/[Instrumental]/[Outro] 섹션 태그만 실행 지시다. 연주곡이면 기본값 "[Instrumental]".
#   GPU 매니저 큐를 거치지 않으므로 GPU가 비었을 때만 돌린다. 결과는 ComfyUI output/audio/<이름>_*.mp3, 저장 경로를 주면 그리로 복사.
import json, sys, time, urllib.parse, urllib.request, shutil, os
cap, seed, secs, name = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
dest = sys.argv[5] if len(sys.argv) > 5 else ''
lyrics = sys.argv[6] if len(sys.argv) > 6 else '[Instrumental]'
API = 'http://127.0.0.1:8188'
wf = {
 "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": "minimax_music3_text_encoder_pruned_int8_convrot.safetensors", "type": "minimax", "device": "default"}},
 "6": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_music3_dit_int8_convrot.safetensors", "weight_dtype": "default"}},
 "7": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_music3_dav.safetensors"}},
 "13": {"class_type": "MiniMaxMusic3TextEncode", "inputs": {"clip": ["3", 0], "caption": cap, "lyrics": lyrics, "seed": seed, "max_duration": secs, "cfg_scale": 1.7, "top_k": 50}},
 "10": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["13", 0]}},
 "15": {"class_type": "EmptyMiniMaxMusic3LatentAudio", "inputs": {"seconds": ["13", 1], "batch_size": 1}},
 "9": {"class_type": "KSampler", "inputs": {"model": ["6", 0], "positive": ["13", 0], "negative": ["10", 0], "latent_image": ["15", 0], "seed": seed, "steps": 30, "cfg": 1.7, "sampler_name": "euler", "scheduler": "simple", "denoise": 1}},
 "12": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["9", 0], "vae": ["7", 0]}},
 "35": {"class_type": "SaveAudioMP3", "inputs": {"audio": ["12", 0], "filename_prefix": f"audio/{name}", "quality": "320k"}},
}
req = urllib.request.Request(f"{API}/prompt", data=json.dumps({"prompt": wf}).encode(), headers={"Content-Type": "application/json"})
pid = json.load(urllib.request.urlopen(req))["prompt_id"]; t0 = time.time()
while True:
    time.sleep(3)
    h = json.load(urllib.request.urlopen(f"{API}/history/{pid}"))
    if pid in h:
        st = h[pid]["status"]
        if st.get("status_str") == "error": print(json.dumps({"ok": False, "error": str(st.get("messages"))[-900:]})); sys.exit(1)
        if st.get("completed"):
            outs = [a for o in h[pid]["outputs"].values() for a in o.get("audio", [])]; saved = ""
            if dest and outs:
                a = outs[0]; q = urllib.parse.urlencode({"filename": a["filename"], "subfolder": a.get("subfolder", ""), "type": a.get("type", "output")})
                os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
                with urllib.request.urlopen(f"{API}/view?{q}") as r, open(dest, "wb") as f: shutil.copyfileobj(r, f)
                saved = dest
            print(json.dumps({"ok": True, "sec": round(time.time() - t0), "files": outs, "saved": saved}, ensure_ascii=False)); break
    if time.time() - t0 > 1800: print(json.dumps({"ok": False, "error": "timeout"})); sys.exit(1)
