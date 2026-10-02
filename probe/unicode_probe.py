"""Throwaway probe: which native library in the speech chain opens a
non-ASCII path on Windows, and which way of handing it the path works.

Run as `python unicode_probe.py all` with PROBE_ROOT set to a non-ASCII
directory holding models/ (kokoro-82m and faster-whisper-base-en). Each
check runs in its own subprocess, because espeak-ng calls exit(1) when it
cannot find its data and a loaded DLL keeps its global state.
"""

from __future__ import annotations

import ctypes
import locale
import os
import shutil
import site
import subprocess
import sys
from pathlib import Path

if os.environ.get("PROBE_SITE"):
    site.addsitedir(os.environ["PROBE_SITE"])

ROOT = Path(os.environ["PROBE_ROOT"])
MODELS = ROOT / "models"
ESPEAK_DATA = ROOT / "espeak-ng-data"


def out(msg: object) -> None:
    print(str(msg).encode("ascii", "backslashreplace").decode("ascii"), flush=True)


def short_path(path: Path) -> str:
    get = ctypes.windll.kernel32.GetShortPathNameW
    get.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint]
    get.restype = ctypes.c_uint
    buf = ctypes.create_unicode_buffer(1024)
    n = get(str(path), buf, 1024)
    if n == 0:
        raise OSError(ctypes.GetLastError(), "GetShortPathNameW failed")
    return buf.value


CHECKS = {}


def check(fn):
    CHECKS[fn.__name__] = fn
    return fn


@check
def info():
    out(f"python {sys.version}")
    out(f"executable {sys.executable}")
    out(f"locale.getencoding() {locale.getencoding()}")
    out(f"LC_CTYPE {locale.setlocale(locale.LC_CTYPE)}")
    k32 = ctypes.windll.kernel32
    out(f"GetACP {k32.GetACP()} GetOEMCP {k32.GetOEMCP()}")
    out(f"stdout encoding {sys.stdout.encoding}")
    out(f"root {ROOT}")
    try:
        out(f"short root {short_path(ROOT)}")
    except OSError as exc:
        out(f"short root failed: {exc}")
    try:
        out(f"short espeak data {short_path(ESPEAK_DATA)}")
    except OSError as exc:
        out(f"short espeak data failed: {exc}")


def _espeak_raw(data_path: bytes) -> None:
    import espeakng_loader

    lib = ctypes.cdll.LoadLibrary(espeakng_loader.get_library_path())
    out(f"data path bytes {data_path!r}")
    rate = lib.espeak_Initialize(0x02, 0, data_path, 0x8000)  # espeakINITIALIZE_DONT_EXIT
    out(f"espeak_Initialize -> {rate}")
    info_fn = lib.espeak_Info
    info_fn.restype = ctypes.c_char_p
    home = ctypes.c_char_p()
    version = info_fn(ctypes.byref(home))
    out(f"version {version!r} path_home {home.value!r}")

    class Voice(ctypes.Structure):
        _fields_ = [
            ("name", ctypes.c_char_p),
            ("languages", ctypes.c_char_p),
            ("identifier", ctypes.c_char_p),
            ("gender", ctypes.c_ubyte),
            ("age", ctypes.c_ubyte),
            ("variant", ctypes.c_ubyte),
            ("xx1", ctypes.c_ubyte),
            ("score", ctypes.c_int),
            ("spare", ctypes.c_void_p),
        ]

    lv = lib.espeak_ListVoices
    lv.argtypes = [ctypes.POINTER(Voice)]
    lv.restype = ctypes.POINTER(ctypes.POINTER(Voice))
    voices = lv(None)
    count = 0
    while voices[count]:
        count += 1
    out(f"espeak_ListVoices -> {count} voices")
    sv = lib.espeak_SetVoiceByName
    sv.argtypes = [ctypes.c_char_p]
    out(f"espeak_SetVoiceByName(gmw/en-US) -> {sv(b'gmw/en-US')}")
    tp = lib.espeak_TextToPhonemes
    tp.restype = ctypes.c_char_p
    tp.argtypes = [ctypes.POINTER(ctypes.c_char_p), ctypes.c_int, ctypes.c_int]
    text = ctypes.c_char_p(b"hello world")
    out(f"phonemes {tp(ctypes.pointer(text), 1, 0x02 | (ord('_') << 8))!r}")


@check
def espeak_raw_utf8():
    _espeak_raw(str(ESPEAK_DATA).encode("utf-8"))


@check
def espeak_raw_acp():
    _espeak_raw(str(ESPEAK_DATA).encode("mbcs", "replace"))


@check
def espeak_raw_short():
    _espeak_raw(short_path(ESPEAK_DATA).encode("utf-8"))


@check
def espeak_raw_utf8_crt_locale():
    out(f"setlocale -> {locale.setlocale(locale.LC_CTYPE, '.UTF-8')}")
    _espeak_raw(str(ESPEAK_DATA).encode("utf-8"))


def _kokoro_tokenizer(data_path: str) -> None:
    from kokoro_onnx.config import EspeakConfig
    from kokoro_onnx.tokenizer import Tokenizer

    out(f"data_path given {data_path}")
    out(f"resolved {Path(data_path).resolve()}")
    tok = Tokenizer(EspeakConfig(data_path=data_path))
    out(f"phonemes {tok.phonemize('Hello world, this is a test.', 'en-us')!r}")


@check
def phonemizer_long():
    _kokoro_tokenizer(str(ESPEAK_DATA))


@check
def phonemizer_short():
    _kokoro_tokenizer(short_path(ESPEAK_DATA))


@check
def phonemizer_short_unresolved():
    """phonemizer with its resolve() of the data path taken out of the way."""
    import pathlib

    from phonemizer.backend.espeak.wrapper import EspeakWrapper

    original = EspeakWrapper.data_path.fget

    def unresolved(self):
        if self._ESPEAK_DATA_PATH:
            self._data_path = pathlib.Path(self._ESPEAK_DATA_PATH)
            return self._data_path
        return original(self)

    EspeakWrapper.data_path = property(unresolved)
    _kokoro_tokenizer(short_path(ESPEAK_DATA))


@check
def phonemizer_long_crt_locale():
    out(f"setlocale -> {locale.setlocale(locale.LC_CTYPE, '.UTF-8')}")
    _kokoro_tokenizer(str(ESPEAK_DATA))


@check
def phonemizer_venv_data():
    import espeakng_loader

    _kokoro_tokenizer(espeakng_loader.get_data_path())


@check
def onnx_session():
    import onnxruntime as ort

    path = MODELS / "tts" / "kokoro-v1.0.onnx"
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    out(f"onnxruntime {ort.__version__} inputs {[i.name for i in sess.get_inputs()]}")


@check
def ct2_whisper():
    import ctranslate2

    path = MODELS / "asr" / "faster-whisper-base.en"
    model = ctranslate2.models.Whisper(str(path), device="cpu", compute_type="int8")
    out(f"ctranslate2 {ctranslate2.__version__} loaded, multilingual={model.is_multilingual}")


@check
def faster_whisper_model():
    import numpy as np
    from faster_whisper import WhisperModel

    path = MODELS / "asr" / "faster-whisper-base.en"
    model = WhisperModel(str(path), device="cpu", compute_type="int8")
    segments, _ = model.transcribe(np.zeros(16000, dtype=np.float32), language="en")
    out(f"faster-whisper transcribed {len(list(segments))} segment(s)")


@check
def kokoro_full_venv_espeak():
    import soundfile as sf
    from kokoro_onnx import Kokoro

    kokoro = Kokoro(
        str(MODELS / "tts" / "kokoro-v1.0.onnx"), str(MODELS / "tts" / "voices-v1.0.bin")
    )
    samples, rate = kokoro.create("Hello there.", voice="af_sarah", lang="en-us")
    target = ROOT / "probe out.wav"
    sf.write(str(target), samples, rate)
    out(f"kokoro wrote {len(samples)} samples to {target} ({target.stat().st_size} bytes)")


@check
def soundfile_roundtrip():
    import numpy as np
    import soundfile as sf

    target = ROOT / "sf roundtrip.wav"
    sf.write(str(target), np.zeros(2400, dtype=np.float32), 24000)
    data, rate = sf.read(str(target))
    out(f"soundfile ok {len(data)} @ {rate}")


@check
def tokenizers_from_file():
    import tokenizers

    path = MODELS / "asr" / "faster-whisper-base.en" / "tokenizer.json"
    tok = tokenizers.Tokenizer.from_file(str(path))
    out(f"tokenizers ok vocab {tok.get_vocab_size()}")


def run_all(names=None) -> int:
    import espeakng_loader

    if not ESPEAK_DATA.exists():
        ESPEAK_DATA.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(espeakng_loader.get_data_path(), ESPEAK_DATA)
    for name in names or CHECKS:
        out(f"===== {name}")
        proc = subprocess.run(
            [sys.executable, __file__, name], capture_output=True, timeout=600, check=False
        )
        for stream in (proc.stdout, proc.stderr):
            for line in stream.decode("utf-8", "replace").splitlines()[-25:]:
                out(f"  | {line}")
        out(f"  exit {proc.returncode}")
    return 0


if __name__ == "__main__":
    which = sys.argv[1]
    if which == "all":
        sys.exit(run_all())
    if which == "some":
        sys.exit(run_all(sys.argv[2:]))
    CHECKS[which]()
