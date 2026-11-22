"""ccdesk ses işçisi (OmniVoice sağlayıcısı, src/main/tts/omnivoice.js): OmniVoice ile ses klonlama ve seslendirme (ai-test/omnivoice/app.py'den taşındı).

Electron ana süreci bunu ayrı bir süreç olarak başlatır; satır satır JSON konuşurlar:
  stdin  ← {"id": 1, "cmd": "speak", ...}
  stdout → {"id": 1, "ok": true, ...}   ya da   {"id": 1, "ok": false, "error": "...", "fatal": false}
           {"event": "status", ...}     (model yükleniyor / hazır)
stdout yalnızca bu protokole ayrılmıştır; kütüphanelerin yazdıkları stderr'e gider.

Sağlamlık (eski stüdyo GPU belleği dolunca bozuk kalıp her isteği düşürüyordu):
  - bir CUDA hatasından sonra süreç kendini kapatır (fatal); ana süreç gerekince temiz bir tane başlatır
  - metin ana süreçte kısa parçalara bölünür: tek seferde uzun üretim yok
  - model yüklenirken GPU belleği yetmezse CPU'da açılır (yavaş ama çalışır)
  - Whisper yalnızca ses eklerken, CPU'da yüklenir ve iş bitince bırakılır
  - her model çağrısı torch.inference_mode() içinde (eski stüdyo ses eklerken bunu yapmadığı için GPU'yu dolduruyordu)
  - dosyalar önce geçici adla yazılır, sonra yeniden adlandırılır: yarım dosya kalmaz
"""

from __future__ import annotations

import gc
import json
import os
import subprocess
import sys
import time
import traceback

PROTO = sys.stdout
sys.stdout = sys.stderr  # print() eden kütüphaneler protokolü bozmasın


def send(obj: dict) -> None:
    PROTO.write(json.dumps(obj, ensure_ascii=False) + "\n")
    PROTO.flush()


def log(*a) -> None:
    print("[tts]", *a, file=sys.stderr, flush=True)


import soundfile as sf  # noqa: E402
import torch  # noqa: E402
from omnivoice import OmniVoice  # noqa: E402
from omnivoice.models.omnivoice import VoiceClonePrompt  # noqa: E402

MODEL_ID = "k2-fsa/OmniVoice"
_model: OmniVoice | None = None
_device: str | None = None
_prompts: dict[str, tuple[float, VoiceClonePrompt]] = {}  # voice dir -> (prompt.pt mtime, prompt)


class Fatal(Exception):
    """The process can't be trusted any more (CUDA state); the main process starts a new one."""


def is_cuda_error(e: BaseException) -> bool:
    if isinstance(e, torch.cuda.OutOfMemoryError):
        return True
    s = str(e)
    return "CUDA" in s or "cuDNN" in s or "CUBLAS" in s or "device-side assert" in s


def load(prefer: str = "auto") -> OmniVoice:
    global _model, _device
    if _model is not None:
        return _model
    want_gpu = prefer != "cpu" and torch.cuda.is_available()
    if want_gpu:
        free, total = torch.cuda.mem_get_info()
        log(f"GPU boş bellek: {free / 2**30:.1f} / {total / 2**30:.1f} GB")
        if free < 2.2 * 2**30:  # model ~1.6 GB + üretim payı
            send({"event": "status", "state": "loading", "device": "cpu",
                  "note": f"GPU'da yer yok ({free / 2**30:.1f} GB boş; ComfyUI/Ollama açık olabilir): CPU'da açılıyor, yavaş olur"})
            want_gpu = False
    device = "cuda:0" if want_gpu else "cpu"
    send({"event": "status", "state": "loading", "device": device})
    t0 = time.time()
    try:
        _model = OmniVoice.from_pretrained(MODEL_ID, device_map=device,
                                           dtype=torch.float16 if want_gpu else torch.float32)
    except Exception as e:
        if want_gpu and is_cuda_error(e):
            log("GPU'da açılamadı, CPU deneniyor:", e)
            _model = None
            gc.collect()
            torch.cuda.empty_cache()
            send({"event": "status", "state": "loading", "device": "cpu", "note": "GPU belleği yetmedi: CPU'da açılıyor, yavaş olur"})
            device = "cpu"
            _model = OmniVoice.from_pretrained(MODEL_ID, device_map="cpu", dtype=torch.float32)
        else:
            raise
    _device = device
    log(f"model {device} üzerinde {time.time() - t0:.1f} sn'de açıldı")
    send({"event": "status", "state": "ready", "device": device})
    return _model


def prompt_for(voice_dir: str) -> VoiceClonePrompt:
    f = os.path.join(voice_dir, "prompt.pt")
    if not os.path.exists(f):
        raise ValueError(f"Ses bulunamadı: {voice_dir}")
    mt = os.path.getmtime(f)
    hit = _prompts.get(voice_dir)
    if hit and hit[0] == mt:
        return hit[1]
    p = VoiceClonePrompt.load(f)
    _prompts[voice_dir] = (mt, p)
    return p


def write_wav(path: str, audio, sr: int) -> None:
    tmp = f"{path}.{os.getpid()}.tmp.wav"
    sf.write(tmp, audio, sr, subtype="PCM_16")
    os.replace(tmp, path)


def cmd_speak(r: dict) -> dict:
    text = (r.get("text") or "").strip()
    if not text:
        raise ValueError("Boş metin")
    m = load(r.get("device", "auto"))
    prompt = prompt_for(r["voice"])
    t0 = time.time()
    with torch.inference_mode():
        audio = m.generate(text=text, language=r.get("language", "tr"), voice_clone_prompt=prompt,
                           speed=float(r.get("speed", 1.0)), num_step=int(r.get("steps", 24)))[0]
    write_wav(r["out"], audio, m.sampling_rate)
    secs = len(audio) / m.sampling_rate
    return {"seconds": round(secs, 3), "took": round(time.time() - t0, 3), "device": _device}


def cmd_add_voice(r: dict) -> dict:
    src, d = r["audio"], r["dir"]
    os.makedirs(d, exist_ok=True)
    ref = os.path.join(d, "ref.wav")
    # her biçimi (webm, m4a, mp3, uzunluğu yazılmamış flac…) temiz mono 24 kHz WAV'a çevir
    p = subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", src, "-ac", "1", "-ar", "24000", ref + ".tmp.wav"],
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise ValueError(f"Ses dosyası okunamadı: {p.stderr.strip()[:200]}")
    os.replace(ref + ".tmp.wav", ref)
    info = sf.info(ref)
    if info.duration < 3:
        raise ValueError("Kayıt çok kısa: en az 3 saniye, ideali 5–15 saniye.")
    m = load(r.get("device", "auto"))
    text = (r.get("refText") or "").strip() or None
    try:
        if text is None:
            send({"event": "status", "state": "busy", "note": "Kayıt yazıya dökülüyor (Whisper, CPU)…"})
            m.load_asr_model(device="cpu")  # GPU'ya OmniVoice ile birlikte sığmıyor
        # inference_mode: without it the audio encoder keeps every activation for gradients and a 25 s
        # recording fills the 8 GB GPU (what broke the old studio)
        with torch.inference_mode():
            prompt = m.create_voice_clone_prompt(ref, ref_text=text)
    finally:
        if getattr(m, "_asr_pipe", None) is not None:
            m._asr_pipe = None  # Whisper'ı bırak: bellekte ~1.5 GB
            gc.collect()
    tmp = os.path.join(d, "prompt.pt.tmp")
    prompt.save(tmp)
    os.replace(tmp, os.path.join(d, "prompt.pt"))
    meta = {"name": r["name"], "ref_text": prompt.ref_text, "seconds": info.duration,
            "created": time.strftime("%Y-%m-%d %H:%M")}
    with open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    send({"event": "status", "state": "ready", "device": _device})
    return {"meta": meta}


CMDS = {
    "ping": lambda r: {"device": _device, "loaded": _model is not None},
    "load": lambda r: (load(r.get("device", "auto")), {"device": _device})[1],
    "speak": cmd_speak,
    "addVoice": cmd_add_voice,
}


def main() -> None:
    send({"event": "hello", "pid": os.getpid(), "cuda": torch.cuda.is_available()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        rid = r.get("id")
        try:
            fn = CMDS.get(r.get("cmd"))
            if not fn:
                raise ValueError(f"Bilinmeyen komut: {r.get('cmd')}")
            send({"id": rid, "ok": True, **fn(r)})
        except Exception as e:  # noqa: BLE001
            fatal = is_cuda_error(e)
            log(traceback.format_exc())
            msg = str(e).strip().splitlines()[0][:300] if str(e).strip() else type(e).__name__
            if isinstance(e, torch.cuda.OutOfMemoryError):
                msg = "GPU belleği yetmedi (ComfyUI/Ollama açıksa kapatın)"
            send({"id": rid, "ok": False, "error": msg, "fatal": fatal})
            if fatal:
                sys.exit(3)  # bozuk CUDA durumuyla devam etme


if __name__ == "__main__":
    main()
